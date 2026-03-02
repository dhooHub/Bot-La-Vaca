/** ============================================================
 * TICO-bot — La Vaca CR
 * Bot híbrido: primer contacto + FAQ + catálogo → pasa a humano
 * Estados: NEW | ESPERANDO_GENERO | ESPERANDO_CONFIRMACION_VENDEDOR
 * ============================================================ */

'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino    = require('pino');
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const fs      = require('fs');
const path    = require('path');
const fetch   = require('node-fetch');
const QRCode  = require('qrcode');

// ============ CONFIGURACIÓN ============
const PORT          = process.env.PORT        || 10000;
const OPENAI_KEY    = process.env.OPENAI_API_KEY || '';
const PUSHOVER_USER = process.env.PUSHOVER_USER_KEY  || '';
const PUSHOVER_APP  = process.env.PUSHOVER_APP_TOKEN || '';
const CATALOG_URL   = process.env.CATALOG_URL  || 'https://www.lavacacr.com';
const PANEL_URL     = process.env.PANEL_URL    || 'https://tico-bot-lite.onrender.com';
const STORE_NAME    = process.env.STORE_NAME   || 'La Vaca CR';
const STORE_ADDRESS = process.env.STORE_ADDRESS|| 'Heredia centro, 200m sur de Correos de CR';
const MAPS_URL      = process.env.MAPS_URL     || '';
const SINPE_NUMBER  = process.env.SINPE_NUMBER || '';
const SINPE_NAME    = process.env.SINPE_NAME   || '';
const ADMIN_PASSWORD= process.env.ADMIN_PASSWORD || 'admin123';
const USER_PASSWORD = process.env.USER_PASSWORD  || 'user123';
const PANEL_PIN     = process.env.PANEL_PIN      || '0000';
const WARRANTY_DAYS = process.env.WARRANTY_DAYS  || '30';

// Horario
const HOURS_WEEKDAY_START = 9;
const HOURS_WEEKDAY_END   = 19;
const HOURS_SUNDAY_START  = 10;
const HOURS_SUNDAY_END    = 18;
const HOURS_DAY = '9am-7pm L-S, 10am-6pm Dom';

// Delay de tipeo humano
const DELAY_MIN = 5;
const DELAY_MAX = 20;

// Paths de datos
const PERSISTENT_DIR = '/data';
const AUTH_FOLDER    = path.join(PERSISTENT_DIR, 'auth_baileys');
const DATA_FOLDER    = PERSISTENT_DIR;
const HISTORY_FILE   = path.join(PERSISTENT_DIR, 'historial.json');
const LID_MAP_FILE   = path.join(DATA_FOLDER, 'lid_phone_map.json');

// ============ APP / SERVIDOR ============
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
const logger = pino({ level: 'silent' });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-pwd, x-admin-token');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use('/images', express.static(path.join(PERSISTENT_DIR, 'images')));
app.use(express.static(path.join(__dirname, 'public')));

// ============ ESTADO GLOBAL ============
let sock = null, qrCode = null, connectionStatus = 'disconnected';
let reconnectAttempts = 0, connectedPhone = '', botPaused = false;

const sessions     = new Map();
const profiles     = new Map();
const pendingQuotes= new Map();
let   salesLog     = [];
let   alertsLog    = [];
let   quickReplies = [];
let   chatHistory  = [];
let   fullHistory  = [];
let   catalogProducts = [];
let   lastCatalogLoad = 0;
let   crmClients   = new Map();
let   banner = { activo: false, texto: '' };
const jidMap       = new Map();
let   lidPhoneMap  = new Map();
const adminTokens  = new Map();
const messageBuffer= new Map();
const DEBOUNCE_MS  = 800;

const account = {
  metrics: {
    chats_total: 0, mensajes_enviados: 0, ia_calls: 0,
    sales_completed: 0, total_revenue: 0
  }
};

// ============ UTILIDADES ============
function normalizePhone(input) {
  const d = String(input || '').replace(/[^\d]/g, '');
  if (d.length === 8) return '506' + d;
  return d;
}
function toJid(phone)   { return normalizePhone(phone) + '@s.whatsapp.net'; }
function fromJid(jid)   { return jid ? jid.replace(/@.*/, '') : ''; }
function formatPhone(waId) {
  const d = normalizePhone(waId);
  if (d.length === 11 && d.startsWith('506')) return d.slice(3, 7) + '-' + d.slice(7);
  return d;
}
function norm(s = '') {
  return String(s).toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function getCostaRicaTime() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const cr  = new Date(utc - (6 * 60 * 60 * 1000));
  return { hour: cr.getHours(), minute: cr.getMinutes(), day: cr.getDay(), date: cr };
}
function getCostaRicaDayName() {
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  return dias[getCostaRicaTime().day];
}
function isStoreOpen() {
  const { hour, day } = getCostaRicaTime();
  if (day === 0) return hour >= HOURS_SUNDAY_START && hour < HOURS_SUNDAY_END;
  return hour >= HOURS_WEEKDAY_START && hour < HOURS_WEEKDAY_END;
}
function getHumanDelay() {
  return (Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN + 1)) + DELAY_MIN) * 1000;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ SESIONES Y PERFILES ============
function getSession(waId) {
  const id = normalizePhone(waId);
  if (!sessions.has(id)) {
    sessions.set(id, {
      waId: id, state: 'NEW',
      humanMode: false, humanModeManual: false,
      humanModeAt: null, humanModeLastActivity: null,
      // Datos de consulta de producto
      ultimaCategoriaBuscada: null,
      ultimaDescripcionBuscada: null,
      generosPosCat: null,
      // Foto externa
      foto_externa: false, foto_url_guardada: null,
      // Multi-producto
      multi_products: null, multi_total: null,
      // Meta
      saludo_enviado: false,
      last_activity: Date.now()
    });
  }
  const s = sessions.get(id);
  s.last_activity = Date.now();
  return s;
}
function resetSession(session) {
  session.state = 'NEW';
  session.humanMode = false;
  session.humanModeManual = false;
  session.humanModeAt = null;
  session.humanModeLastActivity = null;
  session.ultimaCategoriaBuscada = null;
  session.ultimaDescripcionBuscada = null;
  session.generosPosCat = null;
  session.foto_externa = false;
  session.foto_url_guardada = null;
  session.multi_products = null;
  session.multi_total = null;
  session.saludo_enviado = false;
}
function activateHumanMode(session, waId, manual = false) {
  session.humanMode = true;
  session.humanModeManual = manual;
  session.humanModeAt = Date.now();
  session.humanModeLastActivity = Date.now();
  io.emit('human_mode_changed', { waId: normalizePhone(waId), humanMode: true, manual });
}

function getProfile(waId) {
  const id = normalizePhone(waId);
  if (!profiles.has(id)) {
    profiles.set(id, { waId: id, name: '', phone: id, blocked: false, botDisabled: false, purchases: 0, created_at: new Date().toISOString() });
  }
  return profiles.get(id);
}

// ============ HISTORIAL DE CHAT ============
function addToChatHistory(waId, direction, text, imageBase64 = null) {
  const id  = normalizePhone(waId);
  const p   = getProfile(id);
  const msg = {
    waId: id, phone: formatPhone(id), name: p.name || '',
    direction, text: text || '',
    imageBase64: imageBase64 || null,
    timestamp: new Date().toISOString()
  };
  chatHistory.push(msg);
  if (chatHistory.length > 2000) chatHistory = chatHistory.slice(-2000);
  fullHistory.push(msg);
  if (fullHistory.length > 5000) fullHistory = fullHistory.slice(-3000);
  io.emit('new_message', msg);
}
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
      fullHistory = JSON.parse(data);
      chatHistory = fullHistory.slice(-500);
      console.log(`📖 Historial: ${fullHistory.length} mensajes`);
    }
  } catch(e) { console.log('⚠️ Error cargando historial:', e.message); }
}
function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(fullHistory)); } catch(e) {}
}
setInterval(saveHistory, 5 * 60 * 1000);

// ============ PERSISTENCIA ============
function saveDataToDisk() {
  try {
    if (!fs.existsSync(DATA_FOLDER)) fs.mkdirSync(DATA_FOLDER, { recursive: true });
    const sessionsToSave = Array.from(sessions.entries()).map(([id, s]) => ({
      ...s, waId: id,
      // No guardar base64 de imágenes
      foto_base64: null
    }));
    fs.writeFileSync(
      path.join(DATA_FOLDER, 'ticobot_data.json'),
      JSON.stringify({ account, botPaused, profiles: Array.from(profiles.values()), sessions: sessionsToSave, salesLog, alertsLog, quickReplies, banner }, null, 2)
    );
  } catch(e) { console.log('⚠️ Error guardando:', e.message); }
}
function loadDataFromDisk() {
  try {
    const file = path.join(DATA_FOLDER, 'ticobot_data.json');
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (data.account)     Object.assign(account, data.account);
    if (data.profiles)    data.profiles.forEach(p => profiles.set(p.waId, p));
    if (data.sessions)    data.sessions.forEach(s => { sessions.set(s.waId, s); });
    if (data.botPaused !== undefined) botPaused = data.botPaused;
    if (data.salesLog)    salesLog    = data.salesLog;
    if (data.alertsLog)   alertsLog   = data.alertsLog;
    if (data.quickReplies)quickReplies= data.quickReplies;
    if (data.banner)      banner       = data.banner;
    console.log(`📂 Datos cargados (${salesLog.length} ventas, ${profiles.size} contactos)`);
  } catch(e) { console.log('⚠️ Error cargando:', e.message); }
}
setInterval(saveDataToDisk, 5 * 60 * 1000);
// ============ CRON: AUTO-RELEASE HUMAN MODE ============
// Cada 5 min revisa sesiones en modo humano y libera las que llevan 30+ min sin actividad
setInterval(() => {
  const HUMAN_TIMEOUT = 30 * 60 * 1000;
  const now = Date.now();
  for (const [waId, session] of sessions.entries()) {
    if (!session.humanMode) continue;
    const lastAct = session.humanModeLastActivity || session.humanModeAt || 0;
    if (now - lastAct >= HUMAN_TIMEOUT) {
      console.log(`⏰ Auto-release humanMode (cron): ${waId}`);
      session.humanMode = false;
      session.humanModeManual = false;
      session.humanModeAt = null;
      session.humanModeLastActivity = null;
      io.emit('human_mode_changed', { waId: normalizePhone(waId), humanMode: false, autoRelease: true });
    }
  }
}, 5 * 60 * 1000);



// ============ LID MAP ============
function loadLidMap() {
  try {
    if (fs.existsSync(LID_MAP_FILE)) {
      const data = JSON.parse(fs.readFileSync(LID_MAP_FILE, 'utf8'));
      lidPhoneMap = new Map(Object.entries(data));
      console.log(`📋 LID map: ${lidPhoneMap.size} entradas`);
    }
  } catch(e) {}
}
function saveLidMap() {
  try { fs.writeFileSync(LID_MAP_FILE, JSON.stringify(Object.fromEntries(lidPhoneMap), null, 2)); } catch(e) {}
}

// ============ CRM SIMPLE ============
function loadCrmData() {
  try {
    const f = path.join(DATA_FOLDER, 'crm_clients.json');
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
      crmClients = new Map(data.map(c => [c.waId, c]));
    }
  } catch(e) {}
}
function saveCrmData() {
  try {
    fs.writeFileSync(path.join(DATA_FOLDER, 'crm_clients.json'), JSON.stringify(Array.from(crmClients.values()), null, 2));
  } catch(e) {}
}
function updateCrmClient(waId, saleData) {
  const id = normalizePhone(waId);
  const existing = crmClients.get(id) || { waId: id, purchaseCount: 0, totalSpent: 0, firstPurchase: saleData.date, lastPurchase: saleData.date };
  existing.purchaseCount++;
  existing.totalSpent += saleData.total || 0;
  existing.lastPurchase = saleData.date;
  existing.type = existing.purchaseCount >= 5 ? 'frecuente' : existing.purchaseCount >= 2 ? 'repetido' : 'primera';
  crmClients.set(id, existing);
  saveCrmData();
}

// ============ CATÁLOGO ============
async function loadCatalog() {
  if (Date.now() - lastCatalogLoad < 2 * 60 * 1000 && catalogProducts.length > 0) return catalogProducts;
  try {
    const response = await fetch(`${CATALOG_URL}/products.js?v=${Date.now()}`);
    if (!response.ok) throw new Error('No se pudo cargar');
    const text = await response.text();
    const match = text.match(/const\s+PRODUCTOS\s*=\s*\[([\s\S]*?)\];/);
    if (!match) throw new Error('Formato inválido');
    const productos = eval(`[${match[1]}]`);
    catalogProducts = productos.map(p => ({
      codigo: p[0], nombre: p[1], precio: p[2],
      descuento: p[3] || 0, categoria: p[5] || '',
      tallas: p[6] || '', agotado: p[9] || 0
    }));
    lastCatalogLoad = Date.now();
    console.log(`📦 Catálogo cargado: ${catalogProducts.length} productos`);
    return catalogProducts;
  } catch(e) {
    console.log('⚠️ Error cargando catálogo:', e.message);
    return catalogProducts;
  }
}

// ============ BÚSQUEDA EN CATÁLOGO ============
function buscarPreciosPorTipo(query, rootFiltro = null) {
  const lower = norm(query);

  const mapeoCategoria = {
    'jean': 'jeans', 'jeans': 'jeans',
    'blusa': 'blusas', 'blusas': 'blusas',
    'vestido': 'vestidos', 'vestidos': 'vestidos',
    'falda': 'faldas', 'faldas': 'faldas',
    'pantalon': 'pantalones', 'pantalones': 'pantalones',
    'short': 'shorts', 'shorts': 'shorts',
    'chaqueta': 'chaquetas', 'chaquetas': 'chaquetas',
    'jacket': 'chaquetas', 'sueter': 'chaquetas', 'sweater': 'chaquetas', 'saco': 'chaquetas',
    'camisa': 'camisas', 'camisas': 'camisas',
    'camiseta': 'camisetas', 'camisetas': 'camisetas',
    'accesorio': 'accesorios', 'accesorios': 'accesorios',
    'conjunto': 'conjuntos', 'conjuntos': 'conjuntos',
  };

  const mapeoRoot = {
    'jeans': 'damas', 'blusas': 'damas', 'vestidos': 'damas',
    'faldas': 'damas', 'pantalones': 'damas', 'shorts': 'damas',
    'chaquetas': 'damas', 'accesorios': 'damas', 'camisas': 'damas',
    'camisetas': 'damas', 'conjuntos': 'damas',
  };

  const estilos = [
    'pretina ancha', 'tiro alto', 'tiro bajo', 'tiro medio', 'manga larga', 'manga corta',
    'azul oscuro', 'azul claro', 'verde oscuro', 'verde claro',
    'pretina', 'plus', 'skinny', 'recto', 'campana', 'ancho', 'slim', 'straight',
    'tejida', 'tejido', 'crop', 'palazzo', 'culotte', 'mom', 'wide', 'barrel', 'boyfriend',
    'rasgado', 'bordado', 'floreado', 'estampado', 'liso', 'elastizado', 'bolsillo',
    'largo', 'corta', 'corto',
    'negro', 'negra', 'blanco', 'blanca', 'azul', 'rojo', 'roja', 'verde',
    'amarillo', 'amarilla', 'rosado', 'rosada', 'rosa', 'morado', 'morada',
    'gris', 'beige', 'cafe', 'naranja', 'celeste', 'lila', 'fucsia',
    'coral', 'vino', 'crema', 'dorado', 'plateado', 'turquesa'
  ];

  let categoriaId = null, categoriaDisplay = null;
  for (const [palabra, catId] of Object.entries(mapeoCategoria)) {
    if (lower.includes(palabra)) {
      categoriaId = catId;
      categoriaDisplay = catId;
      break;
    }
  }
  if (!categoriaId) return null;

  // Si piden género que no está en catálogo online → 0 resultados → a humano
  if (rootFiltro && rootFiltro !== 'damas') {
    return { categoria: categoriaId, rootCategoria: rootFiltro, display: categoriaId, encontrados: 0 };
  }

  const todosCategoria = catalogProducts.filter(p =>
    p.categoria && p.categoria.toLowerCase() === categoriaId && !p.agotado
  );
  if (todosCategoria.length === 0) return { categoria: categoriaId, display: categoriaDisplay, encontrados: 0 };

  // Filtrar por estilo/descripción
  let estiloDetectado = null;
  for (const estilo of estilos) {
    if (lower.includes(estilo)) { estiloDetectado = estilo; break; }
  }
  let productos = todosCategoria;
  if (estiloDetectado) {
    const filtrado = todosCategoria.filter(p => norm(p.nombre).includes(estiloDetectado));
    if (filtrado.length > 0) productos = filtrado;
  }

  // Filtrar por talla
  const regexTallaNum   = /(\d{1,2}\/\d{1,2})/;
  const regexTallaLetra = /\b(xxl|2xl|3xl|xl|xs|s|m|l)\b/i;
  let matchTalla = lower.match(regexTallaNum) || lower.match(regexTallaLetra);
  let tallaDetectada = null, tallaDisponible = true;
  if (matchTalla) {
    const posibleTalla = matchTalla[1].toUpperCase();
    const esTallaReal = todosCategoria.some(p => p.tallas?.split(',').some(t => t.trim().toUpperCase() === posibleTalla));
    if (esTallaReal) {
      tallaDetectada = posibleTalla;
      const filtradosTalla = productos.filter(p => p.tallas?.split(',').some(t => t.trim().toUpperCase() === posibleTalla));
      if (filtradosTalla.length > 0) productos = filtradosTalla;
      else tallaDisponible = false;
    }
  }

  const precios      = productos.map(p => p.descuento > 0 ? Math.round(p.precio * (1 - p.descuento / 100)) : p.precio);
  const conDescuento = productos.filter(p => p.descuento > 0);
  const rootId       = mapeoRoot[categoriaId] || 'damas';
  const displayFinal = estiloDetectado ? `${categoriaDisplay} ${estiloDetectado.toUpperCase()}` : categoriaDisplay;

  return {
    categoria: categoriaId, rootCategoria: rootId, display: displayFinal,
    encontrados: productos.length,
    minPrecio: Math.min(...precios), maxPrecio: Math.max(...precios),
    conDescuento: conDescuento.length,
    maxDescuento: conDescuento.length > 0 ? Math.max(...conDescuento.map(p => p.descuento)) : 0,
    productos, estiloDetectado, tallaDetectada, tallaDisponible,
    totalCategoria: todosCategoria.length
  };
}

// ============ IA (solo para FAQ conversacional) ============
const STORE_CONTEXT = `Sos el asistente virtual de ${STORE_NAME}, una tienda de ropa en Heredia, Costa Rica.

INFORMACIÓN:
- Ubicación: ${STORE_ADDRESS}
- Horario: Lunes a Sábado 9am-7pm, Domingo 10am-6pm
- Teléfono: 2237-3335 (solo para llamadas, NO dar otro WhatsApp)
- Catálogo: ${CATALOG_URL}

LO QUE PODÉS RESPONDER (FAQ):
- Horario de atención y días festivos
- Ubicación y cómo llegar
- Apartados: se aparta con la cuarta parte del costo, 2 meses para retirar
- Cambios: 8 días con factura y sin usar. No hay devolución de dinero.
- Garantía: ${WARRANTY_DAYS} días contra defectos de fábrica
- Métodos de pago: SINPE Móvil y efectivo (NO tarjetas)
- SINPE: al número ${SINPE_NUMBER} a nombre de ${SINPE_NAME}
- Envíos: GAM ₡2,500 / Fuera de GAM ₡3,500 / 4-5 días hábiles con Correos CR
- Empleo: enviar currículo a tiendalavaca@gmail.com
- Mayoreo: no vendemos al por mayor, solo al detalle

ESTILO: Tico, amigable, natural, máximo 3 oraciones. Usá "vos". No inventés info.
IMPORTANTE: Si te preguntan precios o disponibilidad de productos específicos, respondé solo "PASAR_A_HUMANO".`;

async function askAI(userMessage) {
  if (!OPENAI_KEY) return null;
  try {
    const { hour, minute } = getCostaRicaTime();
    const dia = getCostaRicaDayName();
    const horaActual = `${hour}:${minute < 10 ? '0' : ''}${minute}`;
    const contextoTiempo = `\n\nHoy es ${dia}, son las ${horaActual} hora Costa Rica.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: STORE_CONTEXT + contextoTiempo },
          { role: 'user',   content: userMessage }
        ],
        max_tokens: 150, temperature: 0.7
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (reply) account.metrics.ia_calls = (account.metrics.ia_calls || 0) + 1;
    return reply;
  } catch(e) {
    console.log('❌ Error IA:', e.message);
    return null;
  }
}

// ============ PUSHOVER ============
async function sendPushoverAlert(tipo, datos) {
  if (!PUSHOVER_USER || !PUSHOVER_APP) return;
  try {
    const phone       = datos.phone || datos.waId || 'Desconocido';
    const phoneFormatted = formatPhone(phone);
    const chatLink    = `${PANEL_URL}/panel.html?chat=${normalizePhone(phone)}`;
    const alertId     = `A-${Date.now().toString(36).toUpperCase()}`;
    const alertEntry  = {
      id: alertId, tipo, fecha: new Date().toISOString(),
      phone: phoneFormatted, waId: normalizePhone(phone),
      producto: datos.producto || datos.talla_color || '',
      estado: 'pendiente', fecha_atendida: null, minutos_respuesta: null, receipt: null
    };

    let title = '', message = '';
    if (tipo === 'PRODUCTO_WEB') {
      title   = '🛍️ Cliente interesado';
      message = `👤 ${phoneFormatted}\n📦 ${datos.producto || 'Producto'}\n💰 ₡${(datos.precio || 0).toLocaleString()}\n👕 ${datos.talla_color || '-'}\n\n💬 Ver en panel`;
    } else if (tipo === 'PRODUCTO_FOTO') {
      title   = '📷 Cliente con foto externa';
      message = `👤 ${phoneFormatted}\n💬 "${datos.mensaje || ''}"\n\n📱 Responder en panel`;
    } else if (tipo === 'CONSULTA') {
      title   = '⚠️ Cliente necesita atención';
      message = `👤 ${phoneFormatted}\n💬 "${datos.mensaje || ''}"\n\n📱 Responder en panel`;
    } else if (tipo === 'HUMANO_MENSAJE') {
      title   = `💬 ${datos.name || phoneFormatted}`;
      message = `${datos.mensaje || '(mensaje)'}\n👤 ${phoneFormatted}`;
    } else if (tipo === 'MULTI_PRODUCTO') {
      title   = '📋 Lista de productos';
      message = `👤 ${phoneFormatted}\n📦 ${datos.producto || '?'}`;
    }
    if (!title) return;

    const pushBody = {
      token: PUSHOVER_APP, user: PUSHOVER_USER,
      title, message, priority: 1, sound: 'cashregister'
    };
    const response = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pushBody)
    });
    if (response.ok) {
      const result = await response.json();
      alertEntry.receipt = result.receipt || null;
      alertsLog.push(alertEntry);
      if (alertsLog.length > 500) alertsLog = alertsLog.slice(-500);
      console.log(`📲 Pushover: ${tipo} → ${phoneFormatted}`);
    }
  } catch(e) { console.log('⚠️ Pushover error:', e.message); }
}

// ============ ENVÍO DE MENSAJES ============
async function sendTextWithTyping(waId, text) {
  if (!sock || connectionStatus !== 'connected') return false;
  try {
    const jid   = jidMap.get(normalizePhone(waId)) || toJid(waId);
    const delay = getHumanDelay();
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(delay);
    await sock.sendPresenceUpdate('paused', jid);
    await sock.sendMessage(jid, { text });
    addToChatHistory(waId, 'out', text);
    account.metrics.mensajes_enviados = (account.metrics.mensajes_enviados || 0) + 1;
    console.log(`📤 ${formatPhone(waId)}: ${text.slice(0, 60)}...`);
    return true;
  } catch(e) {
    console.log('❌ Error envío:', e.message);
    return false;
  }
}

// ============ GUARDAR IMAGEN ============
async function guardarImagenFoto(waId, base64Data) {
  try {
    const imgDir = path.join(PERSISTENT_DIR, 'images');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
    const filename = `foto_${normalizePhone(waId)}_${Date.now()}.jpg`;
    const imgPath  = path.join(imgDir, filename);
    fs.writeFileSync(imgPath, Buffer.from(base64Data, 'base64'));
    return `/images/${filename}`;
  } catch(e) { return null; }
}

// ============ PARSEAR MENSAJE DE LA WEB ============
function parseWebMessage(text) {
  if (!text || !text.includes('Me interesa este producto')) return null;
  try {
    const lines  = text.split('\n').map(l => l.trim()).filter(Boolean);
    const result = { producto: null, precio: null, codigo: null, talla: null, color: null, tamano: null, foto_url: null, producto_url: null };
    for (const line of lines) {
      if (line.startsWith('Producto:'))     result.producto   = line.replace('Producto:', '').trim();
      else if (line.startsWith('Precio:'))  { const m = line.match(/[\d,]+/); if(m) result.precio = parseInt(m[0].replace(/,/g,'')); }
      else if (line.startsWith('Código:'))  result.codigo      = line.replace('Código:', '').trim();
      else if (line.startsWith('Talla:'))   result.talla       = line.replace('Talla:', '').trim();
      else if (line.startsWith('Color:'))   result.color       = line.replace('Color:', '').trim();
      else if (line.startsWith('Tamaño:'))  result.tamano      = line.replace('Tamaño:', '').trim();
      else if (line.startsWith('Foto:'))    result.foto_url    = line.replace('Foto:', '').trim();
      else if (line.startsWith('Link:'))    result.producto_url= line.replace('Link:', '').trim();
    }
    return result.producto ? result : null;
  } catch(e) { return null; }
}

function parseMultiWebMessage(text) {
  if (!text || !text.includes('Productos seleccionados:')) return null;
  try {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const items = [];
    let i = 0;
    while (i < lines.length) {
      if (/^\d+\./.test(lines[i])) {
        const item = { producto: null, precio: null, codigo: null, talla: null, color: null };
        item.producto = lines[i].replace(/^\d+\.\s*/, '').trim();
        while (i + 1 < lines.length && !/^\d+\./.test(lines[i + 1]) && !lines[i+1].startsWith('Total:')) {
          i++;
          if (lines[i].startsWith('Precio:'))  { const m = lines[i].match(/[\d,]+/); if(m) item.precio = parseInt(m[0].replace(/,/g,'')); }
          if (lines[i].startsWith('Código:'))  item.codigo = lines[i].replace('Código:', '').trim();
          if (lines[i].startsWith('Talla:'))   item.talla  = lines[i].replace('Talla:', '').trim();
          if (lines[i].startsWith('Color:'))   item.color  = lines[i].replace('Color:', '').trim();
        }
        items.push(item);
      }
      i++;
    }
    const totalLine = lines.find(l => l.startsWith('Total:'));
    const total = totalLine ? parseInt((totalLine.match(/[\d,]+/) || ['0'])[0].replace(/,/g,'')) : 0;
    return items.length >= 2 ? { items, total } : null;
  } catch(e) { return null; }
}

// ============ HANDLER PRINCIPAL ============
async function handleIncomingMessage(msg) {
  const remoteJid = msg.key.remoteJid;
  const isLid     = remoteJid?.endsWith('@lid');
  const lidId     = isLid ? fromJid(remoteJid) : null;
  const senderPn  = msg.key.senderPn || msg.key.senderPnAlt || null;

  let waId, realPhone = null;
  if (senderPn) {
    realPhone = fromJid(senderPn); waId = realPhone;
    if (lidId) { lidPhoneMap.set(lidId, realPhone); saveLidMap(); }
  } else if (isLid && lidPhoneMap.has(lidId)) {
    realPhone = lidPhoneMap.get(lidId); waId = realPhone;
  } else if (isLid) {
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(remoteJid);
      if (pn) { realPhone = fromJid(pn); waId = realPhone; lidPhoneMap.set(lidId, realPhone); saveLidMap(); }
      else waId = lidId;
    } catch(e) { waId = lidId; }
  } else {
    waId = fromJid(remoteJid); realPhone = waId;
  }

  jidMap.set(normalizePhone(waId), remoteJid);
  const session = getSession(waId);
  session.replyJid = remoteJid;
  const profile = getProfile(waId);
  if (msg.pushName && !profile.name) profile.name = msg.pushName;
  if (realPhone) profile.phone = realPhone;

  let text = '';
  // Extraer texto
  const imgMsg = msg.message?.imageMessage ||
    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
  const docMsg = msg.message?.documentMessage;

  if (msg.message?.conversation) text = msg.message.conversation;
  else if (msg.message?.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
  else if (imgMsg?.caption) text = imgMsg.caption;
  else if (docMsg?.caption) text = docMsg.caption;
  else if (msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text)
    text = msg.message.ephemeralMessage.message.extendedTextMessage.text;

  const hasImage = !!(msg.message?.imageMessage || msg.message?.extendedTextMessage?.jpegThumbnail);

  // Detectar tipo de mensaje para historial
  let msgLabel = '(mensaje)';
  if (text)                               msgLabel = text;
  else if (hasImage)                      msgLabel = '(foto)';
  else if (msg.message?.audioMessage)     msgLabel = '🎤 (audio)';
  else if (msg.message?.videoMessage)     msgLabel = '🎥 (video)';
  else if (msg.message?.stickerMessage)   msgLabel = '🎭 (sticker)';
  else if (msg.message?.documentMessage)  msgLabel = '📄 (documento)';
  else if (msg.message?.locationMessage)  msgLabel = '📍 (ubicación)';
  else if (msg.message?.contactMessage)   msgLabel = '👤 (contacto)';
  else if (msg.message?.reactionMessage)  msgLabel = '👍 (reacción: ' + (msg.message.reactionMessage.text || '') + ')';

  // Descargar imagen si existe
  let imageBase64 = null;
  if (hasImage) {
    try {
      const stream = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      if (stream) imageBase64 = stream.toString('base64');
    } catch(e) { console.log('⚠️ Error descargando imagen:', e.message); }
  }

  const displayPhone = realPhone ? formatPhone(realPhone) : waId;
  addToChatHistory(waId, 'in', msgLabel, imageBase64);
  console.log(`📥 ${displayPhone}: ${text || (hasImage ? '(foto)' : '(mensaje)')}`);

  // ── Chequeos iniciales ──
  if (profile.blocked) return;
  if (botPaused) { console.log('⏸️ Bot pausado'); return; }

  // Activar humanMode si el bot está desactivado para este contacto
  if (profile.botDisabled && !session.humanMode) {
    activateHumanMode(session, waId, true);
  }

  // Auto-release humanMode por inactividad (30 min sin mensajes del cliente)
  const HUMAN_TIMEOUT = 30 * 60 * 1000;
  if (session.humanMode) {
    const lastAct = session.humanModeLastActivity || session.humanModeAt || 0;
    if (Date.now() - lastAct >= HUMAN_TIMEOUT) {
      console.log(`⏰ humanMode expirado (30 min) para ${displayPhone}, regresando a bot`);
      session.humanMode = false;
      session.humanModeManual = false;
      session.humanModeAt = null;
      session.humanModeLastActivity = null;
      io.emit('human_mode_changed', { waId: normalizePhone(waId), humanMode: false, autoRelease: true });
      sendPushoverAlert('BOT_RETOMA', { waId, phone: profile.phone || waId, name: profile.name || '', mensaje: 'Bot retomó tras 30 min inactividad' });
      await sendTextWithTyping(waId, 'Dame un momento, enseguida te ayudo 😊');
      await sleep(600);
      // Continuar flujo normal del bot
    } else {
      session.humanModeLastActivity = Date.now();
      console.log(`👤 Modo humano activo: ${displayPhone}`);
      io.emit('human_mode_message', {
        waId: normalizePhone(waId), phone: displayPhone,
        text: text || (hasImage ? '(foto)' : '(mensaje)'),
        timestamp: new Date().toISOString()
      });
      sendPushoverAlert('HUMANO_MENSAJE', { waId, phone: profile.phone || waId, name: profile.name || '', mensaje: text || '(foto)' });
      return;
    }
  }

  // Fuera de horario
  if (!isStoreOpen()) {
    const { hour } = getCostaRicaTime();
    const dia = getCostaRicaDayName();
    const NOCTURNO_COOLDOWN = 8 * 60 * 60 * 1000;
    if (session.nocturno_sent_at && (Date.now() - session.nocturno_sent_at) < NOCTURNO_COOLDOWN) return;
    session.nocturno_sent_at = Date.now();
    saveDataToDisk();
    await sendTextWithTyping(waId,
      `¡Hola! En este momento estamos fuera de servicio 😊\n\n` +
      `🕒 Nuestro horario:\n` +
      `• Lunes a Sábado: 9am - 7pm\n` +
      `• Domingo: 10am - 6pm\n\n` +
      `En cuanto abramos te atendemos con gusto 🙌`
    );
    return;
  }

  account.metrics.chats_total = (account.metrics.chats_total || 0) + 1;
  const lower = norm(text);

  // ── BANNER (primer mensaje del cliente) ──
  if (!session.saludo_enviado && banner.activo && banner.texto) {
    await sendTextWithTyping(waId, banner.texto);
    session.saludo_enviado = true;
    await sleep(800);
  }

  // ── FOTO EXTERNA → pasar a humano ──
  if (hasImage && !text.includes('Me interesa este producto') && !text.includes('Productos seleccionados:')) {
    let fotoUrl = null;
    if (imageBase64) fotoUrl = await guardarImagenFoto(waId, imageBase64);

    await sendTextWithTyping(waId, `¡Hola! Pura vida 🙌 Dame un momento, ya te ayudo 😊`);
    session.state = 'ESPERANDO_CONFIRMACION_VENDEDOR';
    activateHumanMode(session, waId);

    const quote = {
      waId, phone: profile.phone || waId, name: profile.name || '',
      producto: '📷 Consulta con foto externa',
      precio: null, codigo: null, foto_url: fotoUrl,
      talla_color: text || null, foto_externa: true,
      mensaje: text || '(solo foto)', created_at: new Date().toISOString()
    };
    pendingQuotes.set(waId, quote);
    io.emit('new_pending', quote);
    sendPushoverAlert('PRODUCTO_FOTO', { ...quote, mensaje: text || '(foto externa)' });
    saveDataToDisk();
    return;
  }

  // ── MULTI-PRODUCTO del catálogo web ──
  const multiData = parseMultiWebMessage(text);
  if (multiData && multiData.items.length >= 2) {
    const lista = multiData.items.map((p, i) =>
      `${i+1}. ${p.producto || 'Producto'} ${p.talla ? '(' + p.talla + ')' : ''} - ₡${(p.precio || 0).toLocaleString()}`
    ).join('\n');

    await sendTextWithTyping(waId,
      `¡Hola! Pura vida 🙌\n\n` +
      `Vi que te interesan ${multiData.items.length} productos:\n\n${lista}\n\n` +
      `Dame un momento para revisar 🔍`
    );

    session.state = 'ESPERANDO_CONFIRMACION_VENDEDOR';
    activateHumanMode(session, waId);

    const multiQuote = {
      waId, phone: profile.phone || waId, name: profile.name || '',
      type: 'multi', products: multiData.items, total: multiData.total,
      created_at: new Date().toISOString()
    };
    pendingQuotes.set(waId, multiQuote);
    io.emit('new_pending_multi', multiQuote);
    sendPushoverAlert('MULTI_PRODUCTO', { phone: profile.phone || waId, producto: `${multiData.items.length} productos`, talla_color: multiData.items.map(p => p.producto).join(', ') });
    saveDataToDisk();
    return;
  }

  // ── PRODUCTO DEL CATÁLOGO WEB ("Me interesa") ──
  const webData = parseWebMessage(text);
  if (webData && webData.codigo) {
    let detalles = [];
    if (webData.talla) detalles.push(`Talla: ${webData.talla}`);
    if (webData.color) detalles.push(`Color: ${webData.color}`);
    if (webData.tamano) detalles.push(`Tamaño: ${webData.tamano}`);
    const tallaColor = detalles.join(', ');

    let msgCliente = `¡Hola! Pura vida 🙌`;
    if (!tallaColor) {
      msgCliente += `\n\nVi que te interesa *${webData.producto}* 😊\n\n¿Qué talla y color te gustaría?`;
      session.state = 'ESPERANDO_TALLA_WEB';
      session.producto_pendiente = webData;
    } else {
      msgCliente += ` Dame un momento, ya te confirmo disponibilidad 😊`;
      session.state = 'ESPERANDO_CONFIRMACION_VENDEDOR';
      activateHumanMode(session, waId);

      const quote = {
        waId, phone: profile.phone || waId, name: profile.name || '',
        producto: webData.producto, precio: webData.precio,
        codigo: webData.codigo, talla_color: tallaColor,
        foto_url: webData.foto_url, producto_url: webData.producto_url,
        created_at: new Date().toISOString()
      };
      pendingQuotes.set(waId, quote);
      io.emit('new_pending', quote);
      sendPushoverAlert('PRODUCTO_WEB', quote);
    }
    await sendTextWithTyping(waId, msgCliente);
    saveDataToDisk();
    return;
  }

  // ── TALLA/COLOR cuando se pidió después de "Me interesa" ──
  if (session.state === 'ESPERANDO_TALLA_WEB' && session.producto_pendiente) {
    const tallaColor = text.trim();
    const webD = session.producto_pendiente;
    session.state = 'ESPERANDO_CONFIRMACION_VENDEDOR';
    session.producto_pendiente = null;
    activateHumanMode(session, waId);

    const quote = {
      waId, phone: profile.phone || waId, name: profile.name || '',
      producto: webD.producto, precio: webD.precio,
      codigo: webD.codigo, talla_color: tallaColor,
      foto_url: webD.foto_url, producto_url: webD.producto_url,
      created_at: new Date().toISOString()
    };
    pendingQuotes.set(waId, quote);
    io.emit('new_pending', quote);
    sendPushoverAlert('PRODUCTO_WEB', quote);
    await sendTextWithTyping(waId, `¡Perfecto! Dame un momento que ya te confirmo 🙌`);
    saveDataToDisk();
    return;
  }

  // ── RESPUESTA DE GÉNERO (cuando bot preguntó ¿para damas, caballeros o niños?) ──
  if (session.state === 'ESPERANDO_GENERO' && session.ultimaCategoriaBuscada) {
    const esDama  = /\b(dama|damas|mujer|mujeres|femenin[ao]|señora|chica|ella)\b/i.test(lower);
    const esCabal = /\b(caballero|caballeros|hombre|hombres|masculin[ao]|señor|chico|varon)\b/i.test(lower);
    const esNino  = /\b(niño|niños|niña|niñas|nino|ninas|adolescente|juvenil|infantil|kids?|escolar)\b/i.test(lower);

    if (esDama || esCabal || esNino) {
      const root  = esCabal ? 'caballeros' : esNino ? 'ninos' : 'damas';
      const cat   = session.ultimaCategoriaBuscada;
      const desc  = session.ultimaDescripcionBuscada || '';
      const query = desc ? `${cat} ${desc}` : cat;

      await loadCatalog();
      const resultado = buscarPreciosPorTipo(query, root);

      if (!resultado || resultado.encontrados === 0) {
        // No hay en catálogo → a humano
        await sendTextWithTyping(waId, `Dame un momento, ya te ayudo 🙌`);
        session.state = 'ESPERANDO_CONFIRMACION_VENDEDOR';
        session.ultimaCategoriaBuscada = null;
        session.generosPosCat = null;
        activateHumanMode(session, waId);

        const quote = {
          waId, phone: profile.phone || waId, name: profile.name || '',
          producto: `❓ Busca: ${cat} para ${root}`,
          precio: null, codigo: null, foto_url: null, talla_color: null,
          consulta_producto: true, created_at: new Date().toISOString()
        };
        pendingQuotes.set(waId, quote);
        io.emit('new_pending', quote);
        sendPushoverAlert('CONSULTA', { phone: profile.phone || waId, name: profile.name || '', mensaje: `Busca: ${cat} para ${root}` });
      } else {
        const descParam = resultado.estiloDetectado ? `&desc=${encodeURIComponent(resultado.estiloDetectado)}` : '';
        const link = `${CATALOG_URL}/catalogo.html?root=${resultado.rootCategoria}&cat=${resultado.categoria}${descParam}`;
        let msg = `¡Claro! Tenemos ${resultado.display} desde ₡${resultado.minPrecio.toLocaleString()} hasta ₡${resultado.maxPrecio.toLocaleString()} 🛍️`;
        if (resultado.conDescuento > 0) msg += `\n\n🔥 Tenemos opciones con descuento, hasta ${resultado.maxDescuento}% OFF`;
        msg += `\n\nRevisalos acá 👇\n${link}`;
        await sendTextWithTyping(waId, msg);
        session.state = 'NEW';
        session.ultimaCategoriaBuscada = cat;
        session.ultimaDescripcionBuscada = null;
        session.generosPosCat = null;
      }
      saveDataToDisk();
      return;
    }
  }

  // ── BÚSQUEDA DE PRODUCTO RANDOM ──
  const regexProducto = /jeans?|pantalon(?:es)?|shorts?|chaqueta(?:s)?|jacket(?:s)?|blusa(?:s)?|vestido(?:s)?|falda(?:s)?|camisa(?:s)?|camiseta(?:s)?|sueter|sweater|saco(?:s)?|accesorio(?:s)?|conjunto(?:s)?/i;
  const mencionaProducto = regexProducto.test(lower);

  if (mencionaProducto) {
    await loadCatalog();

    // Detectar género
    const mencionaDama  = /\b(dama|damas|mujer|mujeres|femenin[ao]|señora|chica|ella)\b/i.test(lower);
    const mencionaCabal = /\b(caballero|caballeros|hombre|hombres|masculin[ao]|señor|chico|varon)\b/i.test(lower);
    const mencionaNino  = /\b(niño|niños|niña|niñas|nino|ninas|adolescente|juvenil|infantil|kids?|escolar)\b/i.test(lower);
    const generoEspecificado = mencionaDama || mencionaCabal || mencionaNino;

    // Detectar categoría
    const mapeoCategoriaProd = {
      'jean': 'jeans', 'jeans': 'jeans',
      'pantalon': 'pantalones', 'pantalones': 'pantalones',
      'short': 'shorts', 'shorts': 'shorts',
      'chaqueta': 'chaquetas', 'jacket': 'chaquetas', 'sueter': 'chaquetas', 'sweater': 'chaquetas', 'saco': 'chaquetas',
      'blusa': 'blusas', 'blusas': 'blusas',
      'vestido': 'vestidos', 'falda': 'faldas',
      'camisa': 'camisas', 'camiseta': 'camisetas',
      'conjunto': 'conjuntos', 'accesorio': 'accesorios',
    };

    let categoriaDetectada = null;
    for (const [palabra, cat] of Object.entries(mapeoCategoriaProd)) {
      if (lower.includes(palabra)) { categoriaDetectada = cat; break; }
    }

    // Géneros posibles por categoría
    const mapeoGenerosProd = {
      'jeans': ['damas','caballeros','ninos'], 'pantalones': ['damas','caballeros','ninos'],
      'shorts': ['damas','caballeros','ninos'], 'chaquetas': ['damas','caballeros','ninos'],
      'camisas': ['damas','caballeros','ninos'], 'camisetas': ['damas','caballeros','ninos'],
      'blusas': ['damas','ninas'], 'vestidos': ['damas','ninas'],
      'faldas': ['damas','ninas'], 'conjuntos': ['damas','ninas'],
      'accesorios': ['damas'],
    };
    const generosPosibles = categoriaDetectada ? (mapeoGenerosProd[categoriaDetectada] || ['damas']) : ['damas','caballeros','ninos'];
    const necesitaGenero  = generosPosibles.length > 1 && !generoEspecificado;

    const saludo = /hola|buenas|buenos|hey/i.test(lower) ? '¡Hola! Pura vida 🙌\n\n' : '';

    if (necesitaGenero && categoriaDetectada) {
      // Guardar descripción extra para usarla después
      const stopW = /^(hola|buenas|buenos|hey|tienen|hay|busco|quiero|para|de|que|con|los|las|un|una|si|no|y|o|a|es|me|interesa|también|tambien)$/i;
      const descExtra = lower.replace(/[¿?!¡]/g,'').split(/\s+/)
        .filter(w => w.length > 3 && !stopW.test(w) && !Object.keys(mapeoCategoriaProd).includes(w))
        .join(' ').trim();

      const partes = generosPosibles.map(g => g === 'ninos' ? 'niños/niñas' : g);
      const pregunta = partes.length === 2
        ? `${partes[0]} o ${partes[1]}`
        : `${partes.slice(0,-1).join(', ')} o ${partes[partes.length-1]}`;

      await sendTextWithTyping(waId,
        `${saludo}¡Claro que tenemos ${categoriaDetectada}! 😊\n\n¿Buscás para ${pregunta}?`
      );
      session.state = 'ESPERANDO_GENERO';
      session.ultimaCategoriaBuscada = categoriaDetectada;
      session.ultimaDescripcionBuscada = descExtra || null;
      session.generosPosCat = generosPosibles;
      saveDataToDisk();
      return;
    }

    // Tiene género o es categoría de un solo género → buscar directo
    const rootFinal = mencionaCabal ? 'caballeros' : mencionaNino ? 'ninos' : 'damas';
    const resultado = buscarPreciosPorTipo(text, rootFinal);

    if (resultado && resultado.encontrados > 0) {
      const descParam = resultado.estiloDetectado ? `&desc=${encodeURIComponent(resultado.estiloDetectado)}` : '';
      const link = `${CATALOG_URL}/catalogo.html?root=${resultado.rootCategoria}&cat=${resultado.categoria}${descParam}`;
      let msg = `${saludo}¡Sí! Tenemos ${resultado.display} desde ₡${resultado.minPrecio.toLocaleString()} hasta ₡${resultado.maxPrecio.toLocaleString()} 🛍️`;
      if (resultado.conDescuento > 0) msg += `\n\n🔥 Con descuento hasta ${resultado.maxDescuento}% OFF`;
      msg += `\n\nRevisalos acá 👇\n${link}`;
      await sendTextWithTyping(waId, msg);
      session.state = 'NEW';
      session.ultimaCategoriaBuscada = resultado.categoria;
      saveDataToDisk();
      return;
    }

    // No hay en catálogo → a humano
    await sendTextWithTyping(waId, `${saludo}Dame un momento, ya te ayudo 🙌`);
    session.state = 'ESPERANDO_CONFIRMACION_VENDEDOR';
    activateHumanMode(session, waId);

    const quoteProducto = {
      waId, phone: profile.phone || waId, name: profile.name || '',
      producto: `❓ Busca: ${text.trim()}`,
      precio: null, codigo: null, foto_url: null, talla_color: null,
      consulta_producto: true, created_at: new Date().toISOString()
    };
    pendingQuotes.set(waId, quoteProducto);
    io.emit('new_pending', quoteProducto);
    sendPushoverAlert('CONSULTA', { phone: profile.phone || waId, name: profile.name || '', mensaje: text.trim() });
    saveDataToDisk();
    return;
  }

  // ── PRODUCTOS QUE NO VENDEMOS ──
  if (/zapato|zapatos|tenis|zapatilla|calzado|sandalia|sandal|bota|botin|tacones|cortina|sabana|sábana|cobija|edredon|almohada|mueble|hogar|decorac|plato|taza|cocina/i.test(lower)) {
    const esCalzado = /zapato|tenis|zapatilla|calzado|sandalia|bota|botin|tacones/i.test(lower);
    await sendTextWithTyping(waId,
      esCalzado
        ? `¡Hola! Vieras que esa línea no te la ofrezco 😊 Vendemos solamente ropa y accesorios para damas, caballeros y niños.\n\n¿Te puedo ayudar con algo más?`
        : `¡Hola! Vieras que esa línea no te la ofrezco 😊 Vendemos solamente ropa y accesorios.\n\nPodés ver nuestro catálogo acá 👇\n${CATALOG_URL}`
    );
    return;
  }

  // ── FAQ: detectar preguntas frecuentes ──
  const esFAQ =
    /hora|horario|abierto|abren|cierran|cierra|atienden|cuando abren/i.test(lower) ||
    /direcci[oó]n|d[oó]nde est[aá]n|ubicaci[oó]n|c[oó]mo llegar|mapa/i.test(lower) ||
    /envi[oó]|envian|despachan|mandan|llegan a|hacen entregas/i.test(lower) ||
    /sinpe|pago|pagar|m[eé]todo.*pago|forma.*pago|efectivo|tarjeta/i.test(lower) ||
    /apart|separa|reserv|guardan/i.test(lower) ||
    /cambio|devoluci[oó]n|cambian|devuelven/i.test(lower) ||
    /garant[ií]a|defecto|falla/i.test(lower) ||
    /contratando|necesitan.*personal|trabajo|empleo|curr[ií]culo/i.test(lower) ||
    /mayoreo|por mayor|mayorista/i.test(lower) ||
    /tallas?|talla.*plus|plus.*size/i.test(lower) ||
    /gracias/i.test(lower) ||
    /hola|buenas|buenos d[ií]as|buenas tardes|buenas noches|qu[eé] tal|c[oó]mo est[aá]/i.test(lower);

  if (esFAQ || lower.length < 3) {
    // Saludo puro
    if (/^(hola|buenas|buenos|hey|qu[eé] tal|c[oó]mo est[aá]s?|pura vida)[\s!?]*$/i.test(lower)) {
      const saludos = [
        '¡Hola! Pura vida 🙌 ¿En qué te puedo ayudar?',
        '¡Hola! ¿Cómo estás? ¿En qué te ayudo? 😊',
        '¡Buenas! Pura vida 🙌 ¿En qué te puedo servir?',
        '¡Hola! Bienvenid@ 🐄 ¿Qué necesitás?',
      ];
      await sendTextWithTyping(waId, saludos[Math.floor(Math.random() * saludos.length)]);
      return;
    }

    // Gracias
    if (/gracias/i.test(lower)) {
      const gracias = ['¡Con mucho gusto! 😊', '¡Pura vida! 🙌', '¡Gracias a vos! 🙌', '¡Para servirte! 😊'];
      await sendTextWithTyping(waId, gracias[Math.floor(Math.random() * gracias.length)]);
      return;
    }

    // Pasar a IA para FAQ
    const aiReply = await askAI(text);
    if (aiReply && aiReply !== 'PASAR_A_HUMANO') {
      await sendTextWithTyping(waId, aiReply);
      return;
    }
  }

  // ── TODO LO DEMÁS → a humano ──
  console.log(`⚠️ Sin match: "${text}" → pasando a humano`);
  await sendTextWithTyping(waId, `¡Hola! Dame un momento, ya te ayudo 🙌`);
  session.state = 'ESPERANDO_CONFIRMACION_VENDEDOR';
  activateHumanMode(session, waId);

  const quoteFallback = {
    waId, phone: profile.phone || waId, name: profile.name || '',
    producto: `❓ Consulta: ${text.trim()}`,
    precio: null, codigo: null, foto_url: null, talla_color: null,
    consulta_producto: true, created_at: new Date().toISOString()
  };
  pendingQuotes.set(waId, quoteFallback);
  io.emit('new_pending', quoteFallback);
  sendPushoverAlert('CONSULTA', { phone: profile.phone || waId, name: profile.name || '', mensaje: text.trim() });
  saveDataToDisk();
}

// ============ DEBOUNCE ============
async function handleIncomingMessageWithDebounce(msg) {
  const remoteJid = msg.key.remoteJid;
  const isLid     = remoteJid?.endsWith('@lid');
  const senderPn  = msg.key.senderPn || msg.key.senderPnAlt || null;
  let waId;
  if (senderPn)                                     waId = fromJid(senderPn);
  else if (isLid && lidPhoneMap.has(fromJid(remoteJid))) waId = lidPhoneMap.get(fromJid(remoteJid));
  else if (isLid)                                   waId = fromJid(remoteJid);
  else                                              waId = fromJid(remoteJid);

  if (!messageBuffer.has(waId)) messageBuffer.set(waId, { messages: [], timer: null, processing: false });
  const buffer = messageBuffer.get(waId);

  if (buffer.processing) { buffer.messages.push(msg); return; }
  buffer.messages.push(msg);
  if (buffer.timer) clearTimeout(buffer.timer);

  buffer.timer = setTimeout(async () => {
    buffer.processing = true;
    const lastMsg = buffer.messages[buffer.messages.length - 1];
    buffer.messages = [];
    buffer.timer = null;
    try {
      await handleIncomingMessage(lastMsg);
    } catch(e) {
      console.log('❌ Error procesando mensaje:', e.message, e.stack?.split('\n').slice(0,3).join(' | '));
    }
    buffer.processing = false;
    if (buffer.messages.length > 0) {
      const nextMsg = buffer.messages.pop();
      buffer.messages = [];
      setTimeout(() => handleIncomingMessageWithDebounce(nextMsg), 100);
    }
  }, DEBOUNCE_MS);
}

// ============ ACCIONES DEL PANEL ============
async function executeAction(clientWaId, actionType, data = {}) {
  const session = getSession(clientWaId);
  const profile = getProfile(clientWaId);

  if (actionType === 'DISMISS') {
    pendingQuotes.delete(clientWaId);
    session.pendingDismissed = true;
    io.emit('pending_resolved', { waId: clientWaId });
    saveDataToDisk();
    return { success: true, message: 'Visto' };
  }

  if (actionType === 'TOMAR_CHAT') {
    session.humanMode = true;
    session.humanModeAt = Date.now();
    session.humanModeLastActivity = Date.now();
    io.emit('human_mode_changed', { waId: normalizePhone(clientWaId), humanMode: true });
    saveDataToDisk();
    return { success: true, message: 'Chat tomado' };
  }

  if (actionType === 'LIBERAR_CHAT') {
    session.humanMode = false;
    session.humanModeManual = false;
    session.humanModeAt = null;
    session.humanModeLastActivity = null;
    session.state = 'NEW';
    io.emit('human_mode_changed', { waId: normalizePhone(clientWaId), humanMode: false });
    saveDataToDisk();
    return { success: true, message: 'Chat liberado' };
  }

  if (actionType === 'MENSAJE') {
    const texto = data.texto || data.text || '';
    if (!texto) return { success: false, message: 'Sin texto' };
    const ok = await sendTextWithTyping(clientWaId, texto);
    session.humanModeLastActivity = Date.now();
    saveDataToDisk();
    return { success: ok, message: ok ? 'Enviado' : 'Error al enviar' };
  }

  if (actionType === 'AGOTADO') {
    pendingQuotes.delete(clientWaId);
    session.state = 'NEW';
    io.emit('pending_resolved', { waId: clientWaId });
    await sendTextWithTyping(clientWaId,
      `Uy, qué lástima 😔 De momento ese producto está agotado.\n\n` +
      `Pero podés revisar más opciones en el catálogo 🛍️\n${CATALOG_URL}`
    );
    saveDataToDisk();
    return { success: true, message: 'Agotado enviado' };
  }

  if (actionType === 'VENTA_COMPLETADA') {
    const { producto, precio, talla_color, method, shipping, zone, envio_datos, sinpe_reference } = data;
    const parsedPrecio   = Number(precio) || session.precio || 0;
    const parsedShipping = Number(shipping) || 0;
    const total = parsedPrecio + parsedShipping;

    const sale = {
      id: `V-${Date.now().toString(36).toUpperCase()}`,
      date: new Date().toISOString(),
      waId: normalizePhone(clientWaId),
      phone: profile.phone || clientWaId,
      name: profile.name || '',
      producto: producto || session.producto || 'Producto',
      codigo: session.codigo || '',
      talla_color: talla_color || session.talla_color || '',
      method: method || 'whatsapp',
      precio: parsedPrecio, shipping: parsedShipping, total,
      zone: zone || session.client_zone || '',
      envio_datos: envio_datos || '',
      sinpe_reference: sinpe_reference || '',
      foto_url: session.foto_url || '',
      status: 'alistado',
      guia_correos: '', fecha_alistado: '', fecha_envio: '', fecha_entregado: ''
    };
    salesLog.push(sale);
    account.metrics.sales_completed = (account.metrics.sales_completed || 0) + 1;
    account.metrics.total_revenue    = (account.metrics.total_revenue || 0) + total;
    profile.purchases = (profile.purchases || 0) + 1;
    updateCrmClient(normalizePhone(clientWaId), sale);

    pendingQuotes.delete(clientWaId);
    session.state = 'NEW';
    session.humanMode = false;
    resetSession(session);
    io.emit('pending_resolved', { waId: clientWaId });
    io.emit('sale_completed', sale);
    io.emit('human_mode_changed', { waId: normalizePhone(clientWaId), humanMode: false });
    saveDataToDisk();
    console.log(`🎉 VENTA #${sale.id}: ₡${total.toLocaleString()} - ${sale.producto}`);
    return { success: true, message: 'Venta registrada', sale };
  }

  return { success: false, message: 'Acción desconocida' };
}

// ============ WHATSAPP ============
const messageQueue = [];
let isProcessingQueue = false;
async function processQueue() {
  if (isProcessingQueue || messageQueue.length === 0) return;
  isProcessingQueue = true;
  while (messageQueue.length > 0) {
    const msg = messageQueue.shift();
    await handleIncomingMessageWithDebounce(msg);
  }
  isProcessingQueue = false;
}

async function connectWhatsApp() {
  connectionStatus = 'connecting';
  io.emit('connection_status', { status: connectionStatus });
  if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger, printQRInTerminal: false,
    browser: ['TICObot', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    shouldIgnoreJid: (jid) => jid?.endsWith('@g.us') || jid?.endsWith('@broadcast'),
    keepAliveIntervalMs: 20000,
    connectTimeoutMs: 120000,
    defaultQueryTimeoutMs: 120000,
    retryRequestDelayMs: 500,
    markOnlineOnConnect: false,
    emitOwnEvents: true,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCode = await QRCode.toDataURL(qr);
      connectionStatus = 'qr';
      io.emit('qr_code', { qr: qrCode });
      io.emit('connection_status', { status: connectionStatus });
      console.log('📱 QR listo');
    }
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`❌ Desconectado: código=${reason}`);
      connectionStatus = 'disconnected'; qrCode = null; connectedPhone = '';
      if (global._keepAliveInterval) { clearInterval(global._keepAliveInterval); global._keepAliveInterval = null; }
      io.emit('connection_status', { status: connectionStatus });
      if (reason === DisconnectReason.loggedOut) {
        try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch(e) {}
        setTimeout(connectWhatsApp, 5000);
      } else if (reason === 428 || reason === 408) {
        const delay = Math.min(15000 + (reconnectAttempts * 5000), 60000);
        reconnectAttempts++;
        setTimeout(connectWhatsApp, delay);
      } else if (reason === 515 || reason === 503) {
        setTimeout(connectWhatsApp, 5000);
      } else {
        const delay = Math.min(3000 * Math.pow(1.5, reconnectAttempts), 60000);
        reconnectAttempts++;
        setTimeout(connectWhatsApp, delay);
      }
    }
    if (connection === 'open') {
      connectionStatus = 'connected'; qrCode = null; reconnectAttempts = 0;
      connectedPhone = sock.user?.id?.split(':')[0] || '';
      io.emit('connection_status', { status: connectionStatus, phone: connectedPhone });
      console.log('✅ Conectado:', connectedPhone);
      if (global._keepAliveInterval) clearInterval(global._keepAliveInterval);
      global._keepAliveInterval = setInterval(async () => {
        try { if (sock && connectionStatus === 'connected') await sock.sendPresenceUpdate('available'); } catch(e) {}
      }, 4 * 60 * 1000);

      // Restaurar pendientes tras reconexión
      setTimeout(() => {
        let restored = 0;
        for (const [wId, s] of sessions.entries()) {
          if (s.state === 'ESPERANDO_CONFIRMACION_VENDEDOR' && !pendingQuotes.has(wId) && !s.pendingDismissed) {
            const p = getProfile(wId);
            const quote = { waId: wId, phone: p.phone || wId, name: p.name || '', producto: s.producto || 'Consulta pendiente', precio: null, codigo: null, foto_url: null, talla_color: s.talla_color || null, created_at: new Date().toISOString() };
            pendingQuotes.set(wId, quote);
            io.emit('new_pending', quote);
            restored++;
          }
        }
        if (restored > 0) console.log(`🔄 ${restored} pendiente(s) restaurado(s)`);
      }, 3000);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('contacts.upsert', (contacts) => {
    let changed = false;
    for (const ct of contacts) {
      // Resolver @lid → número real
      if (ct.id?.endsWith('@lid') && ct.phoneNumber) {
        const lid = fromJid(ct.id), phone = ct.phoneNumber.replace(/[^\d]/g, '');
        if (phone.length >= 8) {
          lidPhoneMap.set(lid, phone);
          const p = getProfile(lid);
          p.phone = phone;
          if ((ct.notify || ct.name) && !p.name) { p.name = ct.notify || ct.name; changed = true; }
        }
      }
      // Contacto normal → crear perfil si no existe, actualizar nombre
      const cId = fromJid(ct.id || '');
      if (!cId || cId.endsWith('@g.us')) continue;
      const nombre = ct.notify || ct.name || '';
      const p = getProfile(cId); // crea perfil aunque nunca haya escrito
      if (nombre && !p.name) { p.name = nombre; changed = true; }
    }
    if (changed) saveDataToDisk();
    saveLidMap();
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;
      if (msg.key.fromMe) {
        const remoteJid = msg.key.remoteJid || '';
        let waId;
        if (remoteJid.endsWith('@lid')) {
          // Resolver @lid al número real usando el mapa ya existente
          const lidId = fromJid(remoteJid);
          waId = lidPhoneMap.has(lidId) ? lidPhoneMap.get(lidId) : lidId;
        } else {
          waId = fromJid(remoteJid);
        }
        if (!waId) continue;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (text) addToChatHistory(waId, 'out', text);
        continue;
      }
      messageQueue.push(msg);
      processQueue();
    }
  });
}

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
  let authenticated = false;

  socket.on('auth', (pin) => {
    if (pin === PANEL_PIN || pin === 'auto') {
      authenticated = true;
      socket.emit('auth_success', { storeName: STORE_NAME });
      socket.emit('connection_status', { status: connectionStatus, phone: connectedPhone });
      socket.emit('bot_status', { paused: botPaused });
      if (qrCode) socket.emit('qr_code', { qr: qrCode });
      const activeSessions = {};
      for (const [wId, s] of sessions.entries()) {
        if (s.humanMode || s.state !== 'NEW') {
          activeSessions[wId] = { state: s.state, humanMode: s.humanMode || false, humanModeManual: s.humanModeManual || false };
        }
      }
      socket.emit('init_data', {
        pending: Array.from(pendingQuotes.values()),
        history: fullHistory.slice(-500),
        contacts: Array.from(profiles.values()),
        metrics: account.metrics,
        sales: salesLog.slice(-50),
        humanModeChats: Array.from(sessions.entries()).filter(([,s]) => s.humanMode).map(([id]) => id),
        activeSessions,
        quickReplies,
        banner,
        botPaused
      });
    } else {
      socket.emit('auth_error', 'PIN incorrecto');
    }
  });

  socket.use((packet, next) => {
    if (packet[0] === 'auth') return next();
    if (!authenticated) return next(new Error('No auth'));
    next();
  });

  socket.on('connect_whatsapp', () => {
    if (connectionStatus === 'connected') { socket.emit('connection_status', { status: 'connected', phone: connectedPhone }); return; }
    connectWhatsApp();
  });
  socket.on('disconnect_whatsapp', async () => {
    if (!authenticated) return;
    console.log('🔌 Desconectando WhatsApp por solicitud del panel...');
    try {
      if (sock) {
        await sock.logout();
      }
    } catch(e) {
      console.log('⚠️ Error al desconectar:', e.message);
      if (sock) try { sock.end(); } catch(e2) {}
    }
    sock = null;
    connectionStatus = 'disconnected';
    qrCode = null;
    connectedPhone = '';
    io.emit('connection_status', { status: 'disconnected', phone: '' });
    console.log('✅ WhatsApp desconectado');
  });
  socket.on('toggle_bot', () => {
    botPaused = !botPaused;
    saveDataToDisk();
    io.emit('bot_status', { paused: botPaused });
    console.log(`${botPaused ? '⏸️' : '▶️'} Bot ${botPaused ? 'pausado' : 'reanudado'} globalmente`);
  });
  socket.on('action', async (data) => {
    const result = await executeAction(data.clientWaId, data.actionType, data.payload || {});
    socket.emit('action_result', result);
  });
  socket.on('get_contacts', () => { socket.emit('contacts_list', { contacts: Array.from(profiles.values()) }); });

  // Guardar/actualizar contacto desde el panel
  socket.on('save_contact', (data) => {
    if (!data.waId) return;
    const id = normalizePhone(data.waId);
    const p = getProfile(id);
    if (data.name !== undefined) p.name = data.name.trim();
    if (data.phone !== undefined && data.phone.trim()) p.phone = normalizePhone(data.phone);
    if (data.notes !== undefined) p.notes = data.notes.trim();
    saveDataToDisk();
    io.emit('contact_updated', { contact: p });
    socket.emit('contact_saved', { success: true, contact: p });
    console.log(`📇 Contacto guardado: ${p.name || id} (${id})`);
  });
  socket.on('toggle_block', (data) => {
    if (!data.waId) return;
    const p = getProfile(data.waId); p.blocked = data.block;
    saveDataToDisk(); io.emit('contact_updated', { contact: p });
  });
  socket.on('toggle_bot_disabled', (data) => {
    if (!data.waId) return;
    const p = getProfile(data.waId); p.botDisabled = data.botDisabled;
    const s = sessions.get(normalizePhone(data.waId));
    if (s) {
      s.humanMode = data.botDisabled; s.humanModeManual = data.botDisabled;
      if (data.botDisabled) { s.humanModeAt = Date.now(); s.humanModeLastActivity = Date.now(); }
      else { s.humanModeAt = null; s.humanModeLastActivity = null; }
      io.emit('human_mode_changed', { waId: normalizePhone(data.waId), humanMode: data.botDisabled, manual: data.botDisabled });
    }
    saveDataToDisk(); io.emit('contact_updated', { contact: p });
  });
  socket.on('delete_chats', (data) => {
    if (!data.waId) return;
    const n = normalizePhone(data.waId);
    chatHistory = chatHistory.filter(m => m.waId !== n);
    sessions.delete(n); pendingQuotes.delete(n);
    saveDataToDisk(); io.emit('chats_deleted', { waId: n });
  });
  socket.on('get_quick_replies', () => { socket.emit('quick_replies', { quickReplies }); });
  socket.on('save_quick_replies', (data) => {
    if (!Array.isArray(data.quickReplies)) return;
    quickReplies = data.quickReplies;
    saveDataToDisk(); io.emit('quick_replies', { quickReplies });
  });
  socket.on('get_metrics', () => { socket.emit('metrics', { metrics: account.metrics }); });
  socket.on('purge_data', (data) => {
    const { beforeDate, purgeSessions, purgeSales, purgeHistory } = data;
    if (!beforeDate) return socket.emit('purge_result', { success: false });
    const cutoff = new Date(beforeDate).getTime();
    let sd = 0, vd = 0, hd = 0;
    if (purgeSessions) { for (const [id,s] of sessions.entries()) { if (s.last_activity < cutoff) { sessions.delete(id); sd++; } } }
    if (purgeSales)    { const b = salesLog.length; salesLog = salesLog.filter(s => new Date(s.date).getTime() >= cutoff); vd = b - salesLog.length; }
    if (purgeHistory)  { const b = fullHistory.length; fullHistory = fullHistory.filter(m => new Date(m.timestamp).getTime() >= cutoff); chatHistory = chatHistory.filter(m => new Date(m.timestamp).getTime() >= cutoff); hd = b - fullHistory.length; }
    saveDataToDisk();
    socket.emit('purge_result', { success: true, sessionsDeleted: sd, salesDeleted: vd, historyDeleted: hd });
  });
});

// ============ MIDDLEWARE ADMIN ============
function adminAuth(req, res, next) {
  const pwd   = req.query.pwd || req.headers['x-admin-pwd'];
  const token = req.query.token || req.headers['x-admin-token'];
  if (token && adminTokens.has(token)) {
    const t = adminTokens.get(token);
    if (t.expires > Date.now()) { req.role = t.pwd === ADMIN_PASSWORD ? 'dueno' : 'usuario'; return next(); }
    adminTokens.delete(token);
  }
  if (pwd === ADMIN_PASSWORD) { req.role = 'dueno'; return next(); }
  if (pwd === USER_PASSWORD)  { req.role = 'usuario'; return next(); }
  res.status(401).json({ error: 'No autorizado' });
}

// ============ ENDPOINTS ============
app.get('/health',  (req, res) => res.send('OK'));
app.post('/api/admin/disconnect', adminAuth, async (req, res) => {
  console.log('🔌 Desconectando WhatsApp via REST...');
  try {
    if (sock) await sock.logout();
  } catch(e) {
    console.log('⚠️ Error logout:', e.message);
    if (sock) try { sock.end(); } catch(e2) {}
  }
  sock = null;
  connectionStatus = 'disconnected';
  qrCode = null;
  connectedPhone = '';
  io.emit('connection_status', { status: 'disconnected', phone: '' });
  res.json({ success: true });
});

app.post('/api/admin/connect', adminAuth, (req, res) => {
  console.log('🔌 Conectando WhatsApp via REST...');
  if (connectionStatus === 'connected') return res.json({ success: true, status: 'already_connected' });
  connectWhatsApp();
  res.json({ success: true, status: 'connecting' });
});

app.get('/status',  (req, res) => res.json({ connection: connectionStatus, phone: connectedPhone, botPaused, storeOpen: isStoreOpen(), metrics: account.metrics }));

app.get('/api/admin/dashboard', adminAuth, (req, res) => {
  const now = new Date(), today = now.toISOString().slice(0,10);
  const weekAgo = new Date(now - 7*24*60*60*1000).toISOString();
  const sToday = salesLog.filter(s => s.date?.startsWith(today));
  const sWeek  = salesLog.filter(s => s.date >= weekAgo);
  const sum    = arr => arr.reduce((s,v) => s + (v.total||0), 0);
  res.json({
    timestamp: now.toISOString(), connection: connectionStatus, phone: connectedPhone,
    botPaused, storeOpen: isStoreOpen(), metrics: account.metrics,
    sales: {
      today: { count: sToday.length, revenue: sum(sToday) },
      week:  { count: sWeek.length,  revenue: sum(sWeek)  },
      all:   { count: salesLog.length, revenue: sum(salesLog) },
      recent: salesLog.slice(-20).reverse()
    },
    contacts_total: profiles.size
  });
});

app.get('/api/admin/contacts', adminAuth, (req, res) => {
  let list = Array.from(profiles.values());
  const { search } = req.query;
  if (search) { const s = search.toLowerCase(); list = list.filter(p => (p.name||'').toLowerCase().includes(s) || (p.waId||'').includes(s)); }
  res.json({ total: list.length, contacts: list });
});

app.post('/api/admin/contacts', adminAuth, express.json(), (req, res) => {
  const { waId, name, phone, notes, botDisabled } = req.body;
  if (!waId) return res.status(400).json({ error: 'waId requerido' });
  const id = normalizePhone(waId);
  const p  = getProfile(id);
  if (name !== undefined) p.name = name;
  if (phone !== undefined) p.phone = phone;
  if (notes !== undefined) p.notes = notes;
  if (botDisabled !== undefined) p.botDisabled = botDisabled;
  saveDataToDisk();
  res.json({ success: true, contact: p });
});

app.delete('/api/admin/contacts/:waId', adminAuth, (req, res) => {
  const id = normalizePhone(decodeURIComponent(req.params.waId));
  profiles.delete(id); saveDataToDisk();
  res.json({ success: true });
});

app.get('/api/admin/sales', adminAuth, (req, res) => {
  const { from, to, limit } = req.query;
  let filtered = [...salesLog];
  if (from) filtered = filtered.filter(s => s.date >= from);
  if (to)   filtered = filtered.filter(s => s.date <= to);
  filtered.reverse();
  if (limit) filtered = filtered.slice(0, parseInt(limit));
  res.json({ count: filtered.length, revenue: filtered.reduce((s,v) => s+(v.total||0), 0), sales: filtered });
});

app.post('/api/admin/sales/manual', adminAuth, express.json(), (req, res) => {
  const { producto, precio, talla_color, method, phone, name, zone, shipping, sinpe_reference, notas } = req.body;
  if (!producto || !precio || !method) return res.status(400).json({ error: 'Faltan datos' });
  const parsedPrecio   = Number(precio) || 0;
  const parsedShipping = Number(shipping) || 0;
  const total = parsedPrecio + parsedShipping;
  const sale = {
    id: `VM-${Date.now().toString(36).toUpperCase()}`,
    date: new Date().toISOString(),
    waId: phone ? normalizePhone(phone) : '',
    phone: phone || '', name: name || '',
    producto, talla_color: talla_color || '',
    method, precio: parsedPrecio, shipping: parsedShipping, total,
    zone: zone || '', sinpe_reference: sinpe_reference || '',
    status: 'alistado', guia_correos: '', fecha_alistado: '', fecha_envio: '', fecha_entregado: '',
    manual: true, notas: notas || ''
  };
  salesLog.push(sale);
  account.metrics.sales_completed = (account.metrics.sales_completed || 0) + 1;
  account.metrics.total_revenue    = (account.metrics.total_revenue || 0) + total;
  if (phone) updateCrmClient(normalizePhone(phone), sale);
  saveDataToDisk();
  io.emit('sale_completed', sale);
  res.json({ success: true, sale });
});

app.post('/api/admin/sales/update', adminAuth, express.json(), (req, res) => {
  const { saleId, field, value } = req.body;
  if (!saleId || !field) return res.status(400).json({ error: 'Faltan datos' });
  const sale = salesLog.find(s => s.id === saleId);
  if (!sale) return res.status(404).json({ error: 'No encontrada' });
  const allowed = ['status','guia_correos','fecha_alistado','fecha_envio','fecha_entregado','notas'];
  if (!allowed.includes(field)) return res.status(400).json({ error: 'Campo no permitido' });
  sale[field] = value;
  if (field === 'fecha_entregado' && value) sale.status = 'entregado';
  else if (field === 'fecha_envio' && value && sale.status !== 'entregado') sale.status = 'en_transito';
  saveDataToDisk();
  res.json({ success: true, sale });
});

app.delete('/api/admin/sales/:saleId', adminAuth, (req, res) => {
  const idx = salesLog.findIndex(s => s.id === req.params.saleId);
  if (idx === -1) return res.status(404).json({ error: 'No encontrada' });
  salesLog.splice(idx, 1); saveDataToDisk();
  res.json({ success: true });
});

app.post('/api/admin/purge', adminAuth, express.json(), (req, res) => {
  const { beforeDate, purgeSessions, purgeSales, purgeHistory } = req.body;
  if (!beforeDate) return res.json({ success: false });
  const cutoff = new Date(beforeDate).getTime();
  let sd = 0, vd = 0, hd = 0;
  if (purgeSessions) { for (const [id,s] of sessions.entries()) { if ((s.last_activity||0) < cutoff) { sessions.delete(id); sd++; } } }
  if (purgeSales)    { const b = salesLog.length; salesLog = salesLog.filter(s => new Date(s.date||0).getTime() >= cutoff); vd = b - salesLog.length; }
  if (purgeHistory)  { const b = fullHistory.length; fullHistory = fullHistory.filter(m => new Date(m.timestamp||0).getTime() >= cutoff); chatHistory = chatHistory.filter(m => new Date(m.timestamp||0).getTime() >= cutoff); hd = b - fullHistory.length; }
  saveDataToDisk();
  res.json({ success: true, sessionsDeleted: sd, salesDeleted: vd, historyDeleted: hd });
});

app.get('/api/admin/chats', adminAuth, (req, res) => {
  const { from, to, limit = 150 } = req.query;
  let msgs = fullHistory.slice();
  if (from) msgs = msgs.filter(m => m.timestamp >= from);
  if (to)   msgs = msgs.filter(m => m.timestamp <= to + 'T23:59:59Z');
  const map = new Map();
  for (const m of msgs) {
    const id = m.waId || m.phone || '';
    if (!map.has(id)) {
      const p = getProfile(id);
      map.set(id, { waId: id, phone: m.phone || id, name: p.name || m.name || '', messages: [], last: m.timestamp });
    }
    const conv = map.get(id);
    // direction 'out' = bot envió, 'in' = cliente envió
    const fromRole = m.direction === 'out' ? 'bot' : 'user';
    conv.messages.push({
      text: m.text,
      from: fromRole,
      timestamp: m.timestamp,
      imageBase64: m.imageBase64 || null
    });
    if (m.timestamp > conv.last) conv.last = m.timestamp;
  }
  let convos = Array.from(map.values());
  convos.sort((a, b) => b.last.localeCompare(a.last));
  convos = convos.slice(0, parseInt(limit));
  res.json({ total: convos.length, conversations: convos });
});

app.get('/api/admin/alerts', adminAuth, (req, res) => {
  const { limit } = req.query;
  let filtered = [...alertsLog].reverse();
  if (limit) filtered = filtered.slice(0, parseInt(limit));
  res.json({ alerts: filtered, total: alertsLog.length });
});

// ── BANNER ──
app.get('/api/admin/banner', adminAuth, (req, res) => {
  res.json({ banner });
});
app.post('/api/admin/banner', adminAuth, express.json(), (req, res) => {
  const { activo, texto } = req.body;
  if (activo !== undefined) banner.activo = !!activo;
  if (texto  !== undefined) banner.texto  = texto;
  saveDataToDisk();
  io.emit('banner_updated', { banner });
  console.log(`🪧 Banner ${banner.activo ? 'activado' : 'desactivado'}: ${banner.texto?.slice(0,50)}`);
  res.json({ success: true, banner });
});

app.get('/api/admin/quick-replies', adminAuth, (req, res) => {
  res.json({ quickReplies });
});
app.post('/api/admin/quick-replies', adminAuth, express.json(), (req, res) => {
  if (!Array.isArray(req.body.quickReplies)) return res.json({ success: false, error: 'Invalid data' });
  quickReplies = req.body.quickReplies;
  saveDataToDisk();
  io.emit('quick_replies', { quickReplies });
  console.log(`⚡ Quick replies actualizados: ${quickReplies.length} atajos`);
  res.json({ success: true, quickReplies });
});

// ============ INICIAR ============
server.listen(PORT, async () => {
  if (!fs.existsSync(PERSISTENT_DIR)) { try { fs.mkdirSync(PERSISTENT_DIR, { recursive: true }); } catch(e) {} }
  loadDataFromDisk();
  loadCrmData();
  loadHistory();
  await loadCatalog();

  console.log(`
╔═══════════════════════════════════════════════════╗
║  🐄 TICO-bot — La Vaca CR                         ║
╠═══════════════════════════════════════════════════╣
║  🕒 Horario: ${HOURS_DAY.padEnd(36)}║
║  🌐 Catálogo: ${CATALOG_URL.slice(0,34).padEnd(34)}║
║  📦 Productos: ${String(catalogProducts.length).padEnd(33)}║
║  🧠 Bot híbrido: FAQ + Catálogo + Humano          ║
╚═══════════════════════════════════════════════════╝
  `);

  if (fs.existsSync(path.join(AUTH_FOLDER, 'creds.json'))) {
    console.log('🔄 Reconectando...');
    connectWhatsApp();
  }

  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    setInterval(async () => {
      try { const r = await fetch(`${RENDER_URL}/health`); console.log(`💓 Self-ping: ${r.status}`); }
      catch(e) { console.log('💔 Self-ping falló'); }
    }, 4 * 60 * 1000);
    console.log('💓 Self-ping habilitado');
  }

  setInterval(() => {
    if (connectionStatus === 'disconnected' && fs.existsSync(path.join(AUTH_FOLDER, 'creds.json'))) {
      console.log('🐕 Watchdog: reconectando...'); connectWhatsApp();
    }
  }, 2 * 60 * 1000);
});
