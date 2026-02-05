/** ============================
 * TICO-bot Lite (Baileys)
 * index.js — La Vaca CR - Ropa y Accesorios
 *
 * FLUJO:
 * 1. Cliente saluda → Bot envía link catálogo
 * 2. Cliente da "Me interesa" desde web → Llega producto+precio+código
 * 3. Bot pregunta talla/color
 * 4. Cliente responde → Bot: "Dame un toque"
 * 5. Dueño confirma stock → Pregunta zona → Envío → SINPE → Venta
 *
 * ANTI-BANEO:
 * ✅ Delay humano (15-60 segundos)
 * ✅ Cola de mensajes (uno a la vez)
 * ✅ Typing indicator
 * ✅ Horario 9am - 6:50pm
 * ✅ Variedad de frases
 * ✅ IA para preguntas fuera del flujo
 * 
 * ============================ */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const pino = require("pino");

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const logger = pino({ level: "silent" });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

/**
 ============================
 CONFIGURACIÓN
 ============================
 */
const PORT = process.env.PORT || 3000;
const PANEL_PIN = process.env.PANEL_PIN || "1234";
const STORE_NAME = process.env.STORE_NAME || "La Vaca CR";

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Horario (Costa Rica UTC-6)
const HOURS_START = 9;
const HOURS_END_HOUR = 18;
const HOURS_END_MIN = 50;
const HOURS_DAY = "9am - 6:50pm";

// Delays humanos (segundos)
const DELAY_MIN = 15;
const DELAY_MAX = 60;

// Tienda
const STORE_TYPE = (process.env.STORE_TYPE || "fisica_con_envios").toLowerCase();
const STORE_ADDRESS = process.env.STORE_ADDRESS || "";
const MAPS_URL = process.env.MAPS_URL || "";

// SINPE
const SINPE_NUMBER = process.env.SINPE_NUMBER || "";
const SINPE_NAME = process.env.SINPE_NAME || "";

// Envíos
const SHIPPING_GAM = process.env.SHIPPING_GAM || "₡2,500";
const SHIPPING_RURAL = process.env.SHIPPING_RURAL || "₡3,500";
const DELIVERY_DAYS = process.env.DELIVERY_DAYS || "8 días hábiles";
const WARRANTY_DAYS = process.env.WARRANTY_DAYS || "30 días contra defectos de fábrica";

// Catálogo
const CATALOG_URL = process.env.CATALOG_URL || "https://www.lavacacr.com";

// Persistencia
const AUTH_FOLDER = path.join(process.cwd(), "auth_baileys");
const DATA_FOLDER = process.cwd();

/**
 ============================
 ESTADO GLOBAL
 ============================
 */
let sock = null;
let qrCode = null;
let connectionStatus = "disconnected";
let connectedPhone = "";
let botPaused = false;

// Cola de mensajes
const messageQueue = [];
let isProcessingQueue = false;

const sessions = new Map();
const profiles = new Map();
const pendingQuotes = new Map();
let chatHistory = [];
const MAX_CHAT_HISTORY = 500;

const account = {
  metrics: {
    chats_total: 0,
    quotes_sent: 0,
    intent_yes: 0,
    intent_no: 0,
    delivery_envio: 0,
    delivery_recoger: 0,
    sinpe_confirmed: 0,
    estados_sent: 0,
    mensajes_enviados: 0,
    ia_calls: 0,
  },
};

/**
 ============================
 HELPERS
 ============================
 */
function hasPhysicalLocation() { return STORE_TYPE === "fisica_con_envios" || STORE_TYPE === "fisica_solo_recoger"; }
function offersShipping() { return STORE_TYPE === "virtual" || STORE_TYPE === "fisica_con_envios"; }
function offersPickup() { return STORE_TYPE === "fisica_con_envios" || STORE_TYPE === "fisica_solo_recoger"; }

function normalizePhone(input) {
  const d = String(input || "").replace(/[^\d]/g, "").replace(/@.*/, "");
  if (d.length === 8) return "506" + d;
  if (d.startsWith("506") && d.length === 11) return d;
  return d;
}

function toJid(phone) { return normalizePhone(phone) + "@s.whatsapp.net"; }
function fromJid(jid) { return jid ? jid.replace(/@.*/, "") : ""; }

function formatPhone(waId) {
  const d = normalizePhone(waId);
  if (d.length === 11 && d.startsWith("506")) return `${d.slice(0, 3)} ${d.slice(3, 7)}-${d.slice(7)}`;
  return waId;
}

function getCostaRicaTime() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const cr = new Date(utc - (6 * 60 * 60 * 1000));
  return { hour: cr.getHours(), minute: cr.getMinutes() };
}

function isStoreOpen() {
  const { hour, minute } = getCostaRicaTime();
  if (hour < HOURS_START) return false;
  if (hour > HOURS_END_HOUR) return false;
  if (hour === HOURS_END_HOUR && minute >= HOURS_END_MIN) return false;
  return true;
}

function norm(s = "") { return String(s).toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function getHumanDelay() { return (Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN + 1)) + DELAY_MIN) * 1000; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Extraer precio de texto (ej: "₡11 000" → 11000)
function extractPrice(text) {
  const match = String(text).match(/₡?\s*([\d\s,\.]+)/);
  if (match) {
    return parseInt(match[1].replace(/[\s,\.]/g, '')) || 0;
  }
  return 0;
}

/**
 ============================
 INTELIGENCIA ARTIFICIAL (OpenAI)
 ============================
 */
const STORE_CONTEXT = `Sos el asistente virtual de La Vaca CR, una tienda de ropa y accesorios para damas ubicada en Heredia, Costa Rica.

INFORMACIÓN DE LA TIENDA:
- Nombre: La Vaca CR
- Ubicación: Heredia centro, 200 metros sur de Correos de Costa Rica
- Horario: Lunes a Sábado 9:00am - 7:00pm, Domingo 10:00am - 6:00pm
- Teléfono tienda: 2237-3335
- WhatsApp: +506 6483-6565
- Catálogo online: www.lavacacr.com

MÉTODOS DE PAGO:
- SINPE Móvil (preferido)
- Efectivo en tienda
- NO aceptamos tarjetas de crédito/débito

ENVÍOS:
- Sí hacemos envíos a todo el país
- GAM (Gran Área Metropolitana): ₡2,500
- Zona rural: ₡3,500
- Tiempo de entrega: 3-5 días hábiles

TALLAS DISPONIBLES:
- S, M, L, XL, XXL
- Talla Plus disponible en algunos estilos

SISTEMA DE APARTADOS:
- Sí hacemos apartados
- Apartás con la cuarta parte (1/4) del precio total
- Tenés 2 meses para completar el pago y retirar
- El apartado se hace en tienda o por SINPE

POLÍTICAS:
- Cambios: 8 días después de la compra, con factura, sin usar
- No hacemos devoluciones de dinero, solo cambios
- Garantía: 30 días contra defectos de fábrica

ESTILO DE RESPUESTA:
- Respondé como tico/costarricense, amigable y cercano
- Usá emojis con moderación (1-2 por mensaje)
- Respuestas cortas y directas (máximo 2-3 oraciones)
- Si no sabés algo, decí que pueden consultar en tienda o por teléfono
- NUNCA inventes información
- Si preguntan por un producto específico, deciles que revisen el catálogo en www.lavacacr.com`;

async function askAI(userMessage, conversationHistory = []) {
  if (!OPENAI_API_KEY) {
    console.log("⚠️ No hay API Key de OpenAI configurada");
    return null;
  }

  try {
    const messages = [
      { role: "system", content: STORE_CONTEXT },
      ...conversationHistory.slice(-4), // Últimos 4 mensajes para contexto
      { role: "user", content: userMessage }
    ];

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: messages,
        max_tokens: 150,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      console.log("❌ Error OpenAI:", response.status);
      return null;
    }

    const data = await response.json();
    const aiResponse = data.choices?.[0]?.message?.content?.trim();
    
    if (aiResponse) {
      console.log("🤖 IA respondió:", aiResponse.slice(0, 50) + "...");
      account.metrics.ia_calls = (account.metrics.ia_calls || 0) + 1;
    }
    
    return aiResponse;
  } catch (error) {
    console.log("❌ Error IA:", error.message);
    return null;
  }
}

/**
 ============================
 PERSISTENCIA
 ============================
 */
function saveDataToDisk() {
  try {
    fs.writeFileSync(path.join(DATA_FOLDER, "ticobot_data.json"), JSON.stringify({
      account, botPaused,
      profiles: Array.from(profiles.values()),
      sessions: Array.from(sessions.values()),
    }, null, 2));
  } catch (e) { console.log("⚠️ Error guardando:", e.message); }
}

function loadDataFromDisk() {
  try {
    const file = path.join(DATA_FOLDER, "ticobot_data.json");
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (data.account) Object.assign(account, data.account);
    if (data.profiles) data.profiles.forEach(p => profiles.set(p.waId, p));
    if (data.sessions) data.sessions.forEach(s => sessions.set(s.waId, s));
    if (data.botPaused !== undefined) botPaused = data.botPaused;
    console.log("📂 Datos cargados");
  } catch (e) { console.log("⚠️ Error cargando:", e.message); }
}

setInterval(saveDataToDisk, 5 * 60 * 1000);

/**
 ============================
 FRASES TICAS (VARIADAS)
 ============================
 */
const FRASES = {
  revisando: [
    "Dame un toque, voy a revisar si lo tenemos disponible 👍",
    "Dejame chequearlo, ya te confirmo 👌",
    "Un momento, voy a fijarme si queda en stock 🙌",
    "Ya te confirmo disponibilidad, dame un ratito 😊",
    "Voy a revisar de una vez 👍",
    "Permíteme un momento, lo verifico 🙌",
    "Dame chance, ya lo busco 😊",
    "Un segundito, reviso si lo tenemos 👌",
    "Ya miro y te cuento 🙌",
    "Dejame ver si queda, ya te digo 👍",
  ],
  saludos: [
    "¡Hola! Pura vida 🙌 ¿En qué te ayudo?",
    "¡Hola! Con gusto te atiendo 😊",
    "¡Buenas! Pura vida 🙌",
    "¡Hola! ¿Cómo estás? 😊",
    "¡Qué tal! Bienvenid@ 🙌",
    "¡Hola! Qué gusto saludarte 👋",
    "¡Buenas! ¿En qué te puedo servir? 😊",
    "¡Hola! Aquí estamos para ayudarte 🙌",
    "¡Pura vida! ¿Qué ocupás? 😊",
    "¡Hola! Bienvenid@ 🐄",
  ],
  catalogo: [
    "Te paso el link con los productos disponibles para venta en línea. Si te gusta algo, le das click al botón 'Me interesa' 🙌",
    "Aquí te dejo el catálogo con lo disponible. Si ves algo que te guste, dale al botón 'Me interesa' 😊",
    "Te comparto el link de nuestros productos. Si algo te llama la atención, tocá 'Me interesa' 🙌",
  ],
  pedir_talla: [
    "¿Qué talla, tamaño o color lo necesitás? 👕",
    "¿En qué talla y color lo ocupás? 😊",
    "¿Qué talla/color te gustaría? 👗",
    "¿Me decís la talla y el color que buscás? 🙌",
  ],
  si_hay: [
    "¡Sí lo tenemos disponible! 🎉",
    "¡Qué dicha, sí hay! 🙌",
    "¡Perfecto, lo tenemos! 😊",
    "¡Sí está disponible! 🎉",
    "¡Claro que sí, hay en stock! 🙌",
  ],
  confirmacion: [
    "¡Buenísimo! 🙌", "¡Perfecto! 🎉", "¡Excelente! 👍", "¡Genial! 🙌",
    "¡Dale! 😊", "¡Qué bien! 🎉", "¡Tuanis! 🙌", "¡Listo! 👍",
  ],
  no_quiere: [
    "Con gusto 🙌 Si ves algo más en el catálogo, me avisás.",
    "Está bien 🙌 Cualquier cosa aquí estamos.",
    "No hay problema 👍 Si ocupás algo, me escribís.",
    "Dale 🙌 Si te interesa otra cosa, con gusto.",
    "Perfecto 🙌 Aquí estamos para cuando gustés.",
  ],
  no_hay: [
    "No tenemos ese disponible en este momento 😔 ¿Querés ver otra opción en el catálogo?",
    "Uy, ese no nos queda 🙌 Pero hay más opciones en el catálogo.",
    "Qué lástima, no lo tenemos 😔 ¿Te interesa ver algo más?",
    "Ese se nos agotó 😔 Revisá el catálogo por si hay algo similar.",
  ],
  pedir_zona: [
    "¿De qué provincia y lugar nos escribís? 📍",
    "¿De qué parte del país sos? 📍",
    "Para calcular el envío, ¿de dónde sos? 📍",
    "¿Me decís de qué zona sos? 📍",
    "¿De dónde te lo enviaríamos? 📍",
  ],
  nocturno: [
    "¡Hola! 🌙 Ya cerramos por hoy. Mañana a las 9am te atiendo con gusto 😊",
    "Pura vida 🌙 Estamos fuera de horario. Te respondo mañana temprano 🙌",
    "¡Buenas noches! 🌙 Nuestro horario es de 9am a 6:50pm. Mañana te ayudo 😊",
    "Hola 🌙 Ya cerramos. Dejame tu consulta y mañana te confirmo 🙌",
  ],
  gracias: [
    "¡Gracias a vos! 🙌", "¡Con mucho gusto! 😊", "¡Pura vida! 🙌",
    "¡Gracias por la confianza! 💪", "¡Tuanis! 🙌", "¡Para servirte! 😊",
  ],
  espera_zona: [
    "¡Anotado! 📝 Dame un momento para calcular el envío 🙌",
    "Perfecto 📝 Ya reviso cuánto sale a tu zona 😊",
    "Listo 📝 Dejame calcular el envío 🙌",
  ],
  espera_vendedor: [
    "Ya estoy revisando, un momento 🙌",
    "Dame chance, estoy verificando 😊",
    "Un momento, ya te confirmo 🙌",
  ],
  // ✅ NUEVO: Saludo cuando llega interés desde la web
  saludo_interes: [
    "¡Hola! Pura vida 🙌 Qué buena elección. Dejame revisar si lo tenemos disponible, ya te confirmo 😊",
    "¡Hola! 🙌 Vi que te interesa este producto. Voy a verificar disponibilidad, un momento 😊",
    "¡Buenas! 🐄 Excelente gusto. Dame un toque para confirmar si lo tenemos 👍",
    "¡Hola! Pura vida 🙌 Ya vi tu consulta. Dejame revisar stock y te confirmo rapidito 😊",
    "¡Qué tal! 🙌 Buena elección. Voy a fijarme si está disponible, ya te aviso 👍",
  ],
};

const lastUsedFrase = new Map();
function frase(tipo, sessionId = "global") {
  const opciones = FRASES[tipo] || [""];
  const key = `${tipo}_${sessionId}`;
  const last = lastUsedFrase.get(key);
  const disponibles = opciones.filter(f => f !== last);
  const elegida = disponibles.length > 0 ? disponibles[Math.floor(Math.random() * disponibles.length)] : opciones[0];
  lastUsedFrase.set(key, elegida);
  return elegida;
}

/**
 ============================
 SESIONES Y PERFILES
 ============================
 */
function getSession(waId) {
  const id = normalizePhone(waId);
  if (!sessions.has(id)) {
    sessions.set(id, { 
      waId: id,
      // ✅ JID completo original para responder (puede ser @lid o @s.whatsapp.net)
      replyJid: null,
      state: "NEW", 
      // Producto (desde web)
      producto: null,
      precio: null,
      codigo: null,
      foto_url: null,
      // Talla/color del cliente
      talla_color: null,
      // Envío
      shipping_cost: null,
      client_zone: null,
      delivery_method: null,
      sinpe_reference: null,
      // Control de mensajes
      saludo_enviado: false,
      catalogo_enviado: false,
      last_activity: Date.now() 
    });
  }
  const s = sessions.get(id);
  s.last_activity = Date.now();
  return s;
}

// ✅ Mapa global: waId normalizado → JID completo original
const jidMap = new Map();

function resetSession(session) {
  session.state = "NEW"; 
  session.producto = null;
  session.precio = null;
  session.codigo = null;
  session.foto_url = null;
  session.talla_color = null;
  session.shipping_cost = null;
  session.client_zone = null;
  session.delivery_method = null;
  session.sinpe_reference = null;
  session.saludo_enviado = false;
  session.catalogo_enviado = false;
  pendingQuotes.delete(session.waId);
}

function getProfile(waId) {
  const id = normalizePhone(waId);
  if (!profiles.has(id)) profiles.set(id, { waId: id, name: "", blocked: false, purchases: 0, created_at: new Date().toISOString() });
  return profiles.get(id);
}

/**
 ============================
 HISTORIAL Y PENDIENTES
 ============================
 */
function addToChatHistory(waId, direction, text, imageUrl = null) {
  const profile = getProfile(waId);
  const entry = { 
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), 
    waId: normalizePhone(waId),
    // ✅ Número real y nombre para mostrar en panel
    phone: profile.phone || normalizePhone(waId),
    name: profile.name || "",
    direction, 
    text, 
    imageUrl,
    timestamp: new Date().toISOString() 
  };
  chatHistory.push(entry);
  if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY);
  io.emit("new_message", entry);
  return entry;
}

function addPendingQuote(session) {
  const profile = getProfile(session.waId);
  const quote = { 
    waId: session.waId,
    // ✅ Datos para el panel: número real + nombre + LID de referencia
    phone: profile.phone || session.waId,  // número real para guardar contacto
    name: profile.name || "",              // nombre de WhatsApp
    lid: profile.lid || null,              // LID para referencia interna
    producto: session.producto,
    precio: session.precio,
    codigo: session.codigo,
    foto_url: session.foto_url,
    talla_color: session.talla_color,
    created_at: new Date().toISOString() 
  };
  pendingQuotes.set(session.waId, quote);
  io.emit("new_pending", quote);
}

/**
 ============================
 DETECTAR MENSAJE DE LA WEB
 ============================
 */
function parseWebMessage(text) {
  // Detectar si viene de la web: "Estoy interesado/a en este producto"
  if (!text.includes("interesado") || !text.includes("producto")) return null;
  
  const result = {
    producto: null,
    precio: null,
    codigo: null,
    foto_url: null,
    talla: null,
    color: null,
    tamano: null,
  };
  
  // Extraer nombre del producto
  const productoMatch = text.match(/^([^\n]+)\nPrecio:/m);
  if (productoMatch) result.producto = productoMatch[1].trim();
  
  // Extraer precio
  const precioMatch = text.match(/Precio:\s*₡?\s*([\d\s,\.]+)/i);
  if (precioMatch) result.precio = parseInt(precioMatch[1].replace(/[\s,\.]/g, '')) || 0;
  
  // Extraer código
  const codigoMatch = text.match(/Código:\s*(\w+)/i);
  if (codigoMatch) result.codigo = codigoMatch[1].trim();
  
  // ✅ FIX: Construir URL de imagen directa desde el código
  if (result.codigo) {
    result.foto_url = `${CATALOG_URL}/img/${result.codigo}.webp`;
  }
  
  // Extraer Talla
  const tallaMatch = text.match(/Talla:\s*(.+)/i);
  if (tallaMatch) result.talla = tallaMatch[1].trim();
  
  // Extraer Color
  const colorMatch = text.match(/Color:\s*(.+)/i);
  if (colorMatch) result.color = colorMatch[1].trim();
  
  // Extraer Tamaño
  const tamanoMatch = text.match(/Tamaño:\s*(.+)/i);
  if (tamanoMatch) result.tamano = tamanoMatch[1].trim();
  
  return result;
}

/**
 ============================
 BAILEYS - CONEXIÓN
 ============================
 */
async function connectWhatsApp() {
  connectionStatus = "connecting";
  io.emit("connection_status", { status: connectionStatus });
  if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    printQRInTerminal: false,
    browser: ["TICObot", "Chrome", "1.0.0"],
    syncFullHistory: false,
    shouldIgnoreJid: (jid) => jid?.endsWith("@g.us") || jid?.endsWith("@broadcast"),
  });

  // Resolver LID → número real de teléfono
  function resolveJid(jid) {
    if (!jid) return jid;
    // Si es un LID (@lid), intentar buscar el número real en el store
    if (jid.endsWith("@lid")) {
      const lid = jid.replace("@lid", "");
      // Buscar en participants del store si hay mapeo
      try {
        const contact = sock.store?.contacts?.[jid];
        if (contact?.id && contact.id.endsWith("@s.whatsapp.net")) {
          return contact.id;
        }
      } catch(e) {}
      // Si no se resolvió, devolver el LID como está
      return jid;
    }
    return jid;
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCode = await QRCode.toDataURL(qr);
      connectionStatus = "qr";
      io.emit("qr_code", { qr: qrCode });
      io.emit("connection_status", { status: connectionStatus });
      console.log("📱 QR listo");
    }
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Desconectado:", reason);
      connectionStatus = "disconnected"; qrCode = null; connectedPhone = "";
      io.emit("connection_status", { status: connectionStatus });
      if (reason !== DisconnectReason.loggedOut) { setTimeout(connectWhatsApp, 3000); }
      else { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); }
    }
    if (connection === "open") {
      connectionStatus = "connected"; qrCode = null;
      connectedPhone = sock.user?.id?.split(":")[0] || "";
      io.emit("connection_status", { status: connectionStatus, phone: connectedPhone });
      console.log("✅ Conectado:", connectedPhone);
    }
  });

  sock.ev.on("creds.update", saveCreds);
  
  // ✅ Escuchar mapeo LID↔PN cuando Baileys lo descubre
  sock.ev.on("lid-mapping.update", (mapping) => {
    console.log("🗺️ LID mapping actualizado:", JSON.stringify(mapping));
  });
  
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe || msg.key.remoteJid?.endsWith("@g.us")) continue;
      // ✅ Debug: mostrar key completo para verificar senderPn
      console.log(`🔍 MSG KEY: ${JSON.stringify(msg.key)} | pushName: ${msg.pushName || "(sin nombre)"}`);
      messageQueue.push(msg);
      processQueue();
    }
  });
}

/**
 ============================
 COLA DE MENSAJES
 ============================
 */
async function processQueue() {
  if (isProcessingQueue || messageQueue.length === 0) return;
  isProcessingQueue = true;
  while (messageQueue.length > 0) {
    const msg = messageQueue.shift();
    try { await handleIncomingMessage(msg); } catch (e) { console.log("❌ Error:", e.message); }
  }
  isProcessingQueue = false;
}

/**
 ============================
 ENVIAR CON TYPING + DELAY
 ============================
 */
async function sendTextWithTyping(waId, text) {
  if (!sock || connectionStatus !== "connected") return false;
  try {
    // ✅ Usar JID original si existe (puede ser @lid), sino construir @s.whatsapp.net
    const jid = jidMap.get(normalizePhone(waId)) || toJid(waId);
    const delay = getHumanDelay();
    console.log(`⏳ Esperando ${Math.round(delay/1000)}s... → ${jid}`);
    
    await sock.sendPresenceUpdate("composing", jid);
    await sleep(delay);
    await sock.sendPresenceUpdate("paused", jid);
    await sock.sendMessage(jid, { text });
    
    addToChatHistory(waId, "out", text);
    account.metrics.mensajes_enviados += 1;
    console.log(`📤 ${formatPhone(waId)}: ${text.slice(0, 50)}...`);
    return true;
  } catch (e) { console.log("❌ Error envío:", e.message); return false; }
}

async function sendTextDirect(waId, text) {
  if (!sock || connectionStatus !== "connected") return false;
  try {
    // ✅ Usar JID original si existe
    const jid = jidMap.get(normalizePhone(waId)) || toJid(waId);
    await sock.sendPresenceUpdate("composing", jid);
    await sleep(2000);
    await sock.sendPresenceUpdate("paused", jid);
    await sock.sendMessage(jid, { text });
    addToChatHistory(waId, "out", text);
    account.metrics.mensajes_enviados += 1;
    return true;
  } catch (e) { return false; }
}

async function sendButtons(waId, text, buttons) {
  let msg = text + "\n\n";
  buttons.forEach((b, i) => { msg += `${i + 1}. ${b.title}\n`; });
  msg += "\nResponde con el número 👆";
  return sendTextWithTyping(waId, msg);
}

/**
 ============================
 ESTADOS
 ============================
 */
async function postStatus(imageBuffer, caption = "") {
  if (!sock || connectionStatus !== "connected") return { success: false, message: "No conectado" };
  try {
    await sock.sendMessage("status@broadcast", { image: imageBuffer, caption });
    account.metrics.estados_sent += 1;
    saveDataToDisk();
    return { success: true, message: "Estado publicado" };
  } catch (e) { return { success: false, message: e.message }; }
}

async function postStatusText(text) {
  if (!sock || connectionStatus !== "connected") return { success: false, message: "No conectado" };
  try {
    await sock.sendMessage("status@broadcast", { text });
    account.metrics.estados_sent += 1;
    saveDataToDisk();
    return { success: true, message: "Estado publicado" };
  } catch (e) { return { success: false, message: e.message }; }
}

/**
 ============================
 HANDLER MENSAJES
 ============================
 */
async function handleIncomingMessage(msg) {
  const remoteJid = msg.key.remoteJid;
  const isLid = remoteJid?.endsWith("@lid");
  
  // ✅ Extraer número real de senderPn (viene cuando remoteJid es @lid)
  const senderPn = msg.key.senderPn || null; // ej: "50670106802@s.whatsapp.net"
  const pushName = msg.pushName || "";       // nombre de WhatsApp del contacto
  
  // ✅ SISTEMA DUAL:
  // - waId = número real (para mostrar en panel, guardar contacto)
  // - replyJid = JID original (puede ser @lid, para enviar mensajes)
  let waId;
  let realPhone = null;
  
  if (isLid && senderPn) {
    // Tenemos LID + número real → usar número real como ID principal
    realPhone = fromJid(senderPn);
    waId = realPhone;
    console.log(`🔗 LID ${fromJid(remoteJid).slice(0,10)}... → Teléfono real: ${formatPhone(realPhone)}`);
  } else if (isLid) {
    // Solo LID sin senderPn → intentar resolver con lidMapping
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(remoteJid);
      if (pn) {
        realPhone = fromJid(pn);
        waId = realPhone;
        console.log(`🔗 LID resuelto via mapping: ${formatPhone(realPhone)}`);
      } else {
        waId = fromJid(remoteJid);
        console.log(`⚠️ LID sin número real: ${waId} (${pushName || "sin nombre"})`);
      }
    } catch(e) {
      waId = fromJid(remoteJid);
    }
  } else {
    // Número normal @s.whatsapp.net
    waId = fromJid(remoteJid);
    realPhone = waId;
  }
  
  // ✅ Guardar mapeo: waId (número real) → remoteJid (para responder)
  jidMap.set(normalizePhone(waId), remoteJid);
  
  const session = getSession(waId);
  session.replyJid = remoteJid;
  if (isLid) session.lid = fromJid(remoteJid);
  
  const profile = getProfile(waId);
  
  // ✅ Auto-guardar nombre y teléfono real en el perfil
  if (pushName && !profile.name) profile.name = pushName;
  if (realPhone) profile.phone = realPhone;
  if (isLid) profile.lid = fromJid(remoteJid);

  let text = "";
  if (msg.message?.conversation) text = msg.message.conversation;
  else if (msg.message?.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
  else if (msg.message?.imageMessage?.caption) text = msg.message.imageMessage.caption;

  // ✅ Log con número real + nombre
  const displayPhone = realPhone ? formatPhone(realPhone) : waId;
  const nameTag = pushName ? ` (${pushName})` : (profile.name ? ` (${profile.name})` : "");
  
  addToChatHistory(waId, "in", text || "(mensaje)");
  console.log(`📥 ${displayPhone}${nameTag}: ${text || "(mensaje)"}`);

  if (profile.blocked) return;
  if (botPaused) { console.log("⏸️ Bot pausado"); return; }

  account.metrics.chats_total += 1;

  // Fuera de horario
  if (!isStoreOpen()) { 
    await sendTextWithTyping(waId, frase("nocturno", waId)); 
    return; 
  }

  // Normalizar respuestas numéricas
  const numResp = text.trim();
  if (numResp === "1") text = "si";
  if (numResp === "2") text = "no";
  const lower = norm(text);

  // ============================================
  // ✅ FIX: DETECTAR MENSAJE DESDE LA WEB ("Me interesa")
  // ============================================
  const webData = parseWebMessage(text);
  if (webData && webData.codigo) {
    // Guardar datos del producto
    session.producto = webData.producto;
    session.precio = webData.precio;
    session.codigo = webData.codigo;
    session.foto_url = webData.foto_url;
    
    // Armar detalles de talla/color/tamaño si vienen
    let detalles = [];
    if (webData.talla) detalles.push(`Talla: ${webData.talla}`);
    if (webData.color) detalles.push(`Color: ${webData.color}`);
    if (webData.tamano) detalles.push(`Tamaño: ${webData.tamano}`);
    
    // ✅ FIX: Armar resumen del producto para el cliente
    let resumenProducto = `📦 *${webData.producto || 'Producto'}*`;
    if (webData.precio) resumenProducto += `\n💰 ₡${webData.precio.toLocaleString()}`;
    if (detalles.length > 0) resumenProducto += `\n👕 ${detalles.join(", ")}`;
    
    // Si ya vienen los detalles, saltar la pregunta
    if (detalles.length > 0) {
      session.talla_color = detalles.join(", ");
      session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
      
      // ✅ FIX: Responder al cliente con saludo + producto + "voy a revisar"
      await sendTextWithTyping(waId, 
        `${frase("saludo_interes", waId)}\n\n${resumenProducto}`
      );
      addPendingQuote(session);
      return;
    }
    
    // Si NO vienen detalles, preguntar talla/color
    session.state = "ESPERANDO_TALLA";
    
    // ✅ FIX: Saludar + confirmar producto + pedir talla
    await sendTextWithTyping(waId, 
      `¡Hola! Pura vida 🙌 Vi que te interesa:\n\n${resumenProducto}\n\n${frase("pedir_talla", waId)}`
    );
    return;
  }

  // ============================================
  // MÁQUINA DE ESTADOS
  // ============================================

  // ESPERANDO_TALLA: Cliente debe decir talla/color
  if (session.state === "ESPERANDO_TALLA") {
    session.talla_color = text.trim();
    session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
    
    await sendTextWithTyping(waId, frase("revisando", waId));
    addPendingQuote(session);
    return;
  }

  // ESPERANDO_CONFIRMACION_VENDEDOR: Dueño debe confirmar
  if (session.state === "ESPERANDO_CONFIRMACION_VENDEDOR") { 
    await sendTextWithTyping(waId, frase("espera_vendedor", waId)); 
    return; 
  }

  // ESPERANDO_ZONA: Cliente da su ubicación
  if (session.state === "ESPERANDO_ZONA") {
    session.client_zone = text.trim();
    session.state = "ZONA_RECIBIDA";
    io.emit("zone_received", { waId, zone: session.client_zone, precio: session.precio });
    await sendTextWithTyping(waId, frase("espera_zona", waId));
    return;
  }

  // ZONA_RECIBIDA: Esperando que dueño dé costo envío
  if (session.state === "ZONA_RECIBIDA") { 
    await sendTextWithTyping(waId, "Estoy calculando el envío, un momento 🙌"); 
    return; 
  }

  // PRECIO_TOTAL_ENVIADO: Cliente decide si compra
  if (session.state === "PRECIO_TOTAL_ENVIADO") {
    if (lower === "si" || lower === "sí" || lower.includes("quiero") || lower === "1") {
      account.metrics.intent_yes += 1;
      if (offersShipping() && offersPickup()) {
        await sendButtons(waId, `${frase("confirmacion", waId)}\n\n¿Cómo lo preferís?`, [{ title: "📦 Envío" }, { title: "🏪 Recoger" }]);
        session.state = "PREGUNTANDO_METODO";
      } else if (offersShipping()) {
        session.delivery_method = "envio"; account.metrics.delivery_envio += 1;
        await sendTextWithTyping(waId, `${frase("confirmacion", waId)}\n\nPasame tus datos:\n📍 Dirección completa\n📞 Teléfono`);
        session.state = "PIDIENDO_DATOS";
      } else {
        session.delivery_method = "recoger"; account.metrics.delivery_recoger += 1;
        await sendTextWithTyping(waId, `${frase("confirmacion", waId)}\n\n📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}\n\nNombre y teléfono:`);
        session.state = "PIDIENDO_DATOS";
      }
      saveDataToDisk(); return;
    }
    if (lower === "no" || lower.includes("gracias") || lower === "2") {
      account.metrics.intent_no += 1;
      await sendTextWithTyping(waId, frase("no_quiere", waId));
      resetSession(session); saveDataToDisk(); return;
    }
    return;
  }

  // PREGUNTANDO_METODO: Envío o recoger
  if (session.state === "PREGUNTANDO_METODO") {
    if (lower.includes("envio") || lower.includes("envío") || lower === "1") {
      session.delivery_method = "envio"; account.metrics.delivery_envio += 1;
      await sendTextWithTyping(waId, `${frase("confirmacion", waId)}\n\nDatos:\n📍 Dirección completa\n📞 Teléfono`);
      session.state = "PIDIENDO_DATOS";
    } else if (lower.includes("recoger") || lower.includes("tienda") || lower === "2") {
      session.delivery_method = "recoger"; account.metrics.delivery_recoger += 1;
      await sendTextWithTyping(waId, `${frase("confirmacion", waId)}\n\n📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}\n\nNombre y teléfono:`);
      session.state = "PIDIENDO_DATOS";
    }
    saveDataToDisk(); return;
  }

  // PIDIENDO_DATOS: Cliente da dirección/teléfono
  if (session.state === "PIDIENDO_DATOS") {
    const price = session.precio || 0;
    const shipping = session.delivery_method === "envio" ? (session.shipping_cost || 0) : 0;
    const total = price + shipping;
    session.sinpe_reference = waId.slice(-4) + Date.now().toString(36).slice(-4).toUpperCase();
    
    await sendTextWithTyping(waId, 
      `${frase("confirmacion", waId)}\n\n` +
      `📦 Producto: ${session.producto || 'Artículo'}\n` +
      `👕 Talla/Color: ${session.talla_color || '-'}\n` +
      `💰 Total: ₡${total.toLocaleString()}\n\n` +
      `SINPE: ${SINPE_NUMBER}\nA nombre de: ${SINPE_NAME}\nRef: ${session.sinpe_reference}\n\n` +
      `Cuando pagues, mandame el comprobante 🧾`
    );
    session.state = "ESPERANDO_SINPE";
    io.emit("sale_pending", { waId, phone: profile.phone || waId, name: profile.name || "", total, reference: session.sinpe_reference, method: session.delivery_method, producto: session.producto, talla: session.talla_color });
    saveDataToDisk(); return;
  }

  // ESPERANDO_SINPE: Cliente debe enviar comprobante
  if (session.state === "ESPERANDO_SINPE") {
    if (msg.message?.imageMessage) {
      await sendTextWithTyping(waId, "¡Recibí tu comprobante! 🙌 Verificando...");
      io.emit("sinpe_received", { waId, reference: session.sinpe_reference });
      return;
    }
    if (lower.includes("pague") || lower.includes("listo") || lower.includes("ya")) {
      await sendTextWithTyping(waId, "Mandame la foto del comprobante 🧾📸");
    }
    return;
  }

  // ============================================
  // ESTADO NEW - Mensajes iniciales
  // ============================================

  // Primer mensaje = SOLO saludo (espera respuesta)
  if (!session.saludo_enviado && /^(hola|buenas|buenos|pura vida|hey)/.test(lower)) {
    session.saludo_enviado = true;
    saveDataToDisk();
    await sendTextWithTyping(waId, frase("saludos", waId));
    return;
  }

  // Segundo mensaje o pregunta por productos = enviar catálogo (si no se ha enviado)
  if (!session.catalogo_enviado && (
      session.saludo_enviado || 
      /tienen|hay|busco|quiero|necesito|faldas?|blusas?|vestidos?|jeans|pantalon|bolsos?|fajas?|ropa|catalogo|productos/.test(lower)
  )) {
    session.saludo_enviado = true;
    session.catalogo_enviado = true;
    saveDataToDisk();
    await sendTextWithTyping(waId, `${frase("catalogo", waId)}\n\n${CATALOG_URL}`);
    return;
  }

  // Ya envió catálogo, cliente sigue preguntando cosas generales
  if (session.catalogo_enviado && /tienen|hay|busco|quiero|necesito/.test(lower)) {
    await sendTextWithTyping(waId, `Revisá el catálogo y si te gusta algo, dale al botón 'Me interesa' 🙌\n\n${CATALOG_URL}`);
    return;
  }

  // Agradecimiento
  if (/^(gracias|muchas gracias)/.test(lower)) { 
    await sendTextWithTyping(waId, frase("gracias", waId)); 
    return; 
  }

  // FAQs
  if (/envio|entregan|envían/.test(lower)) {
    if (offersShipping()) await sendTextWithTyping(waId, `Sí hacemos envíos 🚚\n\nGAM: ${SHIPPING_GAM}\nRural: ${SHIPPING_RURAL}\n${DELIVERY_DAYS}`);
    else await sendTextWithTyping(waId, `Solo retiro 🏪\n📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}`);
    return;
  }

  if (/horario|hora|atienden/.test(lower)) { 
    await sendTextWithTyping(waId, `Horario: ${HOURS_DAY} 🙌`); 
    return; 
  }
  
  if (/garantia|devolucion|cambio/.test(lower)) { 
    await sendTextWithTyping(waId, `Garantía: ${WARRANTY_DAYS} 🙌`); 
    return; 
  }
  
  if (/ubicacion|donde|direccion/.test(lower) && hasPhysicalLocation()) { 
    await sendTextWithTyping(waId, `📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}${MAPS_URL ? `\n🗺️ ${MAPS_URL}` : ""}`); 
    return; 
  }

  if (/tallas?|medidas?|tamanos?/.test(lower)) {
    await sendTextWithTyping(waId, "Manejamos tallas: S, M, L, XL, XXL y Talla Plus 👕\n\nRevisá el catálogo y si te gusta algo, dale 'Me interesa' 🙌");
    return;
  }

  if (/sinpe|pago|como pago/.test(lower)) { 
    await sendTextWithTyping(waId, `SINPE Móvil 💳\n${SINPE_NUMBER}\nA nombre de: ${SINPE_NAME}`); 
    return; 
  }

  // Apartados
  if (/apartado|apartar|aparto|reservar|reserva/.test(lower)) {
    await sendTextWithTyping(waId, "¡Sí hacemos apartados! 🙌\n\nApartás con la cuarta parte (1/4) del precio y tenés 2 meses para completar el pago y retirar.");
    return;
  }

  // Tarjeta
  if (/tarjeta|credito|débito|debito|visa|mastercard/.test(lower)) {
    await sendTextWithTyping(waId, "Por el momento solo aceptamos SINPE Móvil y efectivo 🙌 No manejamos tarjetas.");
    return;
  }

  // Cambios/devoluciones
  if (/cambio|devolucion|devolver|cambiar/.test(lower)) {
    await sendTextWithTyping(waId, "Tenés 8 días para cambios, con factura y sin usar 🙌 No hacemos devoluciones de dinero, solo cambios.");
    return;
  }

  // Fallback: Si no entendió, usar IA
  if (!session.catalogo_enviado) {
    // Primera vez - enviar catálogo
    session.catalogo_enviado = true;
    saveDataToDisk();
    await sendTextWithTyping(waId, `${frase("catalogo", waId)}\n\n${CATALOG_URL}`);
  } else {
    // Ya envió catálogo - usar IA para responder
    const aiResponse = await askAI(text);
    if (aiResponse) {
      await sendTextWithTyping(waId, aiResponse);
    } else {
      // Si IA falla, respuesta genérica
      await sendTextWithTyping(waId, "Si tenés alguna duda, podés llamarnos al 2237-3335 o visitarnos en tienda 🙌");
    }
  }
}

/**
 ============================
 ACCIONES PANEL
 ============================
 */
async function executeAction(clientWaId, actionType, data = {}) {
  const session = getSession(clientWaId);

  // SI_HAY: Confirmar stock → preguntar zona
  if (actionType === "SI_HAY") {
    session.state = "ESPERANDO_ZONA";
    pendingQuotes.delete(clientWaId);
    account.metrics.quotes_sent += 1;
    
    await sendTextWithTyping(clientWaId, `${frase("si_hay", clientWaId)}\n\n${frase("pedir_zona", clientWaId)}`);
    saveDataToDisk();
    io.emit("pending_resolved", { waId: clientWaId });
    return { success: true, message: "Stock confirmado, esperando zona" };
  }

  // ENVIO: Dueño da costo de envío
  if (actionType === "ENVIO") {
    const shipping = Number(data.shipping || 0);
    session.shipping_cost = shipping;
    session.state = "PRECIO_TOTAL_ENVIADO";
    const price = session.precio || 0;
    const total = price + shipping;

    let msg = `${frase("confirmacion", clientWaId)}\n\n`;
    msg += `📦 ${session.producto || 'Artículo'}\n`;
    msg += `👕 ${session.talla_color || '-'}\n\n`;
    
    if (offersShipping() && offersPickup()) {
      msg += `📦 Con envío: ₡${total.toLocaleString()}\n🏪 Recoger en tienda: ₡${price.toLocaleString()}\n\n¿Qué preferís?`;
    } else {
      msg += `💰 Total: ₡${total.toLocaleString()}\n\n¿Lo querés?`;
    }
    await sendButtons(clientWaId, msg, [{ title: "¡Lo quiero!" }, { title: "No, gracias" }]);
    saveDataToDisk();
    return { success: true, message: `Envío ₡${shipping.toLocaleString()} enviado` };
  }

  // NO_HAY: No hay stock
  if (actionType === "NO_HAY") {
    await sendTextWithTyping(clientWaId, frase("no_hay", clientWaId) + `\n\n${CATALOG_URL}`);
    resetSession(session);
    pendingQuotes.delete(clientWaId);
    io.emit("pending_resolved", { waId: clientWaId });
    saveDataToDisk();
    return { success: true, message: "No hay enviado" };
  }

  // PAGADO: Confirmar pago
  if (actionType === "PAGADO") {
    session.state = "PAGO_CONFIRMADO";
    account.metrics.sinpe_confirmed += 1;
    const profile = getProfile(clientWaId);
    profile.purchases = (profile.purchases || 0) + 1;
    
    const deliveryMsg = session.delivery_method === "envio" 
      ? `Se enviará pronto 🚚 Tiempo estimado: ${DELIVERY_DAYS}` 
      : `Podés recogerlo en:\n📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}`;
    
    await sendTextWithTyping(clientWaId, 
      `¡Pago confirmado! 🎉 ${frase("gracias", clientWaId)}\n\n` +
      `📦 ${session.producto || 'Artículo'}\n` +
      `👕 ${session.talla_color || '-'}\n\n` +
      `${deliveryMsg}`
    );
    resetSession(session);
    saveDataToDisk();
    return { success: true, message: "Pago confirmado" };
  }

  // MENSAJE: Mensaje libre
  if (actionType === "MENSAJE") {
    const texto = String(data.texto || "").trim();
    if (!texto) return { success: false, message: "Vacío" };
    await sendTextDirect(clientWaId, texto);
    return { success: true, message: "Enviado" };
  }

  // NO_ENVIO_ZONA: No hacemos envío a esa zona
  if (actionType === "NO_ENVIO_ZONA") {
    const price = session.precio || 0;
    session.shipping_cost = 0;
    session.state = "PRECIO_TOTAL_ENVIADO";
    
    if (offersPickup()) {
      await sendTextWithTyping(clientWaId, 
        `No hacemos envíos a ${session.client_zone || "esa zona"} 😔\n\n` +
        `Pero podés recoger en tienda:\n🏪 ${STORE_ADDRESS}\n💰 ₡${price.toLocaleString()}\n\n¿Te interesa?`
      );
    } else { 
      await sendTextWithTyping(clientWaId, "No hacemos envíos a esa zona 😔"); 
      resetSession(session); 
    }
    saveDataToDisk();
    return { success: true, message: "Sin envío" };
  }

  return { success: false, message: "Acción desconocida" };
}

/**
 ============================
 SOCKET.IO
 ============================
 */
io.on("connection", (socket) => {
  let authenticated = false;

  socket.on("auth", (pin) => {
    if (pin === PANEL_PIN) {
      authenticated = true;
      socket.emit("auth_success", { storeName: STORE_NAME });
      socket.emit("connection_status", { status: connectionStatus, phone: connectedPhone });
      socket.emit("bot_status", { paused: botPaused });
      if (qrCode) socket.emit("qr_code", { qr: qrCode });
      socket.emit("init_data", { pending: Array.from(pendingQuotes.values()), history: chatHistory.slice(-50), contacts: Array.from(profiles.values()), metrics: account.metrics });
    } else socket.emit("auth_error", "PIN incorrecto");
  });

  socket.use((packet, next) => { if (packet[0] === "auth") return next(); if (!authenticated) return next(new Error("No auth")); next(); });

  socket.on("connect_whatsapp", () => { if (connectionStatus === "connected") { socket.emit("connection_status", { status: "connected", phone: connectedPhone }); return; } connectWhatsApp(); });
  socket.on("disconnect_whatsapp", async () => { if (sock) await sock.logout(); sock = null; connectionStatus = "disconnected"; qrCode = null; connectedPhone = ""; io.emit("connection_status", { status: connectionStatus }); });
  socket.on("toggle_bot", () => { botPaused = !botPaused; saveDataToDisk(); io.emit("bot_status", { paused: botPaused }); console.log(botPaused ? "⏸️ PAUSADO" : "▶️ ACTIVO"); });
  socket.on("action", async (data) => { const result = await executeAction(data.clientWaId, data.actionType, data.payload || {}); socket.emit("action_result", result); });
  socket.on("post_status", async (data) => { let result; if (data.textOnly && data.text) result = await postStatusText(data.text); else if (data.image) result = await postStatus(Buffer.from(data.image, "base64"), data.caption || ""); else result = { success: false, message: "Sin contenido" }; socket.emit("status_result", result); });
  socket.on("get_contacts", () => { socket.emit("contacts_list", { contacts: Array.from(profiles.values()) }); });
  socket.on("toggle_block", (data) => { if (!data.waId) return; const p = getProfile(data.waId); p.blocked = data.block; saveDataToDisk(); io.emit("contact_updated", { contact: p }); });
  socket.on("add_contact", (data) => { if (!data.waId) return; const p = getProfile(data.waId); if (data.name) p.name = data.name; saveDataToDisk(); io.emit("contact_added", { contact: p }); });
  socket.on("update_contact", (data) => { if (!data.waId) return; const p = getProfile(data.waId); if (data.name !== undefined) p.name = data.name; if (data.blocked !== undefined) p.blocked = data.blocked; saveDataToDisk(); io.emit("contact_updated", { contact: p }); });
  socket.on("delete_contact", (data) => { if (!data.waId) return; profiles.delete(data.waId); saveDataToDisk(); io.emit("contact_deleted", { waId: data.waId }); });
  socket.on("delete_chats", (data) => { if (!data.waId) return; const n = normalizePhone(data.waId); chatHistory = chatHistory.filter(m => m.waId !== n); sessions.delete(n); pendingQuotes.delete(n); saveDataToDisk(); io.emit("chats_deleted", { waId: n }); });
  socket.on("get_metrics", () => { socket.emit("metrics", { metrics: account.metrics }); });
});

/**
 ============================
 ENDPOINTS
 ============================
 */
app.get("/health", (req, res) => res.send("OK"));
app.get("/status", (req, res) => res.json({ connection: connectionStatus, phone: connectedPhone, botPaused, storeOpen: isStoreOpen(), metrics: account.metrics }));

/**
 ============================
 INICIAR
 ============================
 */
server.listen(PORT, () => {
  loadDataFromDisk();
  console.log(`
╔═══════════════════════════════════════════════════╗
║  🐄 TICO-bot - La Vaca CR                         ║
╠═══════════════════════════════════════════════════╣
║  🕒 Horario: ${HOURS_DAY.padEnd(36)}║
║  ⏱️ Delay: ${(DELAY_MIN + "-" + DELAY_MAX + " seg").padEnd(37)}║
║  🌐 Catálogo: ${CATALOG_URL.slice(0,33).padEnd(34)}║
║  📱 Panel: http://localhost:${PORT}/                  ║
╚═══════════════════════════════════════════════════╝
  `);
  if (fs.existsSync(path.join(AUTH_FOLDER, "creds.json"))) { console.log("🔄 Reconectando..."); connectWhatsApp(); }
});
