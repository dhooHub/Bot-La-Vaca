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
const AUTH_FOLDER = path.join(process.cwd(), "auth_baileys");
const DATA_FOLDER = process.cwd();

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

const STORE_CONTEXT = `Sos el asistente virtual de La Vaca CR, una tienda de ropa y accesorios para damas ubicada en Heredia, Costa Rica.
INFORMACIÓN: La Vaca CR, Heredia centro, 200m sur de Correos de CR. Horario: L-S 9am-7pm, D 10am-6pm. Tel: 2237-3335. WhatsApp: +506 6483-6565. Catálogo: www.lavacacr.com
PAGO: SINPE Móvil (preferido), efectivo en tienda. NO tarjetas.
ENVÍOS: Todo el país. GAM: ₡2,500. Rural: ₡3,500. Entrega: 3-5 días hábiles.
TALLAS: S, M, L, XL, XXL, Talla Plus en algunos estilos.
APARTADOS: Sí, con 1/4 del precio. 2 meses para completar.
POLÍTICAS: Cambios 8 días con factura sin usar. No devoluciones de dinero. Garantía 30 días defectos fábrica.
ESTILO: Respondé como tico, amigable, corto (2-3 oraciones). No inventés info.`;

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

function checkFaqRegex(lower) {
  if (/envio|entregan|envían|costo de envio/.test(lower)) { if(offersShipping()) return `Sí hacemos envíos 🚚\n\nGAM: ${SHIPPING_GAM}\nRural: ${SHIPPING_RURAL}\n${DELIVERY_DAYS}`; return `Solo retiro 🏪\n📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}`; }
  if (/horario|hora|atienden|cierran|abren/.test(lower)) return `Horario: ${HOURS_DAY} 🙌`;
  if (/garantia|devolucion/.test(lower)) return `Garantía: ${WARRANTY_DAYS} 🙌`;
  if ((/ubicacion|donde|direccion/.test(lower)) && hasPhysicalLocation()) return `📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}${MAPS_URL ? `\n🗺️ ${MAPS_URL}` : ""}`;
  if (/tallas?|medidas?|tamanos?/.test(lower)) return "Manejamos tallas: S, M, L, XL, XXL y Talla Plus 👕";
  if (/sinpe|pago|como pago/.test(lower)) return `SINPE Móvil 💳\n${SINPE_NUMBER}\nA nombre de: ${SINPE_NAME}`;
  if (/apartado|apartar|aparto|reservar|reserva/.test(lower)) return "¡Sí hacemos apartados! 🙌\n\nApartás con 1/4 del precio y tenés 2 meses para completar.";
  if (/tarjeta|credito|débito|debito|visa|mastercard/.test(lower)) return "Por el momento solo aceptamos SINPE Móvil y efectivo 🙌";
  if (/cambio|devolucion|devolver|cambiar/.test(lower)) return "Tenés 8 días para cambios, con factura y sin usar 🙌 No hacemos devoluciones de dinero.";
  return null;
}

function getStateDescription(state) {
  const map = {
    ESPERANDO_TALLA: "Se le preguntó qué talla y color quiere",
    ESPERANDO_CONFIRMACION_VENDEDOR: "Se le dijo que estamos verificando disponibilidad",
    PREGUNTANDO_INTERES: "Se le preguntó si quiere comprar el producto (sí o no)",
    ESPERANDO_ZONA: "Se le preguntó de qué zona del país es",
    PREGUNTANDO_METODO: "Se le preguntó si quiere envío o retiro en tienda",
    ZONA_RECIBIDA: "Se le dijo que estamos calculando el envío",
    PRECIO_TOTAL_ENVIADO: "Se le mostró el precio total y se preguntó si está de acuerdo",
    ESPERANDO_SINPE: "Se le dieron los datos de SINPE y se espera el comprobante",
    PAGO_CONFIRMADO_ENVIO: "Se confirmó el pago y se pidió la dirección de envío",
  };
  return map[state] || state;
}

// ============ PERSISTENCIA ============
function saveDataToDisk() { try { fs.writeFileSync(path.join(DATA_FOLDER,"ticobot_data.json"),JSON.stringify({account,botPaused,profiles:Array.from(profiles.values()),sessions:Array.from(sessions.values())},null,2)); } catch(e){console.log("⚠️ Error guardando:",e.message);} }
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
    ESPERANDO_TALLA: "Y sobre tu producto, ¿me decís la talla y color? 👕",
    ESPERANDO_CONFIRMACION_VENDEDOR: "Y sobre tu consulta, ya estoy verificando disponibilidad 🙌",
    PREGUNTANDO_INTERES: "Y sobre el producto, ¿te interesa adquirirlo? 😊\n\n1. ✅ Sí\n2. ❌ No",
    ESPERANDO_ZONA: "Y sobre tu pedido, ¿de qué zona sos? 📍",
    PREGUNTANDO_METODO: "Y sobre tu pedido, ¿envío o retiro en tienda?\n\n1. 📦 Envío\n2. 🏪 Recoger",
    ZONA_RECIBIDA: "Y sobre tu pedido, estoy calculando el envío 🙌",
    PRECIO_TOTAL_ENVIADO: "Y sobre tu pedido, ¿estás de acuerdo con el precio?\n\n1. ✅ Sí\n2. ❌ No",
    ESPERANDO_SINPE: "Y sobre tu pago, estoy esperando el comprobante de SINPE 🧾",
    PAGO_CONFIRMADO_ENVIO: "Y sobre tu envío, ocupo tu dirección completa 📍",
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
    sessions.set(id, { waId:id, replyJid:null, state:"NEW", producto:null, precio:null, codigo:null, foto_url:null, talla_color:null, shipping_cost:null, client_zone:null, delivery_method:null, sinpe_reference:null, saludo_enviado:false, catalogo_enviado:false, nocturno_sent_at:null, last_activity:Date.now() });
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
  session.state="NEW"; session.producto=null; session.precio=null; session.codigo=null; session.foto_url=null; session.talla_color=null; session.shipping_cost=null; session.client_zone=null; session.delivery_method=null; session.sinpe_reference=null; session.saludo_enviado=false; session.catalogo_enviado=false; session.nocturno_sent_at=null; pendingQuotes.delete(session.waId);
}

function getProfile(waId) { const id=normalizePhone(waId); if(!profiles.has(id))profiles.set(id,{waId:id,name:"",blocked:false,purchases:0,created_at:new Date().toISOString()}); return profiles.get(id); }

function addToChatHistory(waId, direction, text, imageUrl=null) {
  const profile=getProfile(waId);
  const entry = { id:Date.now().toString(36)+Math.random().toString(36).slice(2,6), waId:normalizePhone(waId), phone:profile.phone||normalizePhone(waId), name:profile.name||"", direction, text, imageUrl, timestamp:new Date().toISOString() };
  chatHistory.push(entry); if(chatHistory.length>MAX_CHAT_HISTORY)chatHistory=chatHistory.slice(-MAX_CHAT_HISTORY);
  io.emit("new_message",entry); return entry;
}

function addPendingQuote(session) {
  const profile=getProfile(session.waId);
  const quote = { waId:session.waId, phone:profile.phone||session.waId, name:profile.name||"", lid:profile.lid||null, producto:session.producto, precio:session.precio, codigo:session.codigo, foto_url:session.foto_url, talla_color:session.talla_color, created_at:new Date().toISOString() };
  pendingQuotes.set(session.waId,quote); io.emit("new_pending",quote);
}

function parseWebMessage(text) {
  if(!text.includes("interesado")||!text.includes("producto"))return null;
  const result={producto:null,precio:null,codigo:null,foto_url:null,talla:null,color:null,tamano:null};
  const productoMatch=text.match(/^([^\n]+)\nPrecio:/m); if(productoMatch)result.producto=productoMatch[1].trim();
  const precioMatch=text.match(/Precio:\s*₡?\s*([\d\s,\.]+)/i); if(precioMatch)result.precio=parseInt(precioMatch[1].replace(/[\s,\.]/g,''))||0;
  const codigoMatch=text.match(/Código:\s*(\w+)/i); if(codigoMatch)result.codigo=codigoMatch[1].trim();
  if(result.codigo)result.foto_url=`${CATALOG_URL}/img/${result.codigo}.webp`;
  const tallaMatch=text.match(/Talla:\s*(.+)/i); if(tallaMatch)result.talla=tallaMatch[1].trim();
  const colorMatch=text.match(/Color:\s*(.+)/i); if(colorMatch)result.color=colorMatch[1].trim();
  const tamanoMatch=text.match(/Tamaño:\s*(.+)/i); if(tamanoMatch)result.tamano=tamanoMatch[1].trim();
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
  if(msg.message?.conversation)text=msg.message.conversation;
  else if(msg.message?.extendedTextMessage?.text)text=msg.message.extendedTextMessage.text;
  else if(msg.message?.imageMessage?.caption)text=msg.message.imageMessage.caption;

  const displayPhone=realPhone?formatPhone(realPhone):waId;
  addToChatHistory(waId,"in",text||"(mensaje)");
  console.log(`📥 ${displayPhone}: ${text||"(mensaje)"}`);

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

  // Detectar mensaje web ("Me interesa")
  const webData=parseWebMessage(text);
  if(webData&&webData.codigo){
    session.producto=webData.producto; session.precio=webData.precio; session.codigo=webData.codigo; session.foto_url=webData.foto_url;
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

  // ============ IA CLASIFICADORA: Detectar interrupciones en medio del flujo ============
  if(session.state!=="NEW"&&session.state!=="PREGUNTANDO_ALGO_MAS"){
    // Paso 1: FAQ por regex (gratis)
    const faqResponse=checkFaqRegex(lower);
    if(faqResponse){
      const recordatorio=FRASES.recordatorio_flujo[session.state]||"";
      await sendTextWithTyping(waId,recordatorio?`${faqResponse}\n\n${recordatorio}`:faqResponse);
      return;
    }
    // Paso 2: IA clasificadora (solo en estados que esperan respuesta específica)
    const estadosConRespuesta=["ESPERANDO_TALLA","PREGUNTANDO_INTERES","ESPERANDO_ZONA","PREGUNTANDO_METODO","PRECIO_TOTAL_ENVIADO","ESPERANDO_SINPE","PAGO_CONFIRMADO_ENVIO"];
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

  // ============ MÁQUINA DE ESTADOS ============

  if(session.state==="ESPERANDO_TALLA"){
    session.talla_color=text.trim(); session.state="ESPERANDO_CONFIRMACION_VENDEDOR";
    await sendTextWithTyping(waId,frase("revisando",waId)); addPendingQuote(session); return;
  }

  if(session.state==="ESPERANDO_CONFIRMACION_VENDEDOR"){await sendTextWithTyping(waId,frase("espera_vendedor",waId));return;}

  if(session.state==="PREGUNTANDO_INTERES"){
    if(lower==="si"||lower==="sí"||lower.includes("quiero")||lower.includes("interesa")){
      account.metrics.intent_yes+=1; session.state="ESPERANDO_ZONA";
      await sendTextWithTyping(waId,`${frase("confirmacion",waId)}\n\n${frase("pedir_zona",waId)}`);
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

  if(session.state==="ESPERANDO_ZONA"){
    session.client_zone=text.trim();
    if(offersShipping()&&offersPickup()){
      session.state="PREGUNTANDO_METODO"; await sendTextWithTyping(waId,frase("pedir_metodo",waId));
    }else if(offersShipping()){
      session.delivery_method="envio"; session.state="ZONA_RECIBIDA";
      io.emit("zone_received",{waId,zone:session.client_zone,precio:session.precio});
      await sendTextWithTyping(waId,frase("espera_zona",waId));
    }else{
      session.delivery_method="recoger"; session.state="PRECIO_TOTAL_ENVIADO";
      const price=session.precio||0;
      await sendTextWithTyping(waId,`📦 ${session.producto||'Artículo'}\n👕 ${session.talla_color||'-'}\n💰 Precio: ₡${price.toLocaleString()}\n\n🏪 Retiro en tienda\n\n¿Estás de acuerdo?\n\n1. ✅ Sí\n2. ❌ No\n\nResponde con el número 👆`);
    }
    saveDataToDisk();return;
  }

  if(session.state==="PREGUNTANDO_METODO"){
    if(lower.includes("envio")||lower.includes("envío")||lower==="si"||lower==="1"){
      session.delivery_method="envio"; session.state="ZONA_RECIBIDA"; account.metrics.delivery_envio+=1;
      io.emit("zone_received",{waId,zone:session.client_zone,precio:session.precio});
      await sendTextWithTyping(waId,frase("espera_zona",waId)); saveDataToDisk();return;
    }
    if(lower.includes("recoger")||lower.includes("tienda")||lower==="no"||lower==="2"){
      session.delivery_method="recoger"; session.state="PRECIO_TOTAL_ENVIADO"; account.metrics.delivery_recoger+=1;
      const price=session.precio||0;
      await sendTextWithTyping(waId,`📦 ${session.producto||'Artículo'}\n👕 ${session.talla_color||'-'}\n💰 Precio: ₡${price.toLocaleString()}\n\n🏪 Retiro en tienda:\n📍 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}\n\n¿Estás de acuerdo?\n\n1. ✅ Sí\n2. ❌ No\n\nResponde con el número 👆`);
      saveDataToDisk();return;
    }
    await sendTextWithTyping(waId,frase("pedir_metodo",waId));return;
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
      io.emit("sinpe_received",{waId,reference:session.sinpe_reference,phone:profile.phone||waId,name:profile.name||"",producto:session.producto,talla:session.talla_color,method:session.delivery_method,foto_url:session.foto_url});return;
    }
    if(lower.includes("pague")||lower.includes("listo")||lower.includes("ya")||lower.includes("sinpe")||lower.includes("transferi")){
      await sendTextWithTyping(waId,"Mandame la foto del comprobante 🧾📸");
    }else{
      await sendTextWithTyping(waId,"Dame un chance, estoy esperando tu comprobante de SINPE 🧾");
    }
    return;
  }

  if(session.state==="PAGO_CONFIRMADO_ENVIO"){
    if(text.trim().length>5){
      profile.purchases=(profile.purchases||0)+1;
      await sendTextWithTyping(waId,frase("fin_envio",waId).replace("{days}",DELIVERY_DAYS));
      io.emit("sale_completed",{waId,phone:profile.phone||waId,name:profile.name||"",producto:session.producto,method:"envio",direccion:text.trim()});
      resetSession(session);saveDataToDisk();return;
    }
    await sendTextWithTyping(waId,"Ocupo tu dirección completa para el envío 📍 (provincia, cantón, distrito y señas)");return;
  }

  // ============ ESTADO NEW ============

  // ✅ PRIMERO: Chequear FAQs (incluso si viene con "hola" adelante)
  const faqResp=checkFaqRegex(lower);
  if(faqResp){
    // Si también incluye saludo, saludar + responder FAQ
    if(!session.saludo_enviado&&/hola|buenas|buenos|pura vida|hey/.test(lower)){
      session.saludo_enviado=true;saveDataToDisk();
      await sendTextWithTyping(waId,`¡Hola! Pura vida 🙌\n\n${faqResp}`);
    }else{
      await sendTextWithTyping(waId,faqResp);
    }
    return;
  }

  if(/^(gracias|muchas gracias)/.test(lower)){await sendTextWithTyping(waId,frase("gracias",waId));return;}

  // SEGUNDO: Saludo puro (sin pregunta)
  if(!session.saludo_enviado&&/^(hola|buenas|buenos|pura vida|hey)/.test(lower)){
    session.saludo_enviado=true;saveDataToDisk();
    await sendTextWithTyping(waId,frase("saludos",waId));return;
  }

  // TERCERO: Catálogo
  if(!session.catalogo_enviado&&(session.saludo_enviado||/tienen|hay|busco|quiero|necesito|faldas?|blusas?|vestidos?|jeans|pantalon|bolsos?|fajas?|ropa|catalogo|productos/.test(lower))){
    session.saludo_enviado=true;session.catalogo_enviado=true;saveDataToDisk();
    await sendTextWithTyping(waId,`${frase("catalogo",waId)}\n\n${CATALOG_URL}`);return;
  }

  if(session.catalogo_enviado&&/tienen|hay|busco|quiero|necesito/.test(lower)){
    await sendTextWithTyping(waId,`Revisá el catálogo y si te gusta algo, dale al botón 'Me interesa' 🙌\n\n${CATALOG_URL}`);return;
  }

  // Fallback
  if(!session.catalogo_enviado){
    session.catalogo_enviado=true;saveDataToDisk();
    await sendTextWithTyping(waId,`${frase("catalogo",waId)}\n\n${CATALOG_URL}`);
  }else{
    const aiResponse=await askAI(text);
    if(aiResponse){await sendTextWithTyping(waId,aiResponse);}
    else{await sendTextWithTyping(waId,"Si tenés alguna duda, podés llamarnos al 2237-3335 o visitarnos en tienda 🙌");}
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
      session.state = "PAGO_CONFIRMADO_ENVIO";
      await sendTextWithTyping(clientWaId, frase("pedir_direccion", clientWaId));
      saveDataToDisk();
      return { success: true, message: "Pago confirmado, pidiendo dirección" };
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
      socket.emit("init_data", { pending: Array.from(pendingQuotes.values()), history: chatHistory.slice(-50), contacts: Array.from(profiles.values()), metrics: account.metrics });
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
});

// ============ ENDPOINTS ============
app.get("/health", (req, res) => res.send("OK"));
app.get("/status", (req, res) => res.json({ connection: connectionStatus, phone: connectedPhone, botPaused, storeOpen: isStoreOpen(), metrics: account.metrics }));

// ============ INICIAR ============
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
