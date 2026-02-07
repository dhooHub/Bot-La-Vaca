/** ============================
 * TICO-bot Lite (Baileys)
 * index.js — La Vaca CR - Ropa y Accesorios
 *
 * FLUJO + IA CLASIFICADORA + FIXES
 * ============================ */

import express from "express";
import http from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import QRCode from "qrcode";
import pino from "pino";

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const logger = pino({ level: "silent" });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PANEL_PIN = process.env.PANEL_PIN || "1234";
const STORE_NAME = process.env.STORE_NAME || "La Vaca CR";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const HOURS_START = 9;
const HOURS_END_HOUR = 18;
const HOURS_END_MIN = 50;
const HOURS_DAY = "9am - 6:50pm";
const DELAY_MIN = 15;
const DELAY_MAX = 60;
const SESSION_TIMEOUT = 2 * 60 * 60 * 1000;
const STORE_TYPE = (process.env.STORE_TYPE || "fisica_con_envios").toLowerCase();
const STORE_ADDRESS = process.env.STORE_ADDRESS || "";
const MAPS_URL = process.env.MAPS_URL || "";
const SINPE_NUMBER = process.env.SINPE_NUMBER || "";
const SINPE_NAME = process.env.SINPE_NAME || "";
const SHIPPING_GAM = process.env.SHIPPING_GAM || "₡2,500";
const SHIPPING_RURAL = process.env.SHIPPING_RURAL || "₡3,500";
const DELIVERY_DAYS = process.env.DELIVERY_DAYS || "8 días hábiles";
const WARRANTY_DAYS = process.env.WARRANTY_DAYS || "30 días contra defectos de fábrica";
const CATALOG_URL = process.env.CATALOG_URL || "https://www.lavacacr.com";
const PERSISTENT_DIR = "/data";
const AUTH_FOLDER = path.join(PERSISTENT_DIR, "auth_baileys");
const DATA_FOLDER = PERSISTENT_DIR;

// Pushover config
const PUSHOVER_USER_KEY = process.env.PUSHOVER_USER_KEY || "";
const PUSHOVER_APP_TOKEN = process.env.PUSHOVER_APP_TOKEN || "";
const PANEL_URL = process.env.PANEL_URL || "https://tico-bot-lite.onrender.com";

// Servir imágenes guardadas
app.use('/images', express.static(path.join(PERSISTENT_DIR, 'images')));

let sock = null, qrCode = null, connectionStatus = "disconnected", reconnectAttempts = 0, connectedPhone = "", botPaused = false;
const messageQueue = [];
let isProcessingQueue = false;
const sessions = new Map();
const profiles = new Map();
const pendingQuotes = new Map();
let chatHistory = [];
const MAX_CHAT_HISTORY = 500;
const account = { metrics: { chats_total:0, quotes_sent:0, intent_yes:0, intent_no:0, delivery_envio:0, delivery_recoger:0, sinpe_confirmed:0, estados_sent:0, mensajes_enviados:0, ia_calls:0 } };

function hasPhysicalLocation() { return STORE_TYPE === "fisica_con_envios" || STORE_TYPE === "fisica_solo_recoger"; }
function offersShipping() { return STORE_TYPE === "virtual" || STORE_TYPE === "fisica_con_envios"; }
function offersPickup() { return STORE_TYPE === "fisica_con_envios" || STORE_TYPE === "fisica_solo_recoger"; }
function normalizePhone(input) { const d = String(input||"").replace(/[^\d]/g,"").replace(/@.*/,""); if(d.length===8)return"506"+d; if(d.startsWith("506")&&d.length===11)return d; return d; }
function toJid(phone) { return normalizePhone(phone)+"@s.whatsapp.net"; }
function fromJid(jid) { return jid?jid.replace(/@.*/,""):""; }
function formatPhone(waId) { const d=normalizePhone(waId); if(d.length===11&&d.startsWith("506"))return`${d.slice(0,3)} ${d.slice(3,7)}-${d.slice(7)}`; return waId; }
function getCostaRicaTime() { const now=new Date(); const utc=now.getTime()+(now.getTimezoneOffset()*60000); const cr=new Date(utc-(6*60*60*1000)); return{hour:cr.getHours(),minute:cr.getMinutes()}; }
function isStoreOpen() { const{hour,minute}=getCostaRicaTime(); if(hour<HOURS_START)return false; if(hour>HOURS_END_HOUR)return false; if(hour===HOURS_END_HOUR&&minute>=HOURS_END_MIN)return false; return true; }
function norm(s="") { return String(s).toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g,""); }
function getHumanDelay() { return(Math.floor(Math.random()*(DELAY_MAX-DELAY_MIN+1))+DELAY_MIN)*1000; }
function sleep(ms) { return new Promise(resolve=>setTimeout(resolve,ms)); }
function extractPrice(text) { const match=String(text).match(/₡?\s*([\d\s,\.]+)/); if(match)return parseInt(match[1].replace(/[\s,\.]/g,''))||0; return 0; }

// ============ INTELIGENCIA ARTIFICIAL ============

const STORE_CONTEXT = `Sos el asistente virtual de La Vaca CR, una tienda de ropa y accesorios ubicada en Heredia, Costa Rica.

INFORMACIÓN DE LA TIENDA:
- Nombre: La Vaca CR
- Ubicación: Heredia centro, 200m sur de Correos de CR
- Horario: Lunes a Sábado 9am-7pm, Domingo 10am-6pm
- Teléfono: 2237-3335
- WhatsApp: +506 6483-6565
- Catálogo online: www.lavacacr.com

⚠️ MUY IMPORTANTE - DIFERENCIA TIENDA vs CATÁLOGO:
EN TIENDA FÍSICA vendemos: ropa para damas, caballeros y niños, uniformes escolares, fajas, bolsos para dama, y más.
EN CATÁLOGO ONLINE (www.lavacacr.com) solo vendemos: ROPA PARA DAMAS.

Si preguntan por productos que NO son ropa de damas (uniformes, ropa de niños, ropa de hombre, fajas, etc.):
- Decí que esos productos los manejamos EN TIENDA
- Invitá a visitar la tienda física donde pueden ver toda la variedad
- NO digas que no tenemos, decí que en tienda pueden encontrarlo

LO QUE SÍ PODÉS RESPONDER:
- Horarios de atención
- Ubicación y cómo llegar
- Tallas disponibles: S, M, L, XL, XXL y Talla Plus en algunos estilos
- Apartados: Se aparta con la cuarta parte del costo y tenés dos meses para retirar
- Cambios: 8 días con factura y sin usar. No se hacen devoluciones de dinero.
- Garantía: 30 días contra defectos de fábrica
- Métodos de pago: SINPE Móvil y efectivo en tienda (NO tarjetas)
- Si preguntan por SINPE o formas de pago SIN tener pedido activo, responder: "¡Claro! Para ventas en línea aceptamos SINPE Móvil al ${SINPE_NUMBER} a nombre de ${SINPE_NAME}. En la tienda podés pagar efectivo, tarjeta y también SINPE. ¡Te esperamos con gusto! 😊"
- ENVÍOS: Sí hacemos envíos a todo el país con Correos de Costa Rica:
  * GAM (área metropolitana): ₡2,500
  * Fuera de GAM: ₡3,500
  * Tiempo de entrega: 4-5 días hábiles

🚫 NUNCA RESPONDAS SOBRE:
- Precios de productos (decí: "Los precios los vemos cuando elijas el producto del catálogo 🙌")
- Disponibilidad de productos específicos del catálogo (decí: "Revisá el catálogo en www.lavacacr.com y si te gusta algo, dale al botón 'Me interesa' 🙌")

ESTILO: Respondé como tico, amigable, natural, corto (2-3 oraciones máximo). Usá "vos" no "usted". No inventés información.`;


async function classifyMessage(userMessage, currentState, lastBotQuestion) {
  if (!OPENAI_API_KEY) return "RESPUESTA_FLUJO";
  try {
    const prompt = `Sos un clasificador de mensajes para un bot de ventas de ropa por WhatsApp en Costa Rica.
El bot está en medio de una conversación de venta.
ESTADO ACTUAL: ${currentState}
ÚLTIMA PREGUNTA DEL BOT: "${lastBotQuestion}"
MENSAJE DEL CLIENTE: "${userMessage}"

Clasificá en UNA categoría:
- RESPUESTA_FLUJO: responde directamente a lo que el bot preguntó (sí, no, talla, dirección, zona, etc.)
- FAQ: pregunta general sobre la tienda (horario, ubicación, envíos, tallas, pago, garantía, apartados) que NO es respuesta a la pregunta del bot
- NUEVO_PRODUCTO: pregunta por otro producto diferente (ej: "también tienen medias?", "y bolsos?", "necesito otra cosa")
- OTRO: no encaja (saludo suelto, mensaje confuso, etc.)

Respondé SOLO con una palabra: RESPUESTA_FLUJO, FAQ, NUEVO_PRODUCTO, o OTRO.`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: 10, temperature: 0 })
    });
    if (!response.ok) return "RESPUESTA_FLUJO";
    const data = await response.json();
    const result = (data.choices?.[0]?.message?.content || "").trim().toUpperCase();
    const valid = ["RESPUESTA_FLUJO", "FAQ", "NUEVO_PRODUCTO", "OTRO"];
    const classification = valid.find(v => result.includes(v)) || "RESPUESTA_FLUJO";
    console.log(`🧠 Clasificación: "${userMessage.slice(0,30)}..." → ${classification}`);
    account.metrics.ia_calls = (account.metrics.ia_calls || 0) + 1;
    return classification;
  } catch (error) { console.log("⚠️ Error clasificador:", error.message); return "RESPUESTA_FLUJO"; }
}

async function askAI(userMessage, conversationHistory = []) {
  if (!OPENAI_API_KEY) return null;
  try {
    const messages = [{ role: "system", content: STORE_CONTEXT }, ...conversationHistory.slice(-4), { role: "user", content: userMessage }];
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: "gpt-4o-mini", messages, max_tokens: 150, temperature: 0.7 })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const aiResponse = data.choices?.[0]?.message?.content?.trim();
    if (aiResponse) { console.log("🤖 IA respondió:", aiResponse.slice(0, 50) + "..."); account.metrics.ia_calls = (account.metrics.ia_calls || 0) + 1; }
    return aiResponse;
  } catch (error) { console.log("❌ Error IA:", error.message); return null; }
}

function getStateDescription(state) {
  const map = {
    ESPERANDO_DETALLES_FOTO: "Se le pidió qué talla, color o tamaño quiere del producto de la foto",
    ESPERANDO_TALLA: "Se le preguntó qué talla y color quiere",
    ESPERANDO_CONFIRMACION_VENDEDOR: "Se le dijo que estamos verificando disponibilidad",
    PREGUNTANDO_INTERES: "Se le preguntó si quiere comprar el producto (sí o no)",
    PREGUNTANDO_METODO: "Se le preguntó si quiere envío o retiro en tienda",
    ESPERANDO_UBICACION_ENVIO: "Se le pidió Provincia - Cantón - Distrito",
    ZONA_RECIBIDA: "Se le dijo que estamos calculando el envío",
    PRECIO_TOTAL_ENVIADO: "Se le mostró el precio total y se preguntó si está de acuerdo",
    ESPERANDO_SINPE: "Se le dieron los datos de SINPE y se espera el comprobante",
    ESPERANDO_DATOS_ENVIO: "Se le pidió nombre, teléfono, provincia, cantón, distrito y señas",
    CONFIRMANDO_DATOS_ENVIO: "Se le mostró resumen del pedido y se preguntó si está correcto (1=sí, 2=no)",
  };
  return map[state] || state;
}

// ============ PERSISTENCIA ============
function saveDataToDisk() { 
  try { 
    // Limpiar foto_base64 de las sesiones antes de guardar (muy grandes)
    const sessionsToSave = Array.from(sessions.values()).map(s => {
      const copy = {...s};
      delete copy.foto_base64; // No guardar imágenes en disco
      return copy;
    });
    fs.writeFileSync(path.join(DATA_FOLDER,"ticobot_data.json"),JSON.stringify({account,botPaused,profiles:Array.from(profiles.values()),sessions:sessionsToSave},null,2)); 
    saveHistory(); 
  } catch(e){console.log("⚠️ Error guardando:",e.message);} 
}
function loadDataFromDisk() { try { const file=path.join(DATA_FOLDER,"ticobot_data.json"); if(!fs.existsSync(file))return; const data=JSON.parse(fs.readFileSync(file,"utf-8")); if(data.account)Object.assign(account,data.account); if(data.profiles)data.profiles.forEach(p=>profiles.set(p.waId,p)); if(data.sessions)data.sessions.forEach(s=>sessions.set(s.waId,s)); if(data.botPaused!==undefined)botPaused=data.botPaused; console.log("📂 Datos cargados"); } catch(e){console.log("⚠️ Error cargando:",e.message);} }
setInterval(saveDataToDisk, 5 * 60 * 1000);

// ============ FRASES ============
const FRASES = {
  revisando: ["Dame un toque, voy a revisar si lo tenemos disponible 👍","Dejame chequearlo, ya te confirmo 👌","Un momento, voy a fijarme si queda en stock 🙌","Ya te confirmo disponibilidad, dame un ratito 😊","Voy a revisar de una vez 👍","Permíteme un momento, lo verifico 🙌","Dame chance, ya lo busco 😊","Un segundito, reviso si lo tenemos 👌","Ya miro y te cuento 🙌","Dejame ver si queda, ya te digo 👍"],
  saludos: ["¡Hola! Pura vida 🙌 ¿En qué te ayudo?","¡Hola! Con gusto te atiendo 😊","¡Buenas! Pura vida 🙌","¡Hola! ¿Cómo estás? 😊","¡Qué tal! Bienvenid@ 🙌","¡Hola! Qué gusto saludarte 👋","¡Buenas! ¿En qué te puedo servir? 😊","¡Hola! Aquí estamos para ayudarte 🙌","¡Pura vida! ¿Qué ocupás? 😊","¡Hola! Bienvenid@ 🐄"],
  catalogo: ["Te paso el catálogo con los productos disponibles para venta en línea. Si te gusta algo, le das click al botón 'Me interesa' 🙌","Aquí te dejo los productos disponibles para venta en línea. Si ves algo que te guste, dale al botón 'Me interesa' 😊","Te comparto el catálogo de venta en línea. Si algo te llama la atención, tocá 'Me interesa' 🙌"],
  pedir_talla: ["¿Qué talla, tamaño o color lo necesitás? 👕","¿En qué talla y color lo ocupás? 😊","¿Qué talla/color te gustaría? 👗","¿Me decís la talla y el color que buscás? 🙌"],
  si_hay: ["¡Sí lo tenemos disponible! 🎉","¡Qué dicha, sí hay! 🙌","¡Perfecto, lo tenemos! 😊","¡Sí está disponible! 🎉","¡Claro que sí, hay en stock! 🙌"],
  te_interesa: ["¿Te interesa adquirir la prenda? 😊","¿Querés llevártelo? 🙌","¿Lo querés? 😊","¿Te gustaría comprarlo? 🙌"],
  confirmacion: ["¡Buenísimo! 🙌","¡Perfecto! 🎉","¡Excelente! 👍","¡Genial! 🙌","¡Dale! 😊","¡Qué bien! 🎉","¡Tuanis! 🙌","¡Listo! 👍"],
  no_quiere: ["¡Con gusto! 🙌 ¿Te puedo ayudar con algo más?","¡Está bien! 🙌 ¿Hay algo más en que te pueda ayudar?","No hay problema 👍 ¿Ocupás algo más?","Dale 🙌 ¿Te ayudo con alguna otra cosa?"],
  despedida: ["¡Pura vida! 🙌 Cualquier cosa aquí estamos. ¡Que te vaya bien!","¡Con gusto! 😊 Cuando ocupés, nos escribís. ¡Pura vida!","¡Dale! 🙌 Aquí estamos para cuando gustés. ¡Buena vibra!","¡Perfecto! 😊 Si necesitás algo en el futuro, con gusto te ayudamos. ¡Pura vida!"],
  no_hay: ["No tenemos ese disponible en este momento 😔 ¿Te interesa ver otro producto? Con gusto te ayudo 🙌","Uy, ese no nos queda 😔 Pero hay más opciones en el catálogo. ¿Querés ver algo más? 🙌","Qué lástima, no lo tenemos 😔 ¿Te ayudo con otro producto?","Ese se nos agotó 😔 ¿Te interesa ver algo similar en el catálogo? 🙌"],
  pedir_zona: ["¿Me podés decir de qué provincia y cantón nos escribís? 📍","Para calcular el envío, ¿de qué provincia y cantón sos? 📍","¿Me decís tu provincia y cantón? 📍","¿De qué provincia y cantón te lo enviaríamos? 📍"],
  pedir_metodo: ["¿Querés que te lo enviemos o preferís recogerlo en tienda? 📦🏪\n\n1. 📦 Envío\n2. 🏪 Recoger en tienda\n\nResponde con el número 👆","¿Cómo lo preferís? 🙌\n\n1. 📦 Envío a tu casa\n2. 🏪 Recoger en tienda\n\nResponde con el número 👆"],
  nocturno: ["¡Hola! 🌙 Ya cerramos por hoy. Mañana a las 9am te atiendo con gusto 😊","Pura vida 🌙 Estamos fuera de horario. Te respondo mañana temprano 🙌","¡Buenas noches! 🌙 Nuestro horario es de 9am a 6:50pm. Mañana te ayudo 😊","Hola 🌙 Ya cerramos. Dejame tu consulta y mañana te confirmo 🙌"],
  gracias: ["¡Gracias a vos! 🙌","¡Con mucho gusto! 😊","¡Pura vida! 🙌","¡Gracias por la confianza! 💪","¡Tuanis! 🙌","¡Para servirte! 😊"],
  espera_zona: ["¡Anotado! 📝 Dame un momento para calcular el envío 🙌","Perfecto 📝 Ya reviso cuánto sale a tu zona 😊","Listo 📝 Dejame calcular el envío 🙌"],
  espera_vendedor: ["Ya estoy revisando, un momento 🙌","Dame chance, estoy verificando 😊","Un momento, ya te confirmo 🙌"],
  saludo_interes: ["¡Hola! Pura vida 🙌 Qué buena elección. Dejame revisar si lo tenemos disponible, ya te confirmo 😊","¡Hola! 🙌 Vi que te interesa este producto. Voy a verificar disponibilidad, un momento 😊","¡Buenas! 🐄 Excelente gusto. Dame un toque para confirmar si lo tenemos 👍","¡Hola! Pura vida 🙌 Ya vi tu consulta. Dejame revisar stock y te confirmo rapidito 😊","¡Qué tal! 🙌 Buena elección. Voy a fijarme si está disponible, ya te aviso 👍"],
  pedir_direccion: ["¡Pago recibido! 🎉 Ahora pasame tu dirección completa para el envío 📍\n(Provincia, cantón, distrito y señas)","¡Confirmado! 🎉 ¿Me das tu dirección completa para coordinar el envío? 📍\n(Provincia, cantón, distrito y señas)","¡Listo el pago! 🎉 Ocupo tu dirección completa para enviártelo 📍\n(Provincia, cantón, distrito y señas)"],
  fin_envio: ["¡Perfecto! 🎉 Tu pedido va en camino pronto 🚚\n\nTiempo estimado: {days}\n\n¡Gracias por tu compra! 🙌 ¡Pura vida!","¡Anotado! 🎉 Te lo enviamos lo antes posible 🚚\n\nTiempo estimado: {days}\n\n¡Muchas gracias por tu confianza! 🙌"],
  fin_retiro: ["¡Pago confirmado! 🎉 Ya podés pasar a recogerlo:\n\n📍 {address}\n🕒 {hours}\n\n¡Gracias por tu compra! 🙌 ¡Pura vida!","¡Listo! 🎉 Tu producto te espera en tienda:\n\n📍 {address}\n🕒 {hours}\n\n¡Muchas gracias! 🙌"],
  primero_terminemos: ["¡Con gusto te ayudo con eso! 🙌 Pero primero terminemos con tu pedido actual, y después vemos lo otro 😊","¡Claro! Ahorita terminamos con lo que estamos viendo y luego te ayudo con eso 🙌","¡Sí! Dejame primero resolver tu pedido actual y después lo buscamos 😊"],
  recordatorio_flujo: {
    ESPERANDO_DETALLES_FOTO: "Y sobre la foto que me mandaste, ¿qué talla, color o tamaño te interesa? 👕",
    ESPERANDO_TALLA: "Y sobre tu producto, ¿me decís la talla y color? 👕",
    ESPERANDO_CONFIRMACION_VENDEDOR: "Y sobre tu consulta, ya estoy verificando disponibilidad 🙌",
    PREGUNTANDO_INTERES: "Y sobre el producto, ¿te interesa adquirirlo? 😊\n\n1. ✅ Sí\n2. ❌ No",
    ESPERANDO_ZONA: "Y sobre tu pedido, ¿de qué zona sos? 📍",
    PREGUNTANDO_METODO: "Y sobre tu pedido, ¿envío o retiro en tienda?\n\n1. 📦 Envío\n2. 🏪 Recoger",
    ESPERANDO_UBICACION_ENVIO: "Y sobre tu envío, escribí tu *Provincia - Cantón - Distrito* 📍",
    ZONA_RECIBIDA: "Y sobre tu pedido, estoy calculando el envío 🙌",
    PRECIO_TOTAL_ENVIADO: "Y sobre tu pedido, ¿estás de acuerdo con el precio?\n\n1. ✅ Sí\n2. ❌ No",
    ESPERANDO_SINPE: "Y sobre tu pago, estoy esperando el comprobante de SINPE 🧾",
    ESPERANDO_DATOS_ENVIO: "Y sobre tu envío, escribí separado por comas: *Nombre, Teléfono, Provincia, Cantón, Distrito, Señas* 📦",
    CONFIRMANDO_DATOS_ENVIO: "Y sobre tu pedido, ¿los datos están correctos?\n\n1. ✅ Sí\n2. ❌ No",
  },
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

// ============ SESIONES Y PERFILES ============
function getSession(waId) {
  const id = normalizePhone(waId);
  if (!sessions.has(id)) {
    sessions.set(id, { 
      waId:id, replyJid:null, state:"NEW", producto:null, precio:null, codigo:null, foto_url:null, talla_color:null, 
      shipping_cost:null, client_zone:null, delivery_method:null, sinpe_reference:null, 
      // Datos de envío
      envio_nombre:null, envio_telefono:null, envio_direccion:null,
      // Foto externa
      foto_externa:false, foto_base64:null, foto_url_guardada:null,
      saludo_enviado:false, catalogo_enviado:false, nocturno_sent_at:null, last_activity:Date.now() 
    });
  }
  const s = sessions.get(id); s.last_activity = Date.now(); return s;
}

const jidMap = new Map();
const LID_MAP_FILE = path.join(DATA_FOLDER, "lid_phone_map.json");
let lidPhoneMap = new Map();
function loadLidMap() { try { if(fs.existsSync(LID_MAP_FILE)){const data=JSON.parse(fs.readFileSync(LID_MAP_FILE,"utf8"));lidPhoneMap=new Map(Object.entries(data));console.log(`📋 LID map: ${lidPhoneMap.size} entradas`);} } catch(e){} }
function saveLidMap() { try{fs.writeFileSync(LID_MAP_FILE,JSON.stringify(Object.fromEntries(lidPhoneMap),null,2));}catch(e){} }
loadLidMap();

function resetSession(session) {
  session.state="NEW"; session.producto=null; session.precio=null; session.codigo=null; session.foto_url=null; session.talla_color=null; session.shipping_cost=null; session.client_zone=null; session.delivery_method=null; session.sinpe_reference=null; 
  session.envio_nombre=null; session.envio_telefono=null; session.envio_direccion=null;
  session.foto_externa=false; session.foto_base64=null; session.foto_url_guardada=null;
  session.saludo_enviado=false; session.catalogo_enviado=false; session.nocturno_sent_at=null; pendingQuotes.delete(session.waId);
}

function getProfile(waId) { const id=normalizePhone(waId); if(!profiles.has(id))profiles.set(id,{waId:id,name:"",blocked:false,purchases:0,created_at:new Date().toISOString()}); return profiles.get(id); }

function addToChatHistory(waId, direction, text, imageBase64=null) {
  const profile=getProfile(waId);
  
  // Si hay imagen, guardarla como archivo
  let imageUrl = null;
  if(imageBase64) {
    try {
      const imgDir = path.join(PERSISTENT_DIR, "images");
      if(!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, {recursive: true});
      const imgFile = `chat_${waId}_${Date.now()}.jpg`;
      const imgPath = path.join(imgDir, imgFile);
      fs.writeFileSync(imgPath, Buffer.from(imageBase64, 'base64'));
      imageUrl = `/images/${imgFile}`;
    } catch(e) {
      console.log(`⚠️ Error guardando imagen de chat: ${e.message}`);
      // Fallback: no guardar imagen
      imageUrl = null;
    }
  }
  
  const entry = { 
    id:Date.now().toString(36)+Math.random().toString(36).slice(2,6), 
    waId:normalizePhone(waId), 
    phone:profile.phone||normalizePhone(waId), 
    name:profile.name||"", 
    direction, 
    text, 
    imageUrl,
    timestamp:new Date().toISOString() 
  };
  
  chatHistory.push(entry); 
  if(chatHistory.length>MAX_CHAT_HISTORY) chatHistory=chatHistory.slice(-MAX_CHAT_HISTORY);
  
  // ✅ Guardar en historial permanente (disco)
  appendToHistory(entry);
  
  // ✅ Emitir al panel
  io.emit("new_message", entry); 
  return entry;
}

// ============ HISTORIAL PERMANENTE EN DISCO ============
const HISTORY_FILE = path.join(PERSISTENT_DIR, "historial.json");
let fullHistory = [];

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, "utf-8");
      fullHistory = JSON.parse(data);
      console.log(`📚 Historial cargado: ${fullHistory.length} mensajes`);
      // Limpiar mensajes > 30 días
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const before = fullHistory.length;
      fullHistory = fullHistory.filter(m => new Date(m.timestamp).getTime() > thirtyDaysAgo);
      if (fullHistory.length < before) {
        console.log(`🧹 Limpiados ${before - fullHistory.length} mensajes antiguos (>30 días)`);
        saveHistory();
      }
    }
  } catch(e) { console.log("⚠️ Error cargando historial:", e.message); fullHistory = []; }
}

function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(fullHistory)); }
  catch(e) { console.log("⚠️ Error guardando historial:", e.message); }
}

function appendToHistory(entry) {
  // No guardar imágenes base64 en disco (muy grandes)
  const entryForDisk = { ...entry };
  if (entryForDisk.imageUrl && entryForDisk.imageUrl.length > 1000) {
    entryForDisk.imageUrl = "(imagen)"; // Marcador
  }
  fullHistory.push(entryForDisk);
  // Guardar cada 50 mensajes para no escribir disco en cada mensaje
  if (fullHistory.length % 50 === 0) saveHistory();
}

// Guardar historial periódicamente (cada 2 minutos)
setInterval(() => { if (fullHistory.length > 0) saveHistory(); }, 2 * 60 * 1000);

// ✅ Función para guardar imagen de foto externa
async function guardarImagenFoto(waId, base64Data) {
  if (!base64Data) return null;
  try {
    const imgFileName = `foto_${normalizePhone(waId)}_${Date.now()}.jpg`;
    const imgDir = path.join(PERSISTENT_DIR, "images");
    const imgPath = path.join(imgDir, imgFileName);
    if (!fs.existsSync(imgDir)) {
      fs.mkdirSync(imgDir, { recursive: true });
    }
    fs.writeFileSync(imgPath, Buffer.from(base64Data, 'base64'));
    console.log(`📷 Imagen guardada: ${imgPath} (${Math.round(base64Data.length/1024)}KB)`);
    return `/images/${imgFileName}`;
  } catch(e) {
    console.log(`⚠️ Error guardando imagen: ${e.message}`);
    return `data:image/jpeg;base64,${base64Data}`;
  }
}

// ✅ Descargar imagen del catálogo (full quality) y guardarla localmente
async function descargarImagenCatalogo(codigo, waId) {
  try {
    const catalogBase = CATALOG_URL.startsWith("http") ? CATALOG_URL : `https://${CATALOG_URL}`;
    const url = new URL(`/img/${codigo}.webp`, catalogBase).toString();
    console.log(`📷 Descargando imagen catálogo: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      console.log(`⚠️ Error descargando imagen catálogo: ${response.status}`);
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const imgFileName = `cat_${codigo}_${Date.now()}.webp`;
    const imgDir = path.join(PERSISTENT_DIR, "images");
    const imgPath = path.join(imgDir, imgFileName);
    if (!fs.existsSync(imgDir)) {
      fs.mkdirSync(imgDir, { recursive: true });
    }
    fs.writeFileSync(imgPath, buffer);
    console.log(`📷 Imagen catálogo guardada: ${imgPath} (${Math.round(buffer.length/1024)}KB)`);
    return `/images/${imgFileName}`;
  } catch(e) {
    console.log(`⚠️ Error descargando imagen catálogo: ${e.message}`);
    return null;
  }
}

// ✅ Función para enviar alertas a Pushover
async function sendPushoverAlert(tipo, datos) {
  if (!PUSHOVER_USER_KEY || !PUSHOVER_APP_TOKEN) return;
  
  try {
    const phone = datos.phone || datos.waId || "Desconocido";
    const phoneFormatted = formatPhone(phone);
    const chatLink = `${PANEL_URL}/?chat=${normalizePhone(phone)}`;
    
    let title = "";
    let message = "";
    
    if (tipo === "PRODUCTO_FOTO") {
      title = "📷 Nueva consulta - Foto";
      message = `👕 ${datos.talla_color || "Sin especificar"}\n👤 ${phoneFormatted}`;
    } else if (tipo === "PRODUCTO_CATALOGO") {
      title = "📦 Nueva consulta - Catálogo";
      message = `📦 ${datos.producto || "Producto"}\n💰 ₡${(datos.precio || 0).toLocaleString()}\n👕 ${datos.talla_color || "-"}\n👤 ${phoneFormatted}`;
    } else if (tipo === "SINPE") {
      title = "💰 SINPE recibido";
      message = `📱 Ref: ${datos.reference || "?"}\n👤 ${phoneFormatted}`;
    } else if (tipo === "ZONA") {
      title = "📍 Zona recibida - Calcular envío";
      message = `🗺️ ${datos.zone || "?"}\n👤 ${phoneFormatted}`;
    }
    
    if (!title) return;
    
    const response = await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: PUSHOVER_APP_TOKEN,
        user: PUSHOVER_USER_KEY,
        title,
        message,
        url: chatLink,
        url_title: "Abrir Panel",
        priority: 1,
        sound: "cashregister"
      })
    });
    
    if (response.ok) {
      console.log(`📲 Pushover enviado: ${tipo}`);
    } else {
      console.log(`⚠️ Pushover error:`, await response.text());
    }
  } catch (e) {
    console.log(`⚠️ Pushover error: ${e.message}`);
  }
}

function searchHistory(filters = {}) {
  let results = fullHistory;
  
  // Filtrar por teléfono
  if (filters.phone) {
    const phoneNorm = normalizePhone(filters.phone);
    results = results.filter(m => m.waId === phoneNorm || m.phone === phoneNorm || 
      m.waId?.includes(filters.phone) || m.phone?.includes(filters.phone));
  }
  
  // Filtrar por fecha inicio
  if (filters.from) {
    const fromDate = new Date(filters.from);
    results = results.filter(m => new Date(m.timestamp) >= fromDate);
  }
  
  // Filtrar por fecha fin
  if (filters.to) {
    const toDate = new Date(filters.to);
    toDate.setHours(23, 59, 59, 999);
    results = results.filter(m => new Date(m.timestamp) <= toDate);
  }
  
  // Filtrar por texto
  if (filters.text) {
    const search = filters.text.toLowerCase();
    results = results.filter(m => m.text?.toLowerCase().includes(search));
  }
  
  return results.slice(-500); // Max 500 resultados
}

function addPendingQuote(session) {
  const profile=getProfile(session.waId);
  const quote = { waId:session.waId, phone:profile.phone||session.waId, name:profile.name||"", lid:profile.lid||null, producto:session.producto, precio:session.precio, codigo:session.codigo, foto_url:session.foto_url, talla_color:session.talla_color, created_at:new Date().toISOString() };
  pendingQuotes.set(session.waId,quote); io.emit("new_pending",quote);
  // Enviar notificación
  sendPushoverAlert("PRODUCTO_CATALOGO", quote);
}

function parseWebMessage(text) {
  if(!text.includes("interesado")||!text.includes("producto"))return null;
  const result={producto:null,precio:null,codigo:null,foto_url:null,talla:null,color:null,tamano:null,producto_url:null};
  
  // Extraer nombre del producto (después de "producto:" hasta el salto de línea o "Precio:")
  const productoMatch=text.match(/producto:\s*([^\n]+?)(?:\s*Precio:|$)/i); 
  if(productoMatch)result.producto=productoMatch[1].trim();
  
  // Extraer precio (puede tener formato "₡8 175" o "₡8175" o con "(con X% OFF)")
  const precioMatch=text.match(/Precio:\s*[₡¢]?\s*([\d\s,\.]+)/i); 
  if(precioMatch)result.precio=parseInt(precioMatch[1].replace(/[\s,\.]/g,''))||0;
  
  // Extraer código
  const codigoMatch=text.match(/Código:\s*(\d+)/i); 
  if(codigoMatch)result.codigo=codigoMatch[1].trim();
  
  // Extraer URL del producto
  const urlMatch=text.match(/(https?:\/\/[^\s]+producto[^\s]*)/i);
  if(urlMatch)result.producto_url=urlMatch[1];
  
  // Extraer ID de la URL si no tenemos código
  if(!result.codigo && result.producto_url){
    const idMatch=result.producto_url.match(/[?&]id=(\d+)/i);
    if(idMatch)result.codigo=idMatch[1];
  }
  
  // Construir URL de imagen basada en el código
  if(result.codigo){
    // ✅ Ruta correcta: /lavaca/img/CODIGO.webp
    result.foto_url=`${CATALOG_URL}/lavaca/img/${result.codigo}.webp`;
  }
  
  // Extraer talla
  const tallaMatch=text.match(/Talla:\s*([^\s\n]+)/i); 
  if(tallaMatch)result.talla=tallaMatch[1].trim();
  
  // Extraer color
  const colorMatch=text.match(/Color:\s*([^\n]+)/i); 
  if(colorMatch)result.color=colorMatch[1].trim();
  
  // Extraer tamaño
  const tamanoMatch=text.match(/Tamaño:\s*([^\n]+)/i); 
  if(tamanoMatch)result.tamano=tamanoMatch[1].trim();
  
  console.log("📋 parseWebMessage:", JSON.stringify(result));
  return result;
}

// ============ BAILEYS CONEXIÓN ============
async function connectWhatsApp() {
  connectionStatus="connecting"; io.emit("connection_status",{status:connectionStatus});
  if(!fs.existsSync(AUTH_FOLDER))fs.mkdirSync(AUTH_FOLDER,{recursive:true});
  const{state,saveCreds}=await useMultiFileAuthState(AUTH_FOLDER);
  const{version}=await fetchLatestBaileysVersion();
  sock=makeWASocket({version,auth:{creds:state.creds,keys:makeCacheableSignalKeyStore(state.keys,logger)},logger,printQRInTerminal:false,browser:["TICObot","Chrome","1.0.0"],syncFullHistory:false,shouldIgnoreJid:(jid)=>jid?.endsWith("@g.us")||jid?.endsWith("@broadcast"),keepAliveIntervalMs:20000,connectTimeoutMs:120000,defaultQueryTimeoutMs:120000,retryRequestDelayMs:500,markOnlineOnConnect:false,emitOwnEvents:true,generateHighQualityLinkPreview:false});

  sock.ev.on("connection.update",async(update)=>{
    const{connection,lastDisconnect,qr}=update;
    if(qr){qrCode=await QRCode.toDataURL(qr);connectionStatus="qr";io.emit("qr_code",{qr:qrCode});io.emit("connection_status",{status:connectionStatus});console.log("📱 QR listo");}
    if(connection==="close"){
      const reason=lastDisconnect?.error?.output?.statusCode;
      console.log(`❌ Desconectado: código=${reason}`);
      connectionStatus="disconnected";qrCode=null;connectedPhone="";
      if(global._keepAliveInterval){clearInterval(global._keepAliveInterval);global._keepAliveInterval=null;}
      io.emit("connection_status",{status:connectionStatus});
      if(reason===DisconnectReason.loggedOut){try{fs.rmSync(AUTH_FOLDER,{recursive:true,force:true});}catch(e){}setTimeout(connectWhatsApp,5000);}
      else if(reason===428||reason===408){const delay=Math.min(15000+(reconnectAttempts*5000),60000);reconnectAttempts++;setTimeout(connectWhatsApp,delay);}
      else if(reason===515||reason===503){setTimeout(connectWhatsApp,5000);}
      else{const delay=Math.min(3000*Math.pow(1.5,reconnectAttempts),60000);reconnectAttempts++;setTimeout(connectWhatsApp,delay);}
    }
    if(connection==="open"){
      connectionStatus="connected";qrCode=null;reconnectAttempts=0;connectedPhone=sock.user?.id?.split(":")[0]||"";
      io.emit("connection_status",{status:connectionStatus,phone:connectedPhone});console.log("✅ Conectado:",connectedPhone);
      if(global._keepAliveInterval)clearInterval(global._keepAliveInterval);
      global._keepAliveInterval=setInterval(async()=>{try{if(sock&&connectionStatus==="connected")await sock.sendPresenceUpdate("available");}catch(e){}},4*60*1000);
    }
  });

  sock.ev.on("creds.update",saveCreds);

  sock.ev.on("contacts.upsert",(contacts)=>{
    for(const c of contacts){
      if(c.id?.endsWith("@lid")&&c.phoneNumber){
        const lid=fromJid(c.id);const phone=c.phoneNumber.replace(/[^\d]/g,"");
        if(phone.length>=8){lidPhoneMap.set(lid,phone);if(profiles.has(lid)){const p=profiles.get(lid);p.phone=phone;if((c.notify||c.name)&&!p.name)p.name=c.notify||c.name;}}
      }
      const cId=fromJid(c.id||"");if(cId&&profiles.has(cId)&&(c.notify||c.name)){const p=profiles.get(cId);if(!p.name)p.name=c.notify||c.name;}
    }
    saveLidMap();
  });

  sock.ev.on("contacts.update",(updates)=>{
    for(const u of updates){
      if(u.id?.endsWith("@lid")&&u.phoneNumber){
        const lid=fromJid(u.id);const phone=u.phoneNumber.replace(/[^\d]/g,"");
        if(phone.length>=8)lidPhoneMap.set(lid,phone);
      }
    }
    saveLidMap();
  });

  try{sock.ev.on("lid-mapping.update",(mapping)=>{const items=Array.isArray(mapping)?mapping:[mapping];for(const m of items){if(m.lid&&m.pn){const lid=fromJid(m.lid);const phone=fromJid(m.pn);lidPhoneMap.set(lid,phone);if(profiles.has(lid)&&!profiles.has(phone)){const old=profiles.get(lid);old.phone=phone;profiles.set(phone,old);}}}saveLidMap();});}catch(e){}

  sock.ev.on("messages.upsert",async({messages,type})=>{
    if(type!=="notify")return;
    for(const msg of messages){if(msg.key.fromMe||msg.key.remoteJid?.endsWith("@g.us"))continue;messageQueue.push(msg);processQueue();}
  });
}

async function processQueue(){if(isProcessingQueue||messageQueue.length===0)return;isProcessingQueue=true;while(messageQueue.length>0){const msg=messageQueue.shift();try{await handleIncomingMessage(msg);}catch(e){console.log("❌ Error:",e.message);}}isProcessingQueue=false;}

async function sendTextWithTyping(waId, text) {
  if(!sock||connectionStatus!=="connected")return false;
  try{
    const jid=jidMap.get(normalizePhone(waId))||toJid(waId);
    const delay=getHumanDelay();
    console.log(`⏳ Esperando ${Math.round(delay/1000)}s...`);
    await sock.sendPresenceUpdate("composing",jid); await sleep(delay); await sock.sendPresenceUpdate("paused",jid);
    await sock.sendMessage(jid,{text});
    addToChatHistory(waId,"out",text); account.metrics.mensajes_enviados+=1;
    console.log(`📤 ${formatPhone(waId)}: ${text.slice(0,50)}...`);
    return true;
  }catch(e){console.log("❌ Error envío:",e.message);return false;}
}

async function sendTextDirect(waId, text) {
  if(!sock||connectionStatus!=="connected")return false;
  try{const jid=jidMap.get(normalizePhone(waId))||toJid(waId);await sock.sendPresenceUpdate("composing",jid);await sleep(2000);await sock.sendPresenceUpdate("paused",jid);await sock.sendMessage(jid,{text});addToChatHistory(waId,"out",text);account.metrics.mensajes_enviados+=1;return true;}catch(e){return false;}
}

async function postStatus(imageBuffer,caption=""){if(!sock||connectionStatus!=="connected")return{success:false,message:"No conectado"};try{await sock.sendMessage("status@broadcast",{image:imageBuffer,caption});account.metrics.estados_sent+=1;saveDataToDisk();return{success:true,message:"Estado publicado"};}catch(e){return{success:false,message:e.message};}}
async function postStatusText(text){if(!sock||connectionStatus!=="connected")return{success:false,message:"No conectado"};try{await sock.sendMessage("status@broadcast",{text});account.metrics.estados_sent+=1;saveDataToDisk();return{success:true,message:"Estado publicado"};}catch(e){return{success:false,message:e.message};}}

// ============ HANDLER MENSAJES (CON IA CLASIFICADORA) ============
async function handleIncomingMessage(msg) {
  const remoteJid=msg.key.remoteJid; const isLid=remoteJid?.endsWith("@lid"); const lidId=isLid?fromJid(remoteJid):null;
  const senderPn=msg.key.senderPn||msg.key.senderPnAlt||null; const pushName=msg.pushName||"";
  let waId, realPhone=null;
  if(senderPn){realPhone=fromJid(senderPn);waId=realPhone;if(lidId){lidPhoneMap.set(lidId,realPhone);saveLidMap();}}
  else if(isLid&&lidPhoneMap.has(lidId)){realPhone=lidPhoneMap.get(lidId);waId=realPhone;}
  else if(isLid){try{const pn=await sock.signalRepository?.lidMapping?.getPNForLID?.(remoteJid);if(pn){realPhone=fromJid(pn);waId=realPhone;lidPhoneMap.set(lidId,realPhone);saveLidMap();}else{waId=lidId;}}catch(e){waId=lidId;}}
  else{waId=fromJid(remoteJid);realPhone=waId;}

  jidMap.set(normalizePhone(waId),remoteJid);
  const session=getSession(waId); session.replyJid=remoteJid; if(isLid)session.lid=lidId;
  const profile=getProfile(waId);
  if(pushName&&!profile.name)profile.name=pushName; if(realPhone)profile.phone=realPhone; if(lidId)profile.lid=lidId;

  let text="";
  const hasImage = !!msg.message?.imageMessage;
  let imageBase64 = null;
  
  if(msg.message?.conversation)text=msg.message.conversation;
  else if(msg.message?.extendedTextMessage?.text)text=msg.message.extendedTextMessage.text;
  else if(msg.message?.imageMessage?.caption)text=msg.message.imageMessage.caption;

  // Descargar imagen si existe
  if(hasImage){
    try {
      const stream = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      if(stream){
        imageBase64 = stream.toString('base64');
        console.log(`📷 Imagen descargada: ${Math.round(stream.length/1024)}KB`);
      }
    } catch(e) { console.log("⚠️ Error descargando imagen:", e.message); }
  }

  const displayPhone=realPhone?formatPhone(realPhone):waId;
  addToChatHistory(waId,"in",text||(hasImage?"(foto)":"(mensaje)"), imageBase64);
  console.log(`📥 ${displayPhone}: ${text||(hasImage?"(foto)":"(mensaje)")}`);

  if(profile.blocked)return;
  if(botPaused){console.log("⏸️ Bot pausado");return;}

  // FIX 1: Expirar sesiones (2 horas)
  if(session.state!=="NEW"&&(Date.now()-session.last_activity)>SESSION_TIMEOUT){
    console.log(`⏰ Sesión expirada: ${displayPhone} (${session.state})`);
    resetSession(session);
  }
  account.metrics.chats_total+=1;

  // FIX 2: Nocturno dedup (8 horas)
  if(!isStoreOpen()){
    const NOCTURNO_COOLDOWN=8*60*60*1000;
    if(session.nocturno_sent_at&&(Date.now()-session.nocturno_sent_at)<NOCTURNO_COOLDOWN){console.log(`🌙 Nocturno ya enviado`);return;}
    session.nocturno_sent_at=Date.now();
    await sendTextWithTyping(waId,frase("nocturno",waId));return;
  }

  // ✅ FOTO DIRECTA (no del catálogo web) - Pedir detalles antes de pasar al dueño
  // Detectar incluso si NO está en NEW (nueva consulta con foto)
  console.log(`🔍 Check foto: hasImage=${hasImage}, state=${session.state}`);
  if(hasImage){
    const webData = parseWebMessage(text);
    console.log(`🔍 webData: ${webData ? JSON.stringify(webData) : 'null'}`);
    // Si NO es mensaje estructurado del catálogo ("Me interesa")
    if(!webData || !webData.codigo){
      // Si está en NEW o en estados donde puede empezar nueva consulta con foto
      const estadosPermitidos = ["NEW", "PREGUNTANDO_ALGO_MAS", "VENTA_COMPLETADA", "ESPERANDO_CONFIRMACION_VENDEDOR"];
      if(estadosPermitidos.includes(session.state)){
        
        // ✅ GUARDAR IMAGEN INMEDIATAMENTE como archivo (no en sesión)
        let fotoUrl = null;
        if(imageBase64){
          fotoUrl = await guardarImagenFoto(waId, imageBase64);
          console.log(`📷 Imagen guardada inmediatamente: ${fotoUrl}`);
        }
        
        // Detectar si el texto ya incluye talla/color/tamaño
        const textoDetalle = text?.trim() || "";
        const regexDetalles = /\b(xs|s|m|l|xl|xxl|xxxl|small|medium|large|extra\s*large|chico|mediano|grande|talla\s*\d+|\d{1,2}|rojo|azul|negro|blanco|rosado|rosa|verde|amarillo|morado|gris|beige|café|cafe|naranja|celeste|lila|fucsia|coral|vino|crema|dorado|plateado|turquesa)\b/i;
        const tieneDetalles = regexDetalles.test(textoDetalle);
        
        console.log(`📷 Foto externa - texto: "${textoDetalle}", tieneDetalles: ${tieneDetalles}`);
        
        session.foto_externa = true;
        session.foto_url_guardada = fotoUrl; // Guardar URL, no base64
        session.saludo_enviado = true;
        
        if(tieneDetalles){
          // CASO 3: Foto + texto CON detalles → Directo al dueño
          session.talla_color = textoDetalle;
          session.producto = "Producto de foto";
          session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
          
          const quote = {
            waId,
            phone: profile.phone || waId,
            name: profile.name || "",
            producto: "📷 Producto de foto",
            precio: null,
            codigo: null,
            foto_url: fotoUrl,
            talla_color: session.talla_color,
            foto_externa: true,
            created_at: new Date().toISOString()
          };
          pendingQuotes.set(waId, quote);
          console.log(`📷 *** EMITIENDO new_pending (con detalles) ***`);
          io.emit("new_pending", quote);
          // Enviar notificación
          sendPushoverAlert("PRODUCTO_FOTO", quote);
          
          saveDataToDisk();
          
          await sendTextWithTyping(waId, 
            `¡Hola! Pura vida 🙌\n\n` +
            `Perfecto, déjame revisar si tenemos disponible. Un momento... 👕`
          );
          return;
        } else {
          // CASO 1 y 2: Foto sola o Foto + texto sin detalles → Preguntar
          session.state = "ESPERANDO_DETALLES_FOTO";
          saveDataToDisk();
          console.log(`📷 Esperando detalles, foto guardada en: ${fotoUrl}`);
          await sendTextWithTyping(waId,
            `¡Hola! Pura vida 🙌 Dejame revisar ese producto.\n\n` +
            `¿Qué talla, color o tamaño te interesa? 👕`
          );
          return;
        }
      }
    }
  }

  // ✅ Estado: Esperando detalles de foto externa
  if(session.state === "ESPERANDO_DETALLES_FOTO"){
    if(text.trim().length < 1){
      await sendTextWithTyping(waId,"¿Qué talla, color o tamaño te interesa? 👕");
      return;
    }
    session.talla_color = text.trim();
    session.producto = "Producto de foto";
    session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
    
    console.log(`📷 ESPERANDO_DETALLES_FOTO - talla_color: ${session.talla_color}`);
    console.log(`📷 foto_url_guardada: ${session.foto_url_guardada || 'NO DISPONIBLE'}`);
    
    // Notificar al dueño con la foto (ya guardada como archivo)
    const quote = {
      waId,
      phone: profile.phone || waId,
      name: profile.name || "",
      producto: "📷 Producto de foto",
      precio: null,
      codigo: null,
      foto_url: session.foto_url_guardada || null,
      talla_color: session.talla_color,
      foto_externa: true,
      created_at: new Date().toISOString()
    };
    pendingQuotes.set(waId, quote);
    console.log(`📷 *** EMITIENDO new_pending ***`);
    console.log(`📷 Quote: ${JSON.stringify(quote)}`);
    console.log(`📷 Sockets conectados: ${io.engine.clientsCount}`);
    io.emit("new_pending", quote);
    console.log(`📷 *** EMITIDO! ***`);
    // Enviar notificación
    sendPushoverAlert("PRODUCTO_FOTO", quote);
    
    saveDataToDisk();
    
    await sendTextWithTyping(waId, frase("revisando", waId));
    return;
  }

  // Detectar mensaje web ("Me interesa")
  const webData=parseWebMessage(text);
  if(webData&&webData.codigo){
    // ✅ Detectar si pregunta por otro color/talla diferente al del catálogo
    const preguntaOtro = /(?:tienen|hay|viene|está|esta|tendrán|tendran|lo tienen|la tienen|tienen en|hay en|viene en|otro|otra)\s*(?:en\s+)?(?:color|talla|tamaño|tamano)?\s*(?:en\s+)?(rojo|azul|negro|blanco|rosado|rosa|verde|amarillo|morado|gris|beige|café|cafe|naranja|celeste|lila|fucsia|coral|vino|s|m|l|xl|xxl|xs|small|medium|large|\d+)/i.test(text);
    
    if(preguntaOtro){
      session.saludo_enviado = true;
      saveDataToDisk();
      await sendTextWithTyping(waId,
        `¡Hola! Pura vida 🙌\n\n` +
        `De momento solo ofrecemos lo que está disponible en el catálogo.\n\n` +
        `Si te interesa el producto como aparece, con gusto te confirmo disponibilidad 😊\n\n` +
        `${CATALOG_URL}`
      );
      return;
    }
    
    // ✅ Descargar imagen full quality del catálogo localmente
    let fotoLocal = null;
    if(webData.codigo){
      fotoLocal = await descargarImagenCatalogo(webData.codigo, waId);
    }
    if(!fotoLocal && msg.message?.extendedTextMessage?.jpegThumbnail){
      const thumbBase64 = Buffer.from(msg.message.extendedTextMessage.jpegThumbnail).toString('base64');
      fotoLocal = await guardarImagenFoto(waId, thumbBase64);
      console.log(`🔗 Thumbnail guardado como fallback: ${fotoLocal}`);
    }
    
    session.producto=webData.producto; session.precio=webData.precio; session.codigo=webData.codigo; session.foto_url=fotoLocal || webData.foto_url;
    let detalles=[];
    if(webData.talla)detalles.push(`Talla: ${webData.talla}`);
    if(webData.color)detalles.push(`Color: ${webData.color}`);
    if(webData.tamano)detalles.push(`Tamaño: ${webData.tamano}`);
    let resumenProducto=`📦 *${webData.producto||'Producto'}*`;
    if(webData.precio)resumenProducto+=`\n💰 ₡${webData.precio.toLocaleString()}`;
    if(detalles.length>0)resumenProducto+=`\n👕 ${detalles.join(", ")}`;
    if(detalles.length>0){
      session.talla_color=detalles.join(", "); session.state="ESPERANDO_CONFIRMACION_VENDEDOR";
      await sendTextWithTyping(waId,`${frase("saludo_interes",waId)}\n\n${resumenProducto}`);
      addPendingQuote(session); return;
    }
    session.state="ESPERANDO_TALLA";
    await sendTextWithTyping(waId,`¡Hola! Pura vida 🙌 Vi que te interesa:\n\n${resumenProducto}\n\n${frase("pedir_talla",waId)}`);
    return;
  }

  // Normalizar 1/2 a si/no
  const numResp=text.trim();
  if(numResp==="1")text="si"; if(numResp==="2")text="no";
  const lower=norm(text);

  // ============ IA: Detectar interrupciones en medio del flujo ============
  if(session.state!=="NEW"&&session.state!=="PREGUNTANDO_ALGO_MAS"){
    const estadosConRespuesta=["ESPERANDO_DETALLES_FOTO","ESPERANDO_TALLA","PREGUNTANDO_INTERES","PREGUNTANDO_METODO","ESPERANDO_UBICACION_ENVIO","PRECIO_TOTAL_ENVIADO","ESPERANDO_SINPE","ESPERANDO_DATOS_ENVIO","CONFIRMANDO_DATOS_ENVIO"];
    if(estadosConRespuesta.includes(session.state)){
      const stateDesc=getStateDescription(session.state);
      const classification=await classifyMessage(text,session.state,stateDesc);
      
      if(classification==="FAQ"){
        const aiResp=await askAI(text);
        const recordatorio=FRASES.recordatorio_flujo[session.state]||"";
        if(aiResp){await sendTextWithTyping(waId,recordatorio?`${aiResp}\n\n${recordatorio}`:aiResp);}
        else{await sendTextWithTyping(waId,"Si tenés alguna duda, podés llamarnos al 2237-3335 🙌"+(recordatorio?`\n\n${recordatorio}`:""));}
        return;
      }
      if(classification==="NUEVO_PRODUCTO"){
        const recordatorio=FRASES.recordatorio_flujo[session.state]||"";
        await sendTextWithTyping(waId,`${frase("primero_terminemos",waId)}${recordatorio?`\n\n${recordatorio}`:""}`);
        return;
      }
      if(classification==="OTRO"){
        const aiResp=await askAI(text);
        const recordatorio=FRASES.recordatorio_flujo[session.state]||"";
        if(aiResp){await sendTextWithTyping(waId,`${aiResp}${recordatorio?`\n\n${recordatorio}`:""}`);}
        else{await sendTextWithTyping(waId,recordatorio||frase("espera_vendedor",waId));}
        return;
      }
      // RESPUESTA_FLUJO → continuar normalmente
    }
  }

  // ✅ Detectar preguntas sobre envío en cualquier estado de venta activa
  const ESTADOS_VENTA_ACTIVA = ["PREGUNTANDO_INTERES","PREGUNTANDO_METODO","ESPERANDO_TALLA","ESPERANDO_CONFIRMACION_VENDEDOR","PRECIO_TOTAL_ENVIADO","ESPERANDO_UBICACION_ENVIO","ESPERANDO_DATOS_ENVIO","CONFIRMANDO_DATOS_ENVIO"];
  const regexPreguntaEnvio = /(?:hac[eé]n?\s*env[ií]o|costo\s*(?:de[l]?\s*)?env[ií]o|cu[áa]nto\s*(?:cuesta|sale|cobra|es)\s*(?:el\s*)?env[ií]o|env[ií]an?\s*a\s+\w|mandan?\s*a\s+\w|llega\s*a\s+\w|env[ií]os?\s*a\s+\w)/i;
  
  if(ESTADOS_VENTA_ACTIVA.includes(session.state) && regexPreguntaEnvio.test(text)){
    const zonaMatch = text.match(/(?:a|en|para|hacia)\s+(san\s*jos[ée]|heredia|alajuela|cartago|puntarenas|lim[oó]n|guanacaste|gam|[a-záéíóú\s]{3,20}?)(?:\s*[?,.]|$)/i);
    const zonaTexto = zonaMatch ? zonaMatch[1].trim() : null;
    
    let respEnvio = `¡Claro! Sí hacemos envíos a todo el país con Correos de Costa Rica 📦\n\n` +
      `🏙️ GAM (área metropolitana): ₡2,500\n` +
      `🌄 Fuera de GAM: ₡3,500\n` +
      `🕐 Tarda entre 4-5 días hábiles en llegar\n`;
    
    const tieneSi = /\bsi\b|sí|quiero|dale|claro|por\s*fa|me\s*interesa/i.test(text);
    
    if(session.state === "PREGUNTANDO_INTERES" && tieneSi){
      account.metrics.intent_yes+=1;
      session.state="PREGUNTANDO_METODO";
      respEnvio += `\nPara calcular el monto exacto ocupo tus datos de envío 😊\n\n${frase("pedir_metodo",waId)}`;
    } else if(session.state === "PREGUNTANDO_INTERES"){
      respEnvio += `\nEntonces, ¿te interesa adquirir la prenda? 😊\n\n1. ✅ Sí, quiero\n2. ❌ No, gracias`;
    } else {
      const recordatorio = FRASES.recordatorio_flujo[session.state] || "";
      if(recordatorio) respEnvio += `\n${recordatorio}`;
    }
    
    await sendTextWithTyping(waId, respEnvio);
    saveDataToDisk();
    return;
  }

  // ============ MÁQUINA DE ESTADOS ============

  if(session.state==="ESPERANDO_TALLA"){
    session.talla_color=text.trim(); session.state="ESPERANDO_CONFIRMACION_VENDEDOR";
    await sendTextWithTyping(waId,frase("revisando",waId)); addPendingQuote(session); return;
  }

  if(session.state==="ESPERANDO_CONFIRMACION_VENDEDOR"){await sendTextWithTyping(waId,frase("espera_vendedor",waId));return;}

  if(session.state==="PREGUNTANDO_INTERES"){
    if(lower==="si"||lower==="sí"||lower.includes("quiero")||lower.includes("interesa")){
      account.metrics.intent_yes+=1; session.state="PREGUNTANDO_METODO";
      await sendTextWithTyping(waId,`${frase("confirmacion",waId)}\n\n${frase("pedir_metodo",waId)}`);
      saveDataToDisk();return;
    }
    if(lower==="no"||lower.includes("no me")){
      account.metrics.intent_no+=1; session.state="PREGUNTANDO_ALGO_MAS";
      await sendTextWithTyping(waId,frase("no_quiere",waId));
      saveDataToDisk();return;
    }
    await sendTextWithTyping(waId,"¿Te interesa adquirir la prenda? 😊\n\n1. ✅ Sí\n2. ❌ No\n\nResponde con el número 👆");return;
  }

  if(session.state==="PREGUNTANDO_ALGO_MAS"){
    if(lower==="no"||lower.includes("nada")||lower.includes("eso es todo")){
      await sendTextWithTyping(waId,frase("despedida",waId)); resetSession(session); saveDataToDisk(); return;
    }
    if(lower==="si"||lower==="sí"){
      session.state="NEW"; session.catalogo_enviado=false;
      await sendTextWithTyping(waId,`¡Con gusto! 🙌 ${frase("catalogo",waId)}\n\n${CATALOG_URL}`);
      session.catalogo_enviado=true; saveDataToDisk(); return;
    }
    resetSession(session);
    // Caerá en la lógica de NEW abajo
  }

  if(session.state==="PREGUNTANDO_METODO"){
    if(lower.includes("envio")||lower.includes("envío")||lower==="si"||lower==="1"){
      session.delivery_method="envio"; account.metrics.delivery_envio+=1;
      session.state="ESPERANDO_UBICACION_ENVIO";
      await sendTextWithTyping(waId,"¡Claro! 📦 Para calcularte el costo del envío necesito tu ubicación.\n\nEscribí tu *Provincia - Cantón - Distrito* 📍\n(Ej: Heredia - Central - Mercedes)");
      saveDataToDisk();return;
    }
    if(lower.includes("recoger")||lower.includes("tienda")||lower==="no"||lower==="2"){
      session.delivery_method="recoger"; session.state="PRECIO_TOTAL_ENVIADO"; account.metrics.delivery_recoger+=1;
      const price=session.precio||0;
      await sendTextWithTyping(waId,`📦 ${session.producto||'Artículo'}\n👕 ${session.talla_color||'-'}\n💰 Precio: ₡${price.toLocaleString()}\n\n🏪 Retiro en tienda:\n📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}\n\n¿Estás de acuerdo?\n\n1. ✅ Sí\n2. ❌ No\n\nResponde con el número 👆`);
      saveDataToDisk();return;
    }
    await sendTextWithTyping(waId,frase("pedir_metodo",waId));return;
  }

  // PRE-PAGO: Provincia-Cantón-Distrito en 1 sola pregunta
  if(session.state==="ESPERANDO_UBICACION_ENVIO"){
    if(text.trim().length < 5){
      await sendTextWithTyping(waId,"Ocupo tu ubicación 📍\n\nEscribí tu *Provincia - Cantón - Distrito*\n(Ej: Heredia - Central - Mercedes)");
      return;
    }
    const partes = text.split(/[-,\/]/).map(p => p.trim()).filter(p => p.length > 0);
    if(partes.length >= 3){
      session.envio_provincia = partes[0];
      session.envio_canton = partes[1];
      session.envio_distrito = partes[2];
    } else {
      session.envio_provincia = text.trim();
      session.envio_canton = "";
      session.envio_distrito = "";
    }
    session.client_zone = text.trim();
    session.state = "ZONA_RECIBIDA";
    
    console.log(`📍 Zona recibida de ${waId}: ${session.client_zone}`);
    io.emit("zone_received",{waId, zone:session.client_zone, producto:session.producto, codigo:session.codigo, precio:session.precio, talla_color:session.talla_color, foto_url:session.foto_url, provincia:session.envio_provincia, canton:session.envio_canton, distrito:session.envio_distrito});
    sendPushoverAlert("ZONA", {waId, zone:session.client_zone, phone:profile.phone||waId});
    await sendTextWithTyping(waId,frase("espera_zona",waId));
    saveDataToDisk();return;
  }

  if(session.state==="ZONA_RECIBIDA"){await sendTextWithTyping(waId,"Estoy calculando el envío, un momento 🙌");return;}

  if(session.state==="PRECIO_TOTAL_ENVIADO"){
    if(lower==="si"||lower==="sí"||lower.includes("acuerdo")||lower.includes("dale")){
      const price=session.precio||0; const shipping=session.delivery_method==="envio"?(session.shipping_cost||0):0; const total=price+shipping;
      session.sinpe_reference=waId.slice(-4)+Date.now().toString(36).slice(-4).toUpperCase();
      await sendTextWithTyping(waId,`${frase("confirmacion",waId)}\n\n💰 Total: ₡${total.toLocaleString()}\n\nPara completar tu compra, hacé el SINPE:\n\n📱 SINPE: ${SINPE_NUMBER}\n👤 A nombre de: ${SINPE_NAME}\n📝 En referencia escribí tu nombre\n\nCuando pagues, mandame el comprobante 🧾📸`);
      session.state="ESPERANDO_SINPE";
      io.emit("sale_pending",{waId,phone:profile.phone||waId,name:profile.name||"",total,reference:session.sinpe_reference,method:session.delivery_method,producto:session.producto,talla:session.talla_color});
      saveDataToDisk();return;
    }
    if(lower==="no"||lower.includes("no")){
      session.state="PREGUNTANDO_ALGO_MAS"; await sendTextWithTyping(waId,frase("no_quiere",waId)); saveDataToDisk();return;
    }
    return;
  }

  if(session.state==="ESPERANDO_SINPE"){
    if(msg.message?.imageMessage){
      await sendTextWithTyping(waId,"¡Recibí tu comprobante! 🙌 Dame un chance, estoy confirmando el pago...");
      io.emit("sinpe_received",{waId,reference:session.sinpe_reference,phone:profile.phone||waId,name:profile.name||"",producto:session.producto,talla:session.talla_color,method:session.delivery_method,foto_url:session.foto_url});
      sendPushoverAlert("SINPE", {waId, reference:session.sinpe_reference, phone:profile.phone||waId});
      return;
    }
    if(lower.includes("pague")||lower.includes("listo")||lower.includes("ya")||lower.includes("sinpe")||lower.includes("transferi")){
      await sendTextWithTyping(waId,"Mandame la foto del comprobante 🧾📸");
    }else{
      await sendTextWithTyping(waId,"Dame un chance, estoy esperando tu comprobante de SINPE 🧾");
    }
    return;
  }

  // POST-PAGO: Nombre, Teléfono, Provincia, Cantón, Distrito, Señas en 1 sola pregunta
  if(session.state==="ESPERANDO_DATOS_ENVIO"){
    const lineas = text.split(/[,\n]/).map(l => l.trim()).filter(l => l.length > 0);
    
    if(lineas.length < 6){
      await sendTextWithTyping(waId,"Ocupo los 6 datos para el envío 📦\n\nEscribí separado por comas:\n*Nombre, Teléfono, Provincia, Cantón, Distrito, Señas*\n\n(Ej: María López, 88881234, Heredia, Central, Mercedes, frente a la iglesia)");
      return;
    }
    
    session.envio_nombre = lineas[0];
    const tel = lineas[1].replace(/[^\d]/g,"");
    if(tel.length < 8){
      await sendTextWithTyping(waId,"El teléfono no parece válido 📱\n\nEscribí de nuevo los 6 datos separados por comas:\n*Nombre, Teléfono, Provincia, Cantón, Distrito, Señas*");
      return;
    }
    session.envio_telefono = tel;
    session.envio_provincia = lineas[2];
    session.envio_canton = lineas[3];
    session.envio_distrito = lineas[4];
    session.envio_senas = lineas.slice(5).join(", ");
    session.envio_direccion = `${session.envio_provincia}, ${session.envio_canton}, ${session.envio_distrito}. ${session.envio_senas}`;
    session.state = "CONFIRMANDO_DATOS_ENVIO";
    
    const price = session.precio || 0;
    const shipping = session.shipping_cost || 0;
    const total = price + shipping;
    
    await sendTextWithTyping(waId,
      `📋 *RESUMEN FINAL DE TU PEDIDO*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📦 ${session.producto || 'Artículo'}\n` +
      `👕 ${session.talla_color || '-'}\n` +
      `💰 Producto: ₡${price.toLocaleString()}\n` +
      `🚚 Envío: ₡${shipping.toLocaleString()}\n` +
      `💵 *Total: ₡${total.toLocaleString()}*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📍 *DATOS DE ENVÍO*\n` +
      `👤 ${session.envio_nombre}\n` +
      `📱 ${session.envio_telefono}\n` +
      `🏠 ${session.envio_provincia}, ${session.envio_canton}, ${session.envio_distrito}\n` +
      `📝 ${session.envio_senas}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `¿Todo correcto?\n\n1. ✅ Sí, todo bien\n2. ❌ No, quiero corregir`
    );
    saveDataToDisk();return;
  }

  if(session.state==="CONFIRMANDO_DATOS_ENVIO"){
    if(lower==="1"||lower==="si"||lower==="sí"||lower.includes("bien")||lower.includes("correcto")){
      profile.purchases = (profile.purchases||0) + 1;
      
      await sendTextWithTyping(waId,
        `¡Perfecto! 🎉 Tu pedido está confirmado.\n\n` +
        `🚚 Te llega en aproximadamente 8 días hábiles.\n\n` +
        `Te avisamos cuando lo despachemos.\n\n` +
        `¡Muchas gracias por tu compra! 🙌\n¡Pura vida! 🐄`
      );
      
      io.emit("sale_completed",{
        waId,
        phone: profile.phone||waId,
        name: session.envio_nombre || profile.name || "",
        producto: session.producto,
        codigo: session.codigo,
        talla: session.talla_color,
        method: "envio",
        envio_nombre: session.envio_nombre,
        envio_telefono: session.envio_telefono,
        envio_direccion: session.envio_direccion,
        total: (session.precio||0) + (session.shipping_cost||0)
      });
      
      resetSession(session);
      saveDataToDisk();
      return;
    }
    
    if(lower==="2"||lower==="no"||lower.includes("corregir")){
      session.state = "ESPERANDO_DATOS_ENVIO";
      session.envio_nombre = null;
      session.envio_telefono = null;
      session.envio_direccion = null;
      await sendTextWithTyping(waId,"Dale, vamos de nuevo 🙌\n\nEscribí separado por comas:\n*Nombre, Teléfono, Provincia, Cantón, Distrito, Señas*\n\n(Ej: María López, 88881234, Heredia, Central, Mercedes, frente a la iglesia)");
      saveDataToDisk();return;
    }
    
    await sendTextWithTyping(waId,"Por favor respondé:\n\n1. ✅ Sí, todo está bien\n2. ❌ No, quiero corregir");
    return;
  }

  // ============ ESTADO NEW ============

  // ✅ Detectar gracias (simple, no necesita IA)
  if(/gracias/i.test(lower)){
    await sendTextWithTyping(waId,frase("gracias",waId));
    return;
  }

  // ✅ Detectar pregunta de COSTO de envío con zona incluida (ej: "cuánto vale el envío a Puntarenas")
  const envioConZonaMatch = text.match(/(?:cuanto|cuánto|cual|cuál)\s+(?:vale|cuesta|es|sale)\s+(?:el\s+)?(?:envio|envío).*(?:a|para|hacia)\s+(.+)/i);
  if(envioConZonaMatch || (/(?:envio|envío).*(?:a|para)\s+\w+/i.test(lower) && /(?:cuanto|cuánto|precio|costo|vale|cuesta)/i.test(lower))){
    // Extraer la zona del mensaje
    let zona = envioConZonaMatch ? envioConZonaMatch[1].trim() : null;
    if(!zona){
      // Intentar extraer zona de otra forma
      const zonaMatch2 = text.match(/(?:a|para|hacia)\s+([A-Za-záéíóúÁÉÍÓÚñÑ\s]+?)(?:\?|$|,|\.|cuanto|cuánto)/i);
      if(zonaMatch2) zona = zonaMatch2[1].trim();
    }
    
    if(zona && zona.length > 2){
      session.client_zone = zona;
      session.saludo_enviado = true;
      saveDataToDisk();
      
      // Notificar al panel que hay consulta de envío
      io.emit("shipping_inquiry", {
        waId,
        phone: profile.phone || waId,
        name: profile.name || "",
        zone: zona
      });
      
      const saludo = /hola|buenas|buenos|hey|pura vida/i.test(lower) ? "¡Hola! Pura vida 🙌\n\n" : "";
      await sendTextWithTyping(waId,
        `${saludo}¡Sí hacemos envíos a ${zona}! 🚚\n\n` +
        `📦 GAM (área metropolitana): ₡2,500\n` +
        `📦 Fuera de GAM: ₡3,500\n` +
        `⏱️ Tiempo: 4-5 días con Correos de CR\n\n` +
        `Te invito a revisar el catálogo, si te gusta algo estamos para servirte 😊\n\n${CATALOG_URL}`
      );
      session.catalogo_enviado = true;
      saveDataToDisk();
      return;
    }
  }

  // ✅ Detectar pregunta general de si hacen envíos (sin zona específica)
  if(/hacen envios|hacen envíos|envian|envían|hacen entregas|llegan a/i.test(lower) && !/cuanto|cuánto|precio|costo|vale|cuesta/i.test(lower)){
    session.saludo_enviado = true;
    saveDataToDisk();
    const saludo = /hola|buenas|buenos|hey|pura vida/i.test(lower) ? "¡Hola! Pura vida 🙌\n\n" : "";
    await sendTextWithTyping(waId,
      `${saludo}¡Sí, hacemos envíos a todo el país! 🚚\n\n` +
      `📦 GAM (área metropolitana): ₡2,500\n` +
      `📦 Fuera de GAM: ₡3,500\n` +
      `⏱️ Tiempo: 4-5 días con Correos de CR\n\n` +
      `Te invito a revisar el catálogo, si te gusta algo estamos para servirte 😊\n\n${CATALOG_URL}`
    );
    session.catalogo_enviado = true;
    saveDataToDisk();
    return;
  }

  // ✅ Productos que definitivamente NO vendemos (zapatos) → Respuesta directa
  const productosNoVendemos = /zapato|zapatos|tenis|zapatilla|zapatillas|calzado|sandalia|sandalias|tacones|botas/i;
  if(productosNoVendemos.test(lower)){
    session.saludo_enviado = true;
    saveDataToDisk();
    const saludo = /hola|buenas|buenos|hey|pura vida/i.test(lower) ? "¡Hola! Pura vida 🙌\n\n" : "";
    await sendTextWithTyping(waId,
      `${saludo}No vendemos zapatos, solamente ropa para damas, caballeros y niños 👕\n\n` +
      `Nos podés visitar en:\n📍 ${STORE_ADDRESS}\n\n` +
      `Por ahora vendemos en línea por WhatsApp ropa para damas que podés revisar acá:\n🛍️ ${CATALOG_URL}`
    );
    return;
  }

  // ✅ UNIFORMES ESCOLARES → Avisar al usuario (caso especial)
  const productosEscolares = /uniforme|escolar|escolares|escuela|colegio|colegial|kinder/i;
  if(productosEscolares.test(lower)){
    session.saludo_enviado = true;
    session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
    saveDataToDisk();
    
    // Notificar al usuario
    const quote = {
      waId,
      phone: profile.phone || waId,
      name: profile.name || "",
      producto: `🎒 Uniformes: ${text.trim()}`,
      precio: null,
      codigo: null,
      foto_url: null,
      talla_color: null,
      consulta_uniformes: true,
      created_at: new Date().toISOString()
    };
    pendingQuotes.set(waId, quote);
    io.emit("new_pending", quote);
    sendPushoverAlert("PRODUCTO_CATALOGO", quote);
    
    const saludo = /hola|buenas|buenos|hey|pura vida/i.test(lower) ? "¡Hola! Pura vida 🙌\n\n" : "";
    await sendTextWithTyping(waId,
      `${saludo}¡Claro! Dejame consultar sobre uniformes escolares. Un momento... 🎒`
    );
    return;
  }

  // ✅ Productos que manejamos en tienda física (ropa caballeros/niños - NO uniformes)
  const productosEnTiendaFisica = /niño|niña|niños|niñas|hombre|caballero|masculino|ropa de hombre|ropa masculina|pantalon de hombre|camisa de hombre/i;
  if(productosEnTiendaFisica.test(lower)){
    session.saludo_enviado = true;
    saveDataToDisk();
    
    const saludo = /hola|buenas|buenos|hey|pura vida/i.test(lower) ? "¡Hola! Pura vida 🙌\n\n" : "";
    await sendTextWithTyping(waId,
      `${saludo}Esos productos los manejamos en nuestra tienda física 🏪\n\n` +
      `Te invitamos a visitarnos:\n📍 ${STORE_ADDRESS}\n\n` +
      `¡Con gusto te atendemos! 😊`
    );
    return;
  }

  // ✅ Productos desconocidos/diferentes → Avisar al dueño para que decida
  const preguntaPorProducto = /tienen|venden|hay|busco|necesito|consigo|manejan/i;
  const productoDesconocido = /faja|fajas|bolso|bolsos|cartera|carteras|mochila|maletín|accesorio|accesorios|joya|joyas|reloj|relojes|gorra|gorras|sombrero|perfume|cosmetico|maquillaje/i;
  if(preguntaPorProducto.test(lower) && productoDesconocido.test(lower)){
    session.saludo_enviado = true;
    session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
    saveDataToDisk();
    
    // Notificar al dueño para que decida
    const quote = {
      waId,
      phone: profile.phone || waId,
      name: profile.name || "",
      producto: `❓ Consulta: ${text.trim()}`,
      precio: null,
      codigo: null,
      foto_url: null,
      talla_color: null,
      consulta_producto: true,
      created_at: new Date().toISOString()
    };
    pendingQuotes.set(waId, quote);
    io.emit("new_pending", quote);
    sendPushoverAlert("PRODUCTO_CATALOGO", quote);
    
    const saludo = /hola|buenas|buenos|hey|pura vida/i.test(lower) ? "¡Hola! Pura vida 🙌\n\n" : "";
    await sendTextWithTyping(waId,
      `${saludo}Dejame consultar si tenemos ese producto disponible. Un momento... 🔍`
    );
    return;
  }

  // ✅ Si pregunta por productos específicos o catálogo → enviar catálogo
  if(/tienen|hay|busco|quiero ver|necesito|catalogo|productos|que venden|que tienen/i.test(lower)){
    if(!session.saludo_enviado){session.saludo_enviado=true;}
    session.catalogo_enviado=true;saveDataToDisk();
    const saludo = /hola|buenas|buenos|hey|pura vida/i.test(lower) ? "¡Hola! Pura vida 🙌\n\n" : "";
    await sendTextWithTyping(waId,`${saludo}${frase("catalogo",waId)}\n\n${CATALOG_URL}`);
    return;
  }

  // ✅ Para todo lo demás → IA analiza y responde
  const aiResponse = await askAI(text);
  
  if(aiResponse){
    // Detectar si la IA respondió como saludo para marcar la sesión
    if(!session.saludo_enviado && /hola|pura vida|bienvenid|gusto|ayud/i.test(aiResponse)){
      session.saludo_enviado=true;
      saveDataToDisk();
    }
    await sendTextWithTyping(waId, aiResponse);
  }else{
    // Fallback si IA falla
    if(!session.saludo_enviado){
      session.saludo_enviado=true;saveDataToDisk();
      await sendTextWithTyping(waId,frase("saludos",waId));
    }else{
      await sendTextWithTyping(waId,"Si tenés alguna duda, podés llamarnos al 2237-3335 o visitarnos en tienda 🙌");
    }
  }
}

// ============ ACCIONES PANEL ============
async function executeAction(clientWaId, actionType, data = {}) {
  const session = getSession(clientWaId);

  if (actionType === "SI_HAY") {
    session.state = "PREGUNTANDO_INTERES";
    pendingQuotes.delete(clientWaId);
    account.metrics.quotes_sent += 1;
    const price = session.precio || 0;
    await sendTextWithTyping(clientWaId,
      `${frase("si_hay", clientWaId)}\n\n📦 ${session.producto || 'Artículo'}\n👕 ${session.talla_color || '-'}\n💰 ₡${price.toLocaleString()}\n\n${frase("te_interesa", clientWaId)}\n\n1. ✅ Sí, me interesa\n2. ❌ No, gracias\n\nResponde con el número 👆`
    );
    saveDataToDisk();
    io.emit("pending_resolved", { waId: clientWaId });
    return { success: true, message: "Stock confirmado, preguntando interés" };
  }

  if (actionType === "ENVIO") {
    const shipping = Number(data.shipping || 0);
    session.shipping_cost = shipping;
    session.state = "PRECIO_TOTAL_ENVIADO";
    const price = session.precio || 0;
    const total = price + shipping;
    await sendTextWithTyping(clientWaId,
      `📦 ${session.producto || 'Artículo'}\n👕 ${session.talla_color || '-'}\n💰 Producto: ₡${price.toLocaleString()}\n🚚 Envío (${session.client_zone || 'tu zona'}): ₡${shipping.toLocaleString()}\n━━━━━━━━━━━━━━\n💵 *Total: ₡${total.toLocaleString()}*\n\n¿Estás de acuerdo?\n\n1. ✅ Sí\n2. ❌ No\n\nResponde con el número 👆`
    );
    saveDataToDisk();
    return { success: true, message: `Envío ₡${shipping.toLocaleString()} enviado` };
  }

  if (actionType === "NO_HAY") {
    session.state = "PREGUNTANDO_ALGO_MAS";
    await sendTextWithTyping(clientWaId, frase("no_hay", clientWaId) + `\n\n${CATALOG_URL}`);
    pendingQuotes.delete(clientWaId);
    io.emit("pending_resolved", { waId: clientWaId });
    saveDataToDisk();
    return { success: true, message: "No hay enviado" };
  }

  if (actionType === "PAGADO") {
    account.metrics.sinpe_confirmed += 1;
    if (session.delivery_method === "envio") {
      session.state = "ESPERANDO_DATOS_ENVIO";
      await sendTextWithTyping(clientWaId,
        `¡Pago confirmado! 🎉 ¡Muchas gracias!\n\n` +
        `Ahora necesito tus datos para enviarte el paquete 📦\n\n` +
        `Escribí cada dato separado por coma:\n` +
        `*Nombre, Teléfono, Provincia, Cantón, Distrito, Señas*\n\n` +
        `(Ej: María López, 88881234, Heredia, Central, Mercedes, frente a la iglesia)`
      );
      saveDataToDisk();
      return { success: true, message: "Pago confirmado, pidiendo datos de envío" };
    } else {
      session.state = "PAGO_CONFIRMADO";
      const profile = getProfile(clientWaId);
      profile.purchases = (profile.purchases || 0) + 1;
      let msgFin = frase("fin_retiro", clientWaId).replace("{address}", STORE_ADDRESS).replace("{hours}", HOURS_DAY);
      await sendTextWithTyping(clientWaId, msgFin);
      io.emit("sale_completed", { waId: clientWaId, phone: profile.phone || clientWaId, name: profile.name || "", producto: session.producto, method: "recoger" });
      resetSession(session);
      saveDataToDisk();
      return { success: true, message: "Pago confirmado, retiro en tienda" };
    }
  }

  if (actionType === "MENSAJE") {
    const texto = String(data.texto || "").trim();
    if (!texto) return { success: false, message: "Vacío" };
    await sendTextDirect(clientWaId, texto);
    return { success: true, message: "Enviado" };
  }

  if (actionType === "NO_ENVIO_ZONA") {
    const price = session.precio || 0;
    if (offersPickup()) {
      session.delivery_method = "recoger";
      session.state = "PRECIO_TOTAL_ENVIADO";
      account.metrics.delivery_recoger += 1;
      await sendTextWithTyping(clientWaId,
        `No hacemos envíos a ${session.client_zone || "esa zona"} 😔\n\nPero podés recoger en tienda:\n🏪 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}\n\n📦 ${session.producto || 'Artículo'}\n💰 Precio: ₡${price.toLocaleString()}\n\n¿Estás de acuerdo?\n\n1. ✅ Sí\n2. ❌ No\n\nResponde con el número 👆`
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

// ============ SOCKET.IO ============
io.on("connection", (socket) => {
  let authenticated = false;
  socket.on("auth", (pin) => {
    if (pin === PANEL_PIN) {
      authenticated = true;
      socket.emit("auth_success", { storeName: STORE_NAME });
      socket.emit("connection_status", { status: connectionStatus, phone: connectedPhone });
      socket.emit("bot_status", { paused: botPaused });
      if (qrCode) socket.emit("qr_code", { qr: qrCode });
      // Buscar sesiones esperando costo de envío
      const pendingZones = [];
      for(const [wId, s] of sessions.entries()){
        if(s.state === "ZONA_RECIBIDA"){
          pendingZones.push({waId:wId, zone:s.client_zone, producto:s.producto, codigo:s.codigo, precio:s.precio, talla_color:s.talla_color, foto_url:s.foto_url});
        }
      }
      socket.emit("init_data", { pending: Array.from(pendingQuotes.values()), pendingZones, history: fullHistory.slice(-500), contacts: Array.from(profiles.values()), metrics: account.metrics });
    } else socket.emit("auth_error", "PIN incorrecto");
  });
  socket.use((packet, next) => { if (packet[0] === "auth") return next(); if (!authenticated) return next(new Error("No auth")); next(); });
  socket.on("connect_whatsapp", () => { if (connectionStatus === "connected") { socket.emit("connection_status", { status: "connected", phone: connectedPhone }); return; } connectWhatsApp(); });
  socket.on("disconnect_whatsapp", async () => { if (sock) await sock.logout(); sock = null; connectionStatus = "disconnected"; qrCode = null; connectedPhone = ""; io.emit("connection_status", { status: connectionStatus }); });
  socket.on("toggle_bot", () => { botPaused = !botPaused; saveDataToDisk(); io.emit("bot_status", { paused: botPaused }); });
  socket.on("action", async (data) => { const result = await executeAction(data.clientWaId, data.actionType, data.payload || {}); socket.emit("action_result", result); });
  socket.on("post_status", async (data) => { let result; if (data.textOnly && data.text) result = await postStatusText(data.text); else if (data.image) result = await postStatus(Buffer.from(data.image, "base64"), data.caption || ""); else result = { success: false, message: "Sin contenido" }; socket.emit("status_result", result); });
  socket.on("get_contacts", () => { socket.emit("contacts_list", { contacts: Array.from(profiles.values()) }); });
  socket.on("toggle_block", (data) => { if (!data.waId) return; const p = getProfile(data.waId); p.blocked = data.block; saveDataToDisk(); io.emit("contact_updated", { contact: p }); });
  socket.on("add_contact", (data) => { if (!data.waId) return; const p = getProfile(data.waId); if (data.name) p.name = data.name; saveDataToDisk(); io.emit("contact_added", { contact: p }); });
  socket.on("update_contact", (data) => { if (!data.waId) return; const p = getProfile(data.waId); if (data.name !== undefined) p.name = data.name; if (data.blocked !== undefined) p.blocked = data.blocked; saveDataToDisk(); io.emit("contact_updated", { contact: p }); });
  socket.on("delete_contact", (data) => { if (!data.waId) return; profiles.delete(data.waId); saveDataToDisk(); io.emit("contact_deleted", { waId: data.waId }); });
  socket.on("delete_chats", (data) => { if (!data.waId) return; const n = normalizePhone(data.waId); chatHistory = chatHistory.filter(m => m.waId !== n); sessions.delete(n); pendingQuotes.delete(n); saveDataToDisk(); io.emit("chats_deleted", { waId: n }); });
  socket.on("get_metrics", () => { socket.emit("metrics", { metrics: account.metrics }); });
  socket.on("search_history", (filters) => { const results = searchHistory(filters); socket.emit("history_results", { count: results.length, messages: results }); });
});

// ============ ENDPOINTS ============
app.get("/health", (req, res) => res.send("OK"));
app.get("/status", (req, res) => res.json({ connection: connectionStatus, phone: connectedPhone, botPaused, storeOpen: isStoreOpen(), metrics: account.metrics }));
app.get("/api/history", (req, res) => {
  const results = searchHistory({ phone: req.query.phone, from: req.query.from, to: req.query.to, text: req.query.text });
  res.json({ count: results.length, messages: results });
});

// ============ INICIAR ============
server.listen(PORT, () => {
  // Asegurar que /data existe
  if (!fs.existsSync(PERSISTENT_DIR)) { try { fs.mkdirSync(PERSISTENT_DIR, { recursive: true }); } catch(e) { console.log("⚠️ No se pudo crear /data:", e.message); } }
  loadDataFromDisk();
  loadHistory();
  console.log(`
╔═══════════════════════════════════════════════════╗
║  🐄 TICO-bot - La Vaca CR                         ║
╠═══════════════════════════════════════════════════╣
║  🕒 Horario: ${HOURS_DAY.padEnd(36)}║
║  ⏱️ Delay: ${(DELAY_MIN + "-" + DELAY_MAX + " seg").padEnd(37)}║
║  🌐 Catálogo: ${CATALOG_URL.slice(0,33).padEnd(34)}║
║  📱 Panel: http://localhost:${PORT}/                  ║
║  🧠 IA: Clasificador + FAQ + Conversacional       ║
╚═══════════════════════════════════════════════════╝
  `);
  if (fs.existsSync(path.join(AUTH_FOLDER, "creds.json"))) { console.log("🔄 Reconectando..."); connectWhatsApp(); }

  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    setInterval(async () => { try { const res = await fetch(`${RENDER_URL}/health`); console.log(`💓 Self-ping: ${res.status}`); } catch(e) { console.log(`💔 Self-ping falló`); } }, 4 * 60 * 1000);
    console.log(`💓 Self-ping habilitado`);
  }

  setInterval(() => {
    if (connectionStatus === "disconnected" && fs.existsSync(path.join(AUTH_FOLDER, "creds.json"))) { console.log("🐕 Watchdog: reconectando..."); connectWhatsApp(); }
  }, 2 * 60 * 1000);
});
