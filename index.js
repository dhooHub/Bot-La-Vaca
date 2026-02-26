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

// CORS
app.use((req, res, next) => {
  const allowedOrigins = ['https://lavacacr.com', 'https://www.lavacacr.com', 'http://localhost:3000'];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Pwd');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
const server = http.createServer(app);
const io = new Server(server);
const logger = pino({ level: "silent" });

// Servir archivos estáticos con headers anti-caché para HTML
// Interceptar acceso directo a control.html → redirigir a /admin
app.get("/control.html", (req, res) => {
  res.redirect("/admin");
});

app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store'
      });
    }
  }
}));

// Panel operador en raíz - redirigir a /p
app.get("/", (req, res) => {
  res.redirect("/p");
});

// Panel en ruta nueva (sin caché de Render)
app.get("/p", (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store'
  });
  res.sendFile(path.join(__dirname, "public", "panel.html"));
});

// Manifest vacío para desactivar PWA (los links no funcionan en modo standalone)
app.get("/manifest.json", (req, res) => {
  res.set({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.json({ name: "TICObot", short_name: "TICObot", display: "browser", start_url: "/p" });
});
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PANEL_PIN = process.env.PANEL_PIN || "1234";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "lavaca2026";
const USER_PASSWORD = process.env.USER_PASSWORD || "usuario2026";
const adminTokens = new Map(); // Tokens de sesión temporales
const STORE_NAME = process.env.STORE_NAME || "La Vaca CR";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
// Horario tienda: Lun-Sáb 9am-7pm, Dom 10am-6pm
const HOURS_WEEKDAY_START = 9;
const HOURS_WEEKDAY_END = 19;   // 7pm
const HOURS_SUNDAY_START = 10;
const HOURS_SUNDAY_END = 18;    // 6pm
const HOURS_DAY = "9am - 6:50pm";
const DELAY_MIN = 5;
const DELAY_MAX = 20;
const SESSION_TIMEOUT = 8 * 60 * 60 * 1000; // 8 horas — nueva conversación al día siguiente
const STORE_TYPE = (process.env.STORE_TYPE || "fisica_con_envios").toLowerCase();
const STORE_ADDRESS = process.env.STORE_ADDRESS || "Heredia centro, 100 mts sur de la esquina del Testy";
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
let salesLog = []; // Registro de ventas completadas
let alertsLog = []; // Registro de alertas enviadas al empleado
let crmClients = new Map(); // Mini CRM - Clientes con historial de compras
let categoriasActivas = new Set(); // Categorías con showIndex: 1 (tienen productos)

// Cargar categorías activas desde lavacacr.com
async function loadCategoriasActivas() {
  try {
    const response = await fetch('https://lavacacr.com/categories.json');
    const categories = await response.json();
    categoriasActivas.clear();
    categories.forEach(cat => {
      if (cat.showIndex === 1) {
        categoriasActivas.add(cat.id.toLowerCase());
      }
    });
    console.log("📂 Categorías activas:", Array.from(categoriasActivas).join(", ") || "ninguna");
  } catch(e) {
    console.log("⚠️ Error cargando categorías:", e.message);
    // Por defecto asumir solo damas
    categoriasActivas.add("damas");
  }
}

// Verificar si una categoría está activa
function categoriaActiva(tipo) {
  const mapeo = {
    caballero: "caballeros",
    caballeros: "caballeros",
    hombre: "caballeros",
    hombres: "caballeros",
    masculino: "caballeros",
    nino: "ninos",
    ninos: "ninos",
    niño: "ninos",
    niños: "ninos",
    nina: "ninos",
    niña: "ninos",
    infantil: "ninos",
    escolar: "escolar",
    accesorio: "accesorios",
    accesorios: "accesorios",
    dama: "damas",
    damas: "damas",
    mujer: "damas",
    mujeres: "damas",
    femenino: "damas"
  };
  const catId = mapeo[tipo.toLowerCase()] || tipo.toLowerCase();
  return categoriasActivas.has(catId);
}
let chatHistory = [];
const MAX_CHAT_HISTORY = 500;
const account = { metrics: { chats_total:0, quotes_sent:0, intent_yes:0, intent_no:0, delivery_envio:0, delivery_recoger:0, sinpe_confirmed:0, sales_completed:0, total_revenue:0, estados_sent:0, mensajes_enviados:0, ia_calls:0 } };
let quickReplies = [];

function hasPhysicalLocation() { return STORE_TYPE === "fisica_con_envios" || STORE_TYPE === "fisica_solo_recoger"; }
function offersShipping() { return STORE_TYPE === "virtual" || STORE_TYPE === "fisica_con_envios"; }
function offersPickup() { return STORE_TYPE === "fisica_con_envios" || STORE_TYPE === "fisica_solo_recoger"; }
function normalizePhone(input) { const d = String(input||"").replace(/[^\d]/g,"").replace(/@.*/,""); if(d.length===8)return"506"+d; if(d.startsWith("506")&&d.length===11)return d; return d; }
function toJid(phone) { return normalizePhone(phone)+"@s.whatsapp.net"; }
function fromJid(jid) { return jid?jid.replace(/@.*/,""):""; }
function formatPhone(waId) { const d=normalizePhone(waId); if(d.length===11&&d.startsWith("506"))return`${d.slice(0,3)} ${d.slice(3,7)}-${d.slice(7)}`; return waId; }
function getCostaRicaTime() { const now=new Date(); const utc=now.getTime()+(now.getTimezoneOffset()*60000); const cr=new Date(utc-(6*60*60*1000)); return{hour:cr.getHours(),minute:cr.getMinutes(),day:cr.getDay(),date:cr}; }
function getCostaRicaDayName() { const dias = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"]; return dias[getCostaRicaTime().day]; }
function isStoreOpen() {
  const{hour,day}=getCostaRicaTime();
  if(day===0){ // Domingo
    return hour>=HOURS_SUNDAY_START && hour<HOURS_SUNDAY_END;
  }
  // Lunes(1) a Sábado(6)
  return hour>=HOURS_WEEKDAY_START && hour<HOURS_WEEKDAY_END;
}
function norm(s="") { return String(s).toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g,""); }

// ✅ Corrector inteligente de typos (Levenshtein + duplicados)
// No usa IA, no consume tokens, corrige automáticamente
function fixTypos(text) {
  const VOCAB = [
    'blusa','blusas','vestido','vestidos','jean','jeans','pantalon','pantalones',
    'falda','faldas','short','shorts','camisa','camisas','zapato','zapatos',
    'sueter','sueters','conjunto','conjuntos','camiseta','camisetas',
    'sandalia','sandalias','bolso','bolsos','cartera','carteras',
    'top','tops','body','bodys','leggin','leggins','licra','licras',
    'tienen','precio','precios','disponible','disponibles','catalogo',
    'envio','envios','horario','abierto','cerrado','comprar','quiero',
    'busco','necesito','hay','venden','muestren','enseneme',
    'mujer','mujeres','hombre','hombres','dama','damas','caballero','caballeros',
    'nina','ninas','nino','ninos',
    'sinpe','transferencia','efectivo','recoger','domicilio','direccion',
    'talla','tallas','grande','mediano','pequeno',
  ];
  function lev(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const m = [];
    for (let i = 0; i <= b.length; i++) m[i] = [i];
    for (let j = 0; j <= a.length; j++) m[0][j] = j;
    for (let i = 1; i <= b.length; i++)
      for (let j = 1; j <= a.length; j++)
        m[i][j] = b[i-1] === a[j-1] ? m[i-1][j-1] : Math.min(m[i-1][j-1]+1, m[i][j-1]+1, m[i-1][j]+1);
    return m[b.length][a.length];
  }
  // 1. Eliminar palabras duplicadas consecutivas ("y y", "de de")
  let fixed = text.replace(/\b(\w+)\s+\1\b/gi, '$1');
  // 2. Corregir cada palabra contra el vocabulario
  const words = fixed.split(/(\s+)/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\s+$/.test(w) || w.length < 3) continue;
    const wN = w.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
    if (VOCAB.includes(wN)) continue;
    let best = null, bestD = Infinity;
    for (let v = 0; v < VOCAB.length; v++) {
      if (Math.abs(VOCAB[v].length - wN.length) > 2) continue;
      const d = lev(wN, VOCAB[v]);
      if (d < bestD) { bestD = d; best = VOCAB[v]; }
    }
    const maxD = wN.length <= 5 ? 1 : 2;
    if (best && bestD > 0 && bestD <= maxD) words[i] = best;
  }
  return words.join('');
}
function getHumanDelay() { return(Math.floor(Math.random()*(DELAY_MAX-DELAY_MIN+1))+DELAY_MIN)*1000; }
function sleep(ms) { return new Promise(resolve=>setTimeout(resolve,ms)); }
function extractPrice(text) { const match=String(text).match(/₡?\s*([\d\s,\.]+)/); if(match)return parseInt(match[1].replace(/[\s,\.]/g,''))||0; return 0; }

// ============ INTELIGENCIA ARTIFICIAL ============

// ============ CATÁLOGO DINÁMICO ============
let catalogProducts = [];

let lastCatalogLoad = 0;

async function loadCatalog() {
  // Recargar máximo cada 2 minutos
  if (Date.now() - lastCatalogLoad < 2 * 60 * 1000 && catalogProducts.length > 0) {
    return catalogProducts;
  }
  
  try {
    const response = await fetch(`${CATALOG_URL}/products.js?v=${Date.now()}`);
    if (!response.ok) throw new Error("No se pudo cargar");
    const text = await response.text();
    
    // Extraer el array PRODUCTOS del archivo JS
    const match = text.match(/const\s+PRODUCTOS\s*=\s*\[([\s\S]*?)\];/);
    if (!match) throw new Error("Formato inválido");
    
    // Parsear el array
    const arrayContent = `[${match[1]}]`;
    const productos = eval(arrayContent);
    
    catalogProducts = productos.map(p => ({
      codigo: p[0],
      nombre: p[1],
      precio: p[2],
      descuento: p[3] || 0,
      categoria: p[5] || "",
      tallas: p[6] || "",
      agotado: p[9] || 0
    }));
    
    lastCatalogLoad = Date.now();
    console.log(`📦 Catálogo cargado: ${catalogProducts.length} productos`);
    return catalogProducts;
  } catch (error) {
    console.log("⚠️ Error cargando catálogo:", error.message);
    return catalogProducts; // Devolver caché si falla
  }
}




// ============ BUSCAR PRECIOS EN CATÁLOGO POR TIPO DE PRODUCTO ============
function buscarPreciosPorTipo(query, rootFiltro = null) {
  const lower = fixTypos(query).toLowerCase();
  
  // Mapeo de palabras a subcategorías del catálogo
  const mapeoCategoria = {
    'jean': 'jeans', 'jeans': 'jeans',
    'blusa': 'blusas', 'blusas': 'blusas',
    'vestido': 'vestidos', 'vestidos': 'vestidos',
    'falda': 'faldas', 'faldas': 'faldas',
    'pantalon': 'pantalones', 'pantalones': 'pantalones',
    'short': 'shorts', 'shorts': 'shorts',
    'chaqueta': 'chaquetas', 'chaquetas': 'chaquetas',
    'sueter': 'chaquetas', 'sweater': 'chaquetas', 'saco': 'chaquetas',
    'accesorio': 'accesorios', 'accesorios': 'accesorios',
    'camisa': 'camisas', 'camisas': 'camisas',
    'conjunto': 'conjuntos', 'conjuntos': 'conjuntos',
    'zapato': 'zapatos', 'zapatos': 'zapatos',
    'sandalia': 'sandalias', 'sandalias': 'sandalias'
  };
  
  // Mapeo de subcategoría a categoría raíz (para el link)
  const mapeoRoot = {
    'jeans': 'damas', 'blusas': 'damas', 'vestidos': 'damas',
    'faldas': 'damas', 'pantalones': 'damas', 'shorts': 'damas',
    'chaquetas': 'damas', 'accesorios': 'damas', 'camisas': 'damas',
    'conjuntos': 'damas', 'zapatos': 'damas', 'sandalias': 'damas'
  };
  
  // Palabras clave de estilo/descripción que se buscan en el nombre del producto
  // Descriptores ordenados de más específico a menos
  const estilos = [
    // Estilos compuestos primero
    'pretina ancha', 'tiro alto', 'tiro bajo', 'tiro medio', 'manga larga', 'manga corta',
    'azul oscuro', 'azul claro', 'verde oscuro', 'verde claro',
    // Estilos de corte/fit
    'pretina', 'plus', 'skinny', 'recto', 'campana', 'ancho', 'slim', 'straight',
    'tejida', 'tejido', 'crop', 'palazzo', 'culotte', 'mom', 'wide', 'barrel', 'boyfriend',
    // Acabados
    'rasgado', 'bordado', 'floreado', 'estampado', 'liso', 'elastizado', 'bolsillo',
    'largo', 'corta', 'corto',
    // Colores
    'negro', 'negra', 'blanco', 'blanca', 'azul', 'rojo', 'roja', 'verde',
    'amarillo', 'amarilla', 'rosado', 'rosada', 'rosa', 'morado', 'morada',
    'gris', 'beige', 'cafe', 'naranja', 'celeste', 'lila', 'fucsia',
    'coral', 'vino', 'crema', 'dorado', 'plateado', 'turquesa'
  ];
  
  // Buscar qué categoría menciona
  let categoriaId = null;
  let categoriaDisplay = null;
  for (const [palabra, catId] of Object.entries(mapeoCategoria)) {
    if (lower.includes(palabra)) {
      categoriaId = catId;
      categoriaDisplay = palabra.endsWith('s') ? palabra : palabra + 's';
      break;
    }
  }
  
  if (!categoriaId) return null;
  
  // FILTRO 1: Por categoría (subcategoría)
  // Nota: el catálogo online solo tiene productos para damas.
  // Si se pide otro género, se retorna encontrados=0 para derivar a humano.
  if (rootFiltro && rootFiltro !== 'damas') {
    return { categoria: categoriaId, rootCategoria: rootFiltro, display: categoriaId, encontrados: 0, rootSolicitado: rootFiltro };
  }
  const todosCategoria = catalogProducts.filter(p => 
    p.categoria && p.categoria.toLowerCase() === categoriaId && !p.agotado
  );
  
  if (todosCategoria.length === 0) return { categoria: categoriaId, display: categoriaDisplay, encontrados: 0 };
  
  // FILTRO 2: Por estilo/descripción (buscar en nombre del producto)
  let estiloDetectado = null;
  for (const estilo of estilos) {
    if (lower.includes(estilo)) {
      estiloDetectado = estilo;
      break;
    }
  }
  
  let filtradosPorEstilo = todosCategoria;
  if (estiloDetectado) {
    filtradosPorEstilo = todosCategoria.filter(p => 
      p.nombre.toLowerCase().includes(estiloDetectado)
    );
  }
  
  // FILTRO 3: Por talla específica
  // Primero buscar tallas numéricas (19/20, 5/6, etc), luego letras como palabra suelta
  const regexTallaNum = /(\d{1,2}\/\d{1,2})/;
  const regexTallaLetra = /\b(xxl|2xl|3xl|xl|xs|s|m|l)\b/i;
  let matchTalla = lower.match(regexTallaNum);
  if (!matchTalla) matchTalla = lower.match(regexTallaLetra);
  let tallaDetectada = null;
  if (matchTalla) {
    const posibleTalla = matchTalla[1].toUpperCase();
    const esTallaReal = todosCategoria.some(p => {
      if (!p.tallas) return false;
      return p.tallas.split(',').some(t => t.trim().toUpperCase() === posibleTalla);
    });
    if (esTallaReal) tallaDetectada = posibleTalla;
  }
  
  let filtradosPorTalla = filtradosPorEstilo;
  let tallaDisponible = true;
  if (tallaDetectada) {
    filtradosPorTalla = filtradosPorEstilo.filter(p => {
      if (!p.tallas) return false;
      return p.tallas.split(',').some(t => t.trim().toUpperCase() === tallaDetectada);
    });
    if (filtradosPorTalla.length === 0) tallaDisponible = false;
  }
  
  // Productos finales
  const productos = filtradosPorTalla.length > 0 ? filtradosPorTalla : filtradosPorEstilo;
  
  // Calcular precios (con descuento aplicado)
  const precios = productos.map(p => {
    if (p.descuento > 0) return Math.round(p.precio * (1 - p.descuento / 100));
    return p.precio;
  });
  
  const minPrecio = Math.min(...precios);
  const maxPrecio = Math.max(...precios);
  
  // Info de descuentos
  const conDescuento = productos.filter(p => p.descuento > 0);
  const maxDescuento = conDescuento.length > 0 ? Math.max(...conDescuento.map(p => p.descuento)) : 0;
  
  // Root para el link
  const rootId = rootOverride || mapeoRoot[categoriaId] || 'damas';
  
  // Construir display descriptivo
  let displayFinal = categoriaDisplay;
  if (estiloDetectado) displayFinal = categoriaDisplay + ' ' + estiloDetectado.toUpperCase();
  
  return {
    categoria: categoriaId,
    rootCategoria: rootId,
    display: displayFinal,
    encontrados: productos.length,
    minPrecio,
    maxPrecio,
    conDescuento: conDescuento.length,
    maxDescuento,
    productos,
    estiloDetectado,
    tallaDetectada,
    tallaDisponible,
    totalCategoria: todosCategoria.length
  };
}


function searchCatalog(query) {
  const lower = fixTypos(query).toLowerCase();
  const keywords = {
    dama: ["dama", "damas", "mujer", "mujeres", "femenino", "femenina"],
    caballero: ["caballero", "caballeros", "hombre", "hombres", "masculino"],
    nino: ["niño", "niños", "nino", "ninos", "infantil", "chiquito"],
    nina: ["niña", "niñas", "nina", "ninas"]
  };
  
  // Detectar qué tipo busca
  let tipoBuscado = null;
  for (const [tipo, words] of Object.entries(keywords)) {
    if (words.some(w => lower.includes(w))) {
      tipoBuscado = tipo;
      break;
    }
  }
  
  // Detectar si busca ofertas/descuentos
  const buscaOfertas = /oferta|descuento|rebaja|promocion|promo|barato/i.test(lower);
  
  // Detectar categoría específica
  const categorias = ["blusa", "vestido", "jean", "pantalon", "falda", "short", "top", "camisa"];
  let categoriaBuscada = categorias.find(c => lower.includes(c));
  
  let resultados = catalogProducts.filter(p => !p.agotado);
  
  // Filtrar por tipo (dama, caballero, etc.) buscando en el nombre
  if (tipoBuscado) {
    const palabrasTipo = keywords[tipoBuscado];
    resultados = resultados.filter(p => 
      palabrasTipo.some(w => p.nombre.toLowerCase().includes(w))
    );
  }
  
  // Filtrar por categoría
  if (categoriaBuscada) {
    resultados = resultados.filter(p => 
      p.nombre.toLowerCase().includes(categoriaBuscada) || 
      p.categoria.toLowerCase().includes(categoriaBuscada)
    );
  }
  
  // Filtrar por ofertas
  if (buscaOfertas) {
    resultados = resultados.filter(p => p.descuento > 0);
  }
  
  return {
    encontrados: resultados,
    tipoBuscado,
    categoriaBuscada,
    buscaOfertas,
    totalCatalogo: catalogProducts.length
  };
}

function getCatalogSummary() {
  if (catalogProducts.length === 0) return "";
  
  const conDescuento = catalogProducts.filter(p => p.descuento > 0 && !p.agotado);
  const disponibles = catalogProducts.filter(p => !p.agotado);
  
  // Agrupar por categoría
  const categorias = {};
  disponibles.forEach(p => {
    const cat = p.categoria || "otros";
    if (!categorias[cat]) categorias[cat] = 0;
    categorias[cat]++;
  });
  
  let summary = `\n\n📦 CATÁLOGO ACTUAL (${disponibles.length} productos disponibles):\n`;
  summary += `- Categorías: ${Object.keys(categorias).join(", ")}\n`;
  if (conDescuento.length > 0) {
    const maxDesc = Math.max(...conDescuento.map(p => p.descuento));
    summary += `- ¡Hay ${conDescuento.length} productos con descuento! (hasta ${maxDesc}% OFF)\n`;
  }
  
  return summary;
}

const STORE_CONTEXT = `Sos el asistente virtual de La Vaca CR, una tienda de ropa y accesorios ubicada en Heredia, Costa Rica.

INFORMACIÓN DE LA TIENDA:
- Nombre: La Vaca CR
- Ubicación: Heredia centro, 200m sur de Correos de CR
- Horario: Lunes a Sábado 9am-7pm, Domingo 10am-6pm
- Teléfono: 2237-3335
- WhatsApp: Este mismo chat (no dar otro número, ya están escribiendo aquí)
- Catálogo online: https://www.lavacacr.com
- SIEMPRE que menciones el sitio web usá el link completo con https:// para que sea clicable: https://www.lavacacr.com (NUNCA escribas solo "www.lavacacr.com")

⚠️ MUY IMPORTANTE - CÓMO RESPONDER CONSULTAS DE PRODUCTOS:
SINÓNIMOS (tratá estas palabras como iguales):
- dama = damas = mujer = mujeres = femenino
- caballero = caballeros = hombre = hombres = masculino  
- niño = niña = niños = niñas = infantil

REGLA PARA PRODUCTOS DE MUJER/DAMA/FEMENINO:
Si preguntan por CUALQUIER producto para mujer/dama/femenino, respondé:
"¡Hola! Pura vida 🙌 Te invito a revisar nuestro catálogo en https://www.lavacacr.com donde tenemos ropa para dama. Si te gusta algo, dale al botón 'Me interesa' y te confirmamos disponibilidad 😊"

REGLA PARA PRODUCTOS QUE NO ESTÁN EN CATÁLOGO:
Si preguntan por productos para hombre/caballero, niños/niñas, o cualquier producto que no encontrés en el catálogo, respondé:
"¡Hola! Pura vida 🙌 Dame un momento, te paso con un compañer@ y ya te respondemos 😊"

Si preguntan "¿solo eso tienen?", "¿eso es todo?", "¿no hay más?", "¿solo esas opciones?" o similar:
- Respondé: "De momento en el catálogo online tenemos esos. Dame un momento, te paso con un compañer@ para que te ayude mejor 😊"

Si preguntan por productos que NO son ropa de damas (uniformes, ropa de niños, ropa de hombre, fajas, etc.):
- Respondé: "Dame un momento, te paso con un compañer@ y ya te respondemos 😊"
- NUNCA digas "hay en tienda física" ni "visitanos en tienda"
- NUNCA digas que no tenemos — pasá la consulta al compañer@

LO QUE SÍ PODÉS RESPONDER:
- Horarios de atención
- Ubicación y cómo llegar
- Tallas disponibles: S, M, L, XL, XXL y Talla Plus en algunos estilos
- Apartados: Se aparta con la cuarta parte del costo y tenés dos meses para retirar
- Cambios: 8 días con factura y sin usar. No se hacen devoluciones de dinero.
- Garantía: 30 días contra defectos de fábrica
- Métodos de pago: SINPE Móvil y efectivo en tienda (NO tarjetas)
- IMPORTANTE: Cuando el cliente necesite contacto humano (objetos perdidos, reclamos, consultas especiales), SOLO recomendar llamar al teléfono 2237-3335. NUNCA decir "escríbenos por WhatsApp" porque YA están escribiendo por WhatsApp.
- Si preguntan por SINPE o formas de pago SIN tener pedido activo, responder: "¡Claro! Para ventas en línea aceptamos SINPE Móvil al ${SINPE_NUMBER} a nombre de ${SINPE_NAME}. En la tienda podés pagar efectivo, tarjeta y también SINPE. ¡Te esperamos con gusto! 😊"
- Si preguntan por MAYOREO, VENTAS AL POR MAYOR, o si somos MAYORISTAS: "No vendemos al por mayor, solo al detalle 🙌 Te invitamos a visitarnos en nuestra tienda en Heredia centro, 200m sur de Correos de CR" o visitar nuestro catalogo en linea https://www.lavacacr.com
- ENVÍOS: Sí hacemos envíos a todo el país con Correos de Costa Rica:
  * GAM (área metropolitana): ₡2,500
  * Fuera de GAM: ₡3,500
  * Tiempo de entrega: 4-5 días hábiles

🚫 NUNCA RESPONDAS SOBRE:
- Precios de productos (decí: "Los precios los vemos cuando elijas el producto del catálogo 🙌")
- Disponibilidad de productos específicos del catálogo (decí: "Revisá el catálogo en https://www.lavacacr.com y si te gusta algo, dale al botón 'Me interesa' 🙌")

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
    const diaActual = getCostaRicaDayName();
    const {hour, minute} = getCostaRicaTime();
    const horaActual = `${hour}:${minute < 10 ? '0' : ''}${minute}`;
    const contextoDia = `\n\n📅 INFORMACIÓN ACTUAL:\n- Hoy es ${diaActual}\n- Hora actual: ${horaActual}\n- Si preguntan horario de hoy: ${diaActual === 'domingo' ? 'Domingo abrimos de 10am a 6pm' : 'Lunes a Sábado abrimos de 9am a 7pm'}`;
    
    // Cargar catálogo y buscar si es relevante
    await loadCatalog();
    let contextoCatalogo = "";
    
    // Detectar si pregunta por productos, ofertas o categorías
    const preguntaCatalogo = /tienen|hay|ofrec|venden|busco|quiero|necesito|oferta|descuento|rebaja|promo|dama|caballero|hombre|mujer|niñ|nin|blusa|vestido|jean|pantalon|falda|ropa/i.test(userMessage);
    
    if (preguntaCatalogo && catalogProducts.length > 0) {
      const busqueda = searchCatalog(userMessage);
      
      if (busqueda.encontrados.length > 0) {
        // Hay productos que coinciden
        const ejemplos = busqueda.encontrados.slice(0, 3).map(p => 
          `${p.nombre}${p.descuento > 0 ? ` (${p.descuento}% OFF)` : ''}`
        ).join(", ");
        
        contextoCatalogo = `\n\n🔍 BÚSQUEDA EN CATÁLOGO:\n`;
        contextoCatalogo += `- Se encontraron ${busqueda.encontrados.length} productos que coinciden\n`;
        contextoCatalogo += `- Ejemplos: ${ejemplos}\n`;
        contextoCatalogo += `- Decile que revise el catálogo en https://www.lavacacr.com donde puede ver esos productos\n`;
        
        if (busqueda.buscaOfertas) {
          const maxDesc = Math.max(...busqueda.encontrados.map(p => p.descuento));
          contextoCatalogo += `- ¡Hay ofertas! Hasta ${maxDesc}% de descuento\n`;
        }
      } else if (busqueda.tipoBuscado && busqueda.tipoBuscado !== 'dama') {
        // Busca algo que no es para dama (niños, caballeros, etc.)
        contextoCatalogo = `\n\n🔍 BÚSQUEDA EN CATÁLOGO:\n`;
        contextoCatalogo += `- El cliente busca productos para ${busqueda.tipoBuscado}\n`;
        contextoCatalogo += `- En el catálogo online NO hay productos para ${busqueda.tipoBuscado}\n`;
        contextoCatalogo += `- Decile que eso lo manejamos EN LA TIENDA FÍSICA en Heredia centro, 200m sur de Correos de CR\n`;
        contextoCatalogo += `- Invitalo a visitarnos donde puede ver toda la variedad\n`;
      } else if (busqueda.buscaOfertas) {
        const conDescuento = catalogProducts.filter(p => p.descuento > 0 && !p.agotado);
        if (conDescuento.length > 0) {
          const maxDesc = Math.max(...conDescuento.map(p => p.descuento));
          contextoCatalogo = `\n\n🔍 OFERTAS EN CATÁLOGO:\n`;
          contextoCatalogo += `- ¡Sí hay ofertas! ${conDescuento.length} productos con descuento (hasta ${maxDesc}% OFF)\n`;
          contextoCatalogo += `- Decile que revise el catálogo en https://www.lavacacr.com para ver las ofertas\n`;
        }
      }
    }
    
    const messages = [{ role: "system", content: STORE_CONTEXT + contextoDia + contextoCatalogo }, ...conversationHistory.slice(-4), { role: "user", content: userMessage }];
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

// Convertir www.x.com sin https:// en links clicables
function sanitizeLinks(text) {
  if (!text) return text;
  return text.replace(/(^|[\s\n(])(?!https?:\/\/)(www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '$1https://$2');
}

function getStateDescription(state) {
  const map = {
    ESPERANDO_DETALLES_FOTO: "Se le pidió qué talla, color o tamaño quiere del producto de la foto",
    ESPERANDO_TALLA: "Se le preguntó qué talla y color quiere",
    ESPERANDO_CONFIRMACION_VENDEDOR: "Se le dijo que estamos verificando disponibilidad",
    MULTI_ESPERANDO_DISPONIBILIDAD: "Tiene una lista de productos, esperamos a que el dueño confirme disponibilidad",
    MULTI_SELECCION_CLIENTE: "Se le mostraron los productos disponibles y debe elegir cuáles comprar",
    PREGUNTANDO_METODO: "Se le preguntó si quiere envío o retiro en tienda",
    ESPERANDO_UBICACION_ENVIO: "Se le pidió Provincia y Cantón para calcular envío",
    ZONA_RECIBIDA: "Se le dijo que estamos calculando el envío",
    PRECIO_TOTAL_ENVIADO: "Se le mostró el precio total y se preguntó si está de acuerdo",
    ESPERANDO_SINPE: "Se le dieron los datos de SINPE y se espera el comprobante",
    ESPERANDO_DATOS_ENVIO: "Se le pidió nombre, teléfono, provincia, cantón, distrito y otras señas para envío",
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
    fs.writeFileSync(path.join(DATA_FOLDER,"ticobot_data.json"),JSON.stringify({account,botPaused,profiles:Array.from(profiles.values()),sessions:sessionsToSave,salesLog,alertsLog,quickReplies},null,2)); 
    saveHistory(); 
  } catch(e){console.log("⚠️ Error guardando:",e.message);} 
}
function loadDataFromDisk() { try { const file=path.join(DATA_FOLDER,"ticobot_data.json"); if(!fs.existsSync(file))return; const data=JSON.parse(fs.readFileSync(file,"utf-8")); if(data.account)Object.assign(account,data.account); if(data.profiles)data.profiles.forEach(p=>profiles.set(p.waId,p)); if(data.sessions)data.sessions.forEach(s=>{
    // Restaurar humanMode si el estado lo requiere (por si el servidor reinició)
    if(s.state==="ESPERANDO_CONFIRMACION_VENDEDOR" && !s.humanMode) {
      s.humanMode = true;
      s.humanModeManual = false;
      s.humanModeAt = s.humanModeAt || Date.now();
      s.humanModeLastActivity = s.humanModeLastActivity || Date.now();
    }
    sessions.set(s.waId,s);
  }); if(data.botPaused!==undefined)botPaused=data.botPaused; if(data.salesLog)salesLog=data.salesLog; if(data.alertsLog)alertsLog=data.alertsLog; if(data.quickReplies)quickReplies=data.quickReplies; console.log(`📂 Datos cargados (${salesLog.length} ventas, ${alertsLog.length} alertas, ${quickReplies.length} atajos)`); } catch(e){console.log("⚠️ Error cargando:",e.message);} }
setInterval(saveDataToDisk, 5 * 60 * 1000);

// ====== AUTO-RELEASE: Volver a bot tras 30 min de inactividad del empleado ======
const HUMAN_MODE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos
const VENDOR_CONFIRM_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos sin confirmar disponibilidad
setInterval(() => {
  const now = Date.now();
  for (const [waId, session] of sessions.entries()) {
    // ── Auto-release humanMode ──
    if (session.humanMode && !session.humanModeManual) {
      const lastActivity = session.humanModeLastActivity || session.humanModeAt || 0;
      if (now - lastActivity >= HUMAN_MODE_TIMEOUT_MS) {
        session.humanMode = false;
        session.humanModeAt = null;
        session.humanModeLastActivity = null;
        console.log(`🤖 Auto-release humanMode: ${waId} vuelve al bot por inactividad`);
        io.emit("human_mode_changed", { waId, humanMode: false, autoRelease: true });
        saveDataToDisk();
      }
    }
    // ── Auto-reset ESPERANDO_CONFIRMACION_VENDEDOR tras 30 min ──
    if (session.state === 'ESPERANDO_CONFIRMACION_VENDEDOR') {
      const stateAge = now - (session.humanModeAt || now);
      if (stateAge >= VENDOR_CONFIRM_TIMEOUT_MS) {
        console.log(`⏰ Auto-reset: ${waId} llevaba 30min en ESPERANDO_CONFIRMACION_VENDEDOR → NEW`);
        session.state = 'NEW';
        session.humanMode = false;
        session.humanModeAt = null;
        session.humanModeLastActivity = null;
        pendingQuotes.delete(waId);
        io.emit('pending_resolved', { waId });
        saveDataToDisk();
      }
    }
  }
}, 60 * 1000); // Revisar cada minuto

// ============ FRASES ============
const FRASES = {
  revisando: ["Dame un toque, voy a revisar si lo tenemos disponible 👍","Dejame chequearlo, ya te confirmo 👌","Un momento, voy a fijarme si queda en stock 🙌","Ya te confirmo disponibilidad, dame un ratito 😊","Voy a revisar de una vez 👍","Permíteme un momento, lo verifico 🙌","Dame chance, ya lo busco 😊","Un segundito, reviso si lo tenemos 👌","Ya miro y te cuento 🙌","Dejame ver si queda, ya te digo 👍"],
  saludos: ["¡Hola! Pura vida 🙌 ¿En qué te ayudo?","¡Hola! Con gusto te atiendo 😊","¡Buenas! Pura vida 🙌","¡Hola! ¿Cómo estás? 😊","¡Qué tal! Bienvenid@ 🙌","¡Hola! Qué gusto saludarte 👋","¡Buenas! ¿En qué te puedo servir? 😊","¡Hola! Aquí estamos para ayudarte 🙌","¡Pura vida! ¿Qué ocupás? 😊","¡Hola! Bienvenid@ 🐄"],
  catalogo: ["Te paso el catálogo con los productos disponibles para venta en línea. Si te gusta algo, le das click al botón 'Me interesa' 🙌","Aquí te dejo los productos disponibles para venta en línea. Si ves algo que te guste, dale al botón 'Me interesa' 😊","Te comparto el catálogo de venta en línea. Si algo te llama la atención, tocá 'Me interesa' 🙌"],
  pedir_talla: ["¿Qué talla, tamaño o color lo necesitás? 👕","¿En qué talla y color lo ocupás? 😊","¿Qué talla/color te gustaría? 👗","¿Me decís la talla y el color que buscás? 🙌"],
  si_hay: ["¡Sí lo tenemos disponible! 🎉","¡Qué dicha, sí hay! 🙌","¡Perfecto, lo tenemos! 😊","¡Sí está disponible! 🎉","¡Claro que sí, hay en stock! 🙌"],
  confirmacion: ["¡Buenísimo! 🙌","¡Perfecto! 🎉","¡Excelente! 👍","¡Genial! 🙌","¡Dale! 😊","¡Qué bien! 🎉","¡Tuanis! 🙌","¡Listo! 👍"],
  no_quiere: ["¡Con gusto! 🙌 ¿Te puedo ayudar con algo más?","¡Está bien! 🙌 ¿Hay algo más en que te pueda ayudar?","No hay problema 👍 ¿Ocupás algo más?","Dale 🙌 ¿Te ayudo con alguna otra cosa?"],
  despedida: ["¡Pura vida! 🙌 Cualquier cosa aquí estamos. ¡Que te vaya bien!","¡Con gusto! 😊 Cuando ocupés, nos escribís. ¡Pura vida!","¡Dale! 🙌 Aquí estamos para cuando gustés. ¡Buena vibra!","¡Perfecto! 😊 Si necesitás algo en el futuro, con gusto te ayudamos. ¡Pura vida!"],
  no_hay: ["No tenemos ese disponible en este momento 😔 ¿Te interesa ver otro producto? Con gusto te ayudo 🙌","Uy, ese no nos queda 😔 Pero hay más opciones en el catálogo: https://www.lavacacr.com 🙌","Qué lástima, no lo tenemos 😔 ¿Te ayudo con otro producto?","Ese se nos agotó 😔 Revisá el catálogo: https://www.lavacacr.com 🙌"],
  pedir_zona: ["¿Me podés decir de qué provincia y cantón nos escribís? 📍","Para calcular el envío, ¿de qué provincia y cantón sos? 📍","¿Me decís tu provincia y cantón? 📍","¿De qué provincia y cantón te lo enviaríamos? 📍"],
  pedir_metodo: ["¿Querés que te lo enviemos o preferís recogerlo en tienda? 📦🏪\n\n1. 📦 Envío\n2. 🏪 Recoger en tienda\n\nResponde con el número 👆","¿Cómo lo preferís? 🙌\n\n1. 📦 Envío a tu casa\n2. 🏪 Recoger en tienda\n\nResponde con el número 👆"],
  nocturno: ["¡Hola! De momento estamos fuera de servicio.\n\nNuestro horario de atención es de 9am a 7pm de lunes a sábado y de 10am a 6pm domingos."],
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
    PREGUNTANDO_METODO: "Y sobre tu pedido, ¿envío o retiro en tienda?\n\n1. 📦 Envío\n2. 🏪 Recoger",
    ESPERANDO_UBICACION_ENVIO: "Y sobre tu envío, ¿de qué zona sos? Escribí tu *Provincia y Cantón* 📍",
    ZONA_RECIBIDA: "Y sobre tu pedido, estoy calculando el envío 🙌",
    PRECIO_TOTAL_ENVIADO: "Y sobre tu pedido, ¿estás de acuerdo con el precio?\n\n1. ✅ Sí\n2. ❌ No",
    ESPERANDO_SINPE: "Y sobre tu pago, estoy esperando el comprobante de SINPE 🧾",
    ESPERANDO_DATOS_ENVIO: "Y sobre tu envío, ocupo: *Nombre, Teléfono, Provincia, Cantón, Distrito y Otras señas* 📦",
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
      waId:id, replyJid:null, state:"NEW", producto:null, precio:null, codigo:null, foto_url:null, producto_url:null, talla_color:null, 
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
  session.state="NEW"; session.producto=null; session.precio=null; session.codigo=null; session.foto_url=null; session.producto_url=null; session.talla_color=null; session.shipping_cost=null; session.client_zone=null; session.delivery_method=null; session.sinpe_reference=null; session.humanMode=false; session.humanModeManual=false; session.humanModeAt=null; session.humanModeLastActivity=null; session.pendingDismissed=false; 
  session.envio_nombre=null; session.envio_telefono=null; session.envio_direccion=null;
  session.foto_externa=false; session.foto_base64=null; session.foto_url_guardada=null;
  session.saludo_enviado=false; session.catalogo_enviado=false; session.nocturno_sent_at=null; pendingQuotes.delete(session.waId);
}

function getProfile(waId) { const id=normalizePhone(waId); if(!profiles.has(id))profiles.set(id,{waId:id,name:"",blocked:false,botDisabled:false,purchases:0,created_at:new Date().toISOString()}); return profiles.get(id); }

// ============ MINI CRM ============
function getCrmClient(waId) {
  const id = normalizePhone(waId);
  if (!crmClients.has(id)) {
    crmClients.set(id, {
      waId: id,
      phone: "",
      name: "",
      firstPurchase: null,
      lastPurchase: null,
      purchaseCount: 0,
      totalSpent: 0,
      purchases: [], // {date, producto, monto}
      type: "nuevo" // nuevo, primera, repetido, frecuente
    });
  }
  return crmClients.get(id);
}

function updateCrmClient(waId, saleData) {
  const client = getCrmClient(waId);
  const profile = getProfile(waId);
  
  // Actualizar datos básicos
  client.phone = profile.phone || waId;
  client.name = profile.name || "";
  
  // Registrar compra
  const purchase = {
    date: new Date().toISOString(),
    producto: saleData.producto || "Producto",
    monto: saleData.total || 0
  };
  client.purchases.push(purchase);
  
  // Actualizar estadísticas
  if (!client.firstPurchase) client.firstPurchase = purchase.date;
  client.lastPurchase = purchase.date;
  client.purchaseCount += 1;
  client.totalSpent += purchase.monto;
  
  // Clasificar cliente
  if (client.purchaseCount === 1) {
    client.type = "primera";
  } else if (client.purchaseCount === 2) {
    client.type = "repetido";
  } else {
    client.type = "frecuente";
  }
  
  console.log(`📊 CRM: ${client.name || client.phone} → ${client.type} (${client.purchaseCount} compras, ₡${client.totalSpent.toLocaleString()})`);
  saveCrmData();
  return client;
}

function saveCrmData() {
  try {
    const crmFile = path.join(DATA_FOLDER, "crm_clients.json");
    fs.writeFileSync(crmFile, JSON.stringify(Array.from(crmClients.values()), null, 2));
  } catch(e) { console.log("⚠️ Error guardando CRM:", e.message); }
}

function loadCrmData() {
  try {
    const crmFile = path.join(DATA_FOLDER, "crm_clients.json");
    if (fs.existsSync(crmFile)) {
      const data = JSON.parse(fs.readFileSync(crmFile, "utf-8"));
      data.forEach(c => crmClients.set(c.waId, c));
      console.log(`📊 CRM cargado: ${crmClients.size} clientes`);
    }
  } catch(e) { console.log("⚠️ Error cargando CRM:", e.message); }
}


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

// ✅ Función para enviar alertas a Pushover con registro y callback de atención
async function sendPushoverAlert(tipo, datos) {
  if (!PUSHOVER_USER_KEY || !PUSHOVER_APP_TOKEN) return;
  
  try {
    const phone = datos.phone || datos.waId || "Desconocido";
    const phoneFormatted = formatPhone(phone);
    const chatLink = `${PANEL_URL}/panel.html?chat=${normalizePhone(phone)}`;
    
    // Crear registro de alerta ANTES de enviar
    const alertId = `A-${Date.now().toString(36).toUpperCase()}`;
    const alertEntry = {
      id: alertId,
      tipo,
      fecha: new Date().toISOString(),
      phone: phoneFormatted,
      waId: normalizePhone(phone),
      producto: datos.producto || datos.talla_color || "",
      estado: "pendiente",       // pendiente | atendida
      fecha_atendida: null,
      minutos_respuesta: null,
      receipt: null              // receipt de Pushover para tracking
    };
    
    let title = "";
    let message = "";
    
    if (tipo === "PRODUCTO_FOTO") {
      title = "📷 Cliente interesado - Foto";
      message = `👤 ${phoneFormatted}\n👕 ${datos.talla_color || "Sin especificar"}\n\n💬 Respondé directo en el panel`;
    } else if (tipo === "PRODUCTO_CATALOGO") {
      title = "🛍️ Cliente interesado";
      message = `👤 ${phoneFormatted}\n📦 ${datos.producto || "Producto"}\n💰 ₡${(datos.precio || 0).toLocaleString()}\n👕 ${datos.talla_color || "-"}\n\n💬 Respondé directo en el panel`;
    } else if (tipo === "SINPE") {
      title = "💰 CLIENTE PAGÓ - REVISAR";
      const ses = sessions.get(normalizePhone(datos.waId || phone)) || {};
      const precio = ses.precio || 0;
      const envio = ses.shipping_cost || 0;
      const total = precio + envio;
      message = `📦 ${ses.producto || "Producto"}\n👕 ${ses.talla_color || "-"}\n💰 ₡${total.toLocaleString()}\n📱 Ref: ${datos.reference || "?"}\n👤 ${phoneFormatted}\n\n🧾 Revisar comprobante en panel`;
    } else if (tipo === "ZONA") {
      title = "📍 Zona recibida - Calcular envío";
      message = `🗺️ ${datos.zone || "?"}\n👤 ${phoneFormatted}`;
    } else if (tipo === "MULTI_PRODUCTO") {
      title = "📋 Lista de productos - Revisar";
      message = `📦 ${datos.producto || "?"}\n👤 ${phoneFormatted}`;
    } else if (tipo === "RAFAGA") {
      title = "⚡ Ráfaga de mensajes";
      message = `👤 ${phoneFormatted}\n📝 ${datos.producto || "Cliente enviando múltiples mensajes"}\n💬 ${datos.talla_color || ""}`;
    } else if (tipo === "FUERA_LOGICA") {
      title = "⚠️ NECESITA ATENCIÓN";
      message = `👤 ${datos.name || phoneFormatted}\n💬 "${datos.mensaje || "?"}"\n📍 Estado: ${datos.estado || "?"}\n\n🤖 El bot no supo qué responder`;
    } else if (tipo === "HUMANO_MENSAJE") {
      title = `💬 ${datos.name || phoneFormatted}`;
      message = `${datos.mensaje || "(mensaje)"}\n👤 ${phoneFormatted}`;
    }
    
    if (!title) return;
    
    // Callback URL para registrar cuando el empleado presiona Acknowledge
    const callbackUrl = `${PANEL_URL}/api/pushover/callback`;
    
    const pushBody = {
      token: PUSHOVER_APP_TOKEN,
      user: PUSHOVER_USER_KEY,
      title,
      message,
      priority: 1,          // Alta prioridad: suena aunque esté en silencio, sin acknowledge
      sound: "cashregister"
    };
    
    const response = await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pushBody)
    });
    
    if (response.ok) {
      const result = await response.json();
      alertEntry.receipt = result.receipt || null; // Guardar receipt para tracking
      alertsLog.push(alertEntry);
      // Mantener solo las últimas 500 alertas
      if (alertsLog.length > 500) alertsLog = alertsLog.slice(-500);
      console.log(`📲 Pushover enviado: ${tipo} | alertId: ${alertId}`);
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
  const quote = { waId:session.waId, phone:profile.phone||session.waId, name:profile.name||"", lid:profile.lid||null, producto:session.producto, precio:session.precio, codigo:session.codigo, foto_url:session.foto_url, talla_color:session.talla_color, producto_url:session.producto_url||null, created_at:new Date().toISOString() };
  pendingQuotes.set(session.waId,quote); io.emit("new_pending",quote);
  // Pasar directo a humano — empleado responde sin confirmar stock
  session.humanMode = true;
  session.humanModeManual = false; // Auto — se libera solo tras 30 min de inactividad
  session.humanModeAt = Date.now();
  session.humanModeLastActivity = Date.now();
  io.emit("human_mode_changed", { waId: normalizePhone(session.waId), humanMode: true });
  // Actualizar sesión en panel para pre-llenar resumen
  io.emit("session_updated", { waId: session.waId, producto: session.producto, precio: session.precio, talla_color: session.talla_color, shipping_cost: session.shipping_cost || null, envio_datos_raw: session.envio_datos_raw || null, delivery_method: session.delivery_method || null, client_zone: session.client_zone || null });
  // Enviar notificación
  sendPushoverAlert("PRODUCTO_CATALOGO", quote);
}

function emitSessionUpdate(waId, session) {
  io.emit("session_updated", {
    waId,
    producto: session.producto || null,
    precio: session.precio || null,
    talla_color: session.talla_color || null,
    shipping_cost: session.shipping_cost || null,
    envio_datos_raw: session.envio_datos_raw || null,
    delivery_method: session.delivery_method || null,
    client_zone: session.client_zone || null
  });
}

function parseWebMessage(text) {
  if(!text.includes("interesado")||!text.includes("producto"))return null;
  const result={producto:null,precio:null,codigo:null,foto_url:null,talla:null,color:null,tamano:null,producto_url:null};
  
  // Extraer nombre del producto - múltiples formatos:
  // Formato 1: "producto:\n\nNombre - ₡Precio"
  // Formato 2: "producto:\s*Nombre"  
  // Formato 3: Línea con "Nombre - ₡Precio (X% OFF) - Código: XXX"
  const productoMatch=text.match(/producto:\s*\n?\s*([^\n]+?)(?:\s*-\s*[₡¢]|\s*Precio:|$)/i); 
  if(productoMatch)result.producto=productoMatch[1].trim();
  
  // Si no encontró nombre, buscar patrón "Nombre - ₡Precio"
  if(!result.producto){
    const altMatch = text.match(/\n\s*([^₡¢\n]+?)\s*-\s*[₡¢]/);
    if(altMatch) result.producto = altMatch[1].trim();
  }
  
  // Extraer precio - múltiples formatos:
  // "₡8 175", "₡8,175", "₡8175", "Precio: ₡8175", "- ₡8 175 (25% OFF)"
  const precioMatch=text.match(/[₡¢]\s*([\d\s,\.]+)/i); 
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
    // ✅ Ruta correcta: /img/CODIGO.webp
    result.foto_url=`${CATALOG_URL}/img/${result.codigo}.webp`;
    // Generar link al producto si no vino en el mensaje
    if(!result.producto_url){
      result.producto_url=`${CATALOG_URL}/img/${result.codigo}.webp`;
    }
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

// Parser para mensaje multi-producto desde la web
function parseMultiWebMessage(text) {
  // Detectar mensaje multi-producto: buscar "productos:" o "productos:\n"
  if(!text.includes("interesado") || !text.toLowerCase().includes("productos")) return null;
  
  // Formato: "1. Nombre - ₡Precio... - Código: XXX | Talla: M"
  // Las líneas de productos empiezan con número y punto
  const lines = text.split("\n").filter(l => /^\d+\.\s/.test(l.trim()));
  if(lines.length < 2) return null;
  
  const items = [];
  for(let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const item = { producto:null, precio:0, codigo:null, talla:null, color:null, tamano:null, foto_url:null, producto_url:null };
    // "1. Blusa Floral - ₡8,500 - Código: LV001 | Talla: M | Color: Rojo"
    const nameMatch = line.match(/^\d+\.\s+(.+?)\s*-\s*[₡¢]/);
    if(nameMatch) item.producto = nameMatch[1].trim();
    
    const priceMatch = line.match(/[₡¢]\s*([\d\s,\.]+)/);
    if(priceMatch) item.precio = parseInt(priceMatch[1].replace(/[\s,\.]/g,'')) || 0;
    
    const codeMatch = line.match(/Código:\s*(\w+)/i);
    if(codeMatch) { 
      item.codigo = codeMatch[1].trim(); 
      item.foto_url = `${CATALOG_URL}/img/${item.codigo}.webp`; 
      // Generar link al producto basado en el código
      item.producto_url = `${CATALOG_URL}/img/${item.codigo}.webp`;
    }
    
    const tallaMatch = line.match(/Talla:\s*([^\s|─]+)/i);
    if(tallaMatch) item.talla = tallaMatch[1].trim();
    
    const colorMatch = line.match(/Color:\s*([^\s|─]+)/i);
    if(colorMatch) item.color = colorMatch[1].trim();
    
    const tamanoMatch = line.match(/Tamaño:\s*([^\s|─]+)/i);
    if(tamanoMatch) item.tamano = tamanoMatch[1].trim();
    
    if(item.producto || item.codigo) items.push(item);
  }
  
  if(items.length < 2) return null;
  
  const totalMatch = text.match(/Total:\s*[₡¢]\s*([\d\s,\.]+)/i);
  const total = totalMatch ? parseInt(totalMatch[1].replace(/[\s,\.]/g,'')) || 0 : items.reduce((s,i)=>s+i.precio,0);
  
  console.log(`📋 parseMultiWebMessage: ${items.length} productos, total ₡${total}`);
  return { items, total };
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
      
      // ✅ Restaurar tareas pendientes después de reconexión/deploy
      setTimeout(() => {
        let restored = 0;
        for(const [wId, s] of sessions.entries()){
          const profile = getProfile(wId);
          const phone = profile.phone || wId;
          
          // Re-emitir zonas pendientes (dueño no calculó envío)
          if(s.state === "ZONA_RECIBIDA"){
            io.emit("zone_received",{waId:wId, zone:s.client_zone, producto:s.producto, codigo:s.codigo, precio:s.precio, talla_color:s.talla_color, foto_url:s.foto_url});
            sendPushoverAlert("ZONA", {waId:wId, zone:s.client_zone, phone});
            restored++;
          }
          // Re-emitir confirmaciones de vendedor pendientes
          if(s.state === "ESPERANDO_CONFIRMACION_VENDEDOR" && !pendingQuotes.has(wId) && !s.pendingDismissed){
            const quote = {waId:wId, phone, name:profile.name||"", producto:s.producto||"Producto", precio:s.precio, codigo:s.codigo, foto_url:s.foto_url||s.foto_url_guardada, talla_color:s.talla_color, foto_externa:s.foto_externa, created_at:new Date().toISOString()};
            pendingQuotes.set(wId, quote);
            io.emit("new_pending", quote);
            restored++;
          }
          // Re-emitir SINPE pendientes
          if(s.state === "ESPERANDO_SINPE" && s.comprobante_url && !pendingQuotes.has(wId)){
            const price = s.precio||0;
            const shipping = s.delivery_method==="envio"?(s.shipping_cost||0):0;
            const sinpeData = {waId:wId, tipo:"sinpe", reference:s.sinpe_reference, phone, name:profile.name||"", producto:s.producto, codigo:s.codigo, precio:price, shipping_cost:shipping, total:price+shipping, talla_color:s.talla_color, method:s.delivery_method, foto_url:s.foto_url, comprobante_url:s.comprobante_url, zone:s.client_zone, created_at:new Date().toISOString()};
            pendingQuotes.set(wId, sinpeData);
            io.emit("sinpe_received", sinpeData);
            restored++;
          }
        }
        if(restored > 0) console.log(`🔄 ${restored} tarea(s) pendiente(s) restaurada(s)`);
      }, 3000); // Esperar 3 seg para que panel se conecte
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
    for(const msg of messages){
      // Ignorar grupos siempre
      if(msg.key.remoteJid?.endsWith("@g.us"))continue;
      // Mensajes enviados desde el teléfono directamente → guardar en historial como "out"
      if(msg.key.fromMe){
        const waId = fromJid(msg.key.remoteJid||"");
        if(!waId) continue;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text || "";
        const hasImage = !!(msg.message?.imageMessage || msg.message?.extendedTextMessage?.jpegThumbnail);
        if(text || hasImage) {
          addToChatHistory(waId, "out", text || "(foto)");
          console.log(`📱 Mensaje desde teléfono → ${formatPhone(waId)}: ${(text||"(foto)").slice(0,60)}`);
        }
        continue;
      }
      messageQueue.push(msg);processQueue();
    }
  });
}

async function processQueue(){if(isProcessingQueue||messageQueue.length===0)return;isProcessingQueue=true;while(messageQueue.length>0){const msg=messageQueue.shift();try{await handleIncomingMessageWithDebounce(msg);}catch(e){console.log("❌ Error:",e.message);}}isProcessingQueue=false;}

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
// ============ DEBOUNCE PARA RÁFAGAS ============
const messageBuffer = new Map(); // waId -> {messages: [], timer: null, processing: false}
const DEBOUNCE_MS = 2000; // Esperar 2 segundos después del último mensaje

async function handleIncomingMessageWithDebounce(msg) {
  // Extraer waId del mensaje para el buffer
  const remoteJid = msg.key.remoteJid;
  const isLid = remoteJid?.endsWith("@lid");
  const lidId = isLid ? fromJid(remoteJid) : null;
  const senderPn = msg.key.senderPn || msg.key.senderPnAlt || null;
  let waId;
  
  if (senderPn) {
    waId = fromJid(senderPn);
  } else if (isLid && lidPhoneMap.has(lidId)) {
    waId = lidPhoneMap.get(lidId);
  } else if (isLid) {
    waId = lidId;
  } else {
    waId = fromJid(remoteJid);
  }
  
  // Inicializar buffer si no existe
  if (!messageBuffer.has(waId)) {
    messageBuffer.set(waId, { messages: [], timer: null, processing: false });
  }
  const buffer = messageBuffer.get(waId);
  
  // Si ya estamos procesando, agregar a cola
  if (buffer.processing) {
    buffer.messages.push(msg);
    return;
  }
  
  // Agregar mensaje al buffer
  buffer.messages.push(msg);
  
  // Cancelar timer anterior
  if (buffer.timer) {
    clearTimeout(buffer.timer);
  }
  
  // Nuevo timer
  buffer.timer = setTimeout(async () => {
    buffer.processing = true;
    
    // Procesar solo el ÚLTIMO mensaje (el más reciente/completo)
    const msgs = buffer.messages;
    const lastMsg = msgs[msgs.length - 1];
    
    // Limpiar buffer
    buffer.messages = [];
    buffer.timer = null;
    
    try {
      await handleIncomingMessage(lastMsg);
    } catch(e) {
      console.error("❌ Error procesando mensaje:", e.message);
    }
    
    buffer.processing = false;
    
    // Si llegaron más mensajes mientras procesábamos, procesar el último
    if (buffer.messages.length > 0) {
      const nextMsg = buffer.messages.pop();
      buffer.messages = [];
      setTimeout(() => handleIncomingMessageWithDebounce(nextMsg), 100);
    }
  }, DEBOUNCE_MS);
}

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
  
  // ✅ Buscar imageMessage recursivamente en toda la estructura del mensaje
  function findImageMessage(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return null;
    if (obj.imageMessage) return obj.imageMessage;
    for (const key of Object.keys(obj)) {
      if (key === 'imageMessage') return obj[key];
      const found = findImageMessage(obj[key], depth + 1);
      if (found) return found;
    }
    return null;
  }
  
  // Buscar documentMessage recursivamente también
  function findDocMessage(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return null;
    if (obj.documentMessage) return obj.documentMessage;
    for (const key of Object.keys(obj)) {
      if (key === 'documentMessage') return obj[key];
      const found = findDocMessage(obj[key], depth + 1);
      if (found) return found;
    }
    return null;
  }
  
  const imgMsg = findImageMessage(msg.message);
  const docMsg = findDocMessage(msg.message);
  const docIsImage = docMsg && (docMsg.mimetype || "").startsWith("image/");
  const hasImage = !!(imgMsg || docIsImage);
  let imageBase64 = null;
  
  // Log para debug de tipos de mensaje
  if(msg.message){
    const keys = Object.keys(msg.message);
    console.log(`📨 Tipo mensaje: [${keys.join(", ")}] hasImage=${hasImage}`);
    
    // ✅ Detectar mensaje de VOZ/AUDIO y responder que no se procesan
    const esAudio = keys.some(k => k === 'audioMessage' || k === 'pttMessage');
    if(esAudio){
      console.log("🎤 Mensaje de voz detectado - no procesamos audio");
      await sendTextWithTyping(waId,
        "¡Hola! Disculpá, por este medio solo podemos atender mensajes de texto 📝\n\n" +
        "Si preferís, podés llamarnos al 2237-3335 y con gusto te atendemos 😊"
      );
      return;
    }
  }
  
  if(msg.message?.conversation)text=msg.message.conversation;
  else if(msg.message?.extendedTextMessage?.text)text=msg.message.extendedTextMessage.text;
  else if(imgMsg?.caption)text=imgMsg.caption;
  else if(docMsg?.caption)text=docMsg.caption;
  else if(msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text)text=msg.message.ephemeralMessage.message.extendedTextMessage.text;

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

  // ====== CONTACTO CON BOT DESACTIVADO → siempre modo humano ======
  if(profile.botDisabled && !session.humanMode){
    session.humanMode = true;
    session.humanModeManual = true; // Manual — no expira por inactividad
    session.humanModeAt = session.humanModeAt || Date.now();
    session.humanModeLastActivity = Date.now();
    io.emit("human_mode_changed", { waId: normalizePhone(waId), humanMode: true, manual: true });
  }
  
  // ====== MODO HUMANO POR CHAT ======
  if(session.humanMode){
    console.log(`👤 Modo humano activo para ${displayPhone} - bot no responde`);
    // Notificar al panel que llegó mensaje nuevo (para que alerte al operador)
    io.emit("human_mode_message", { waId: normalizePhone(waId), phone: displayPhone, text: text||(hasImage?"(foto)":"(mensaje)"), timestamp: new Date().toISOString() });
    // Si el contacto es "solo humano" → Pushover por cada mensaje
    if(profile.botDisabled){
      sendPushoverAlert("HUMANO_MENSAJE", {
        waId,
        phone: profile.phone || waId,
        name: profile.name || "",
        mensaje: text||(hasImage?"(foto)":"(mensaje)")
      });
    }
    return;
  }

  // ====== SISTEMA ANTI-RÁFAGA ======
  // Si el cliente envía muchos mensajes seguidos, agrupar y responder una vez
  const now = Date.now();
  const RAFAGA_WINDOW = 5000; // 5 segundos
  const RAFAGA_MAX = 3; // máximo 3 mensajes antes de activar
  
  if (!session.rafaga_msgs) session.rafaga_msgs = [];
  if (!session.rafaga_notified) session.rafaga_notified = false;
  
  // Limpiar mensajes viejos fuera de la ventana
  session.rafaga_msgs = session.rafaga_msgs.filter(t => (now - t) < RAFAGA_WINDOW);
  session.rafaga_msgs.push(now);
  
  // Si hay ráfaga activa
  if (session.rafaga_msgs.length >= RAFAGA_MAX) {
    if (!session.rafaga_notified) {
      session.rafaga_notified = true;
      session.rafaga_started = now;
      
      // Notificar al dueño
      const profile = getProfile(waId);
      sendPushoverAlert("RAFAGA", {
        phone: profile.phone || waId,
        producto: `Cliente enviando múltiples mensajes`,
        talla_color: text.slice(0, 50)
      });
      
      await sendTextWithTyping(waId, 
        `¡Dame un momento! Ya te sigo atendiendo 😊`
      );
      
      // Esperar 5 segundos para acumular más mensajes
      console.log(`⚡ Ráfaga detectada de ${displayPhone}, esperando...`);
      return;
    }
    
    // Si ya notificamos y siguen llegando mensajes dentro de 10 segundos, ignorar
    if (session.rafaga_started && (now - session.rafaga_started) < 10000) {
      console.log(`⚡ Ráfaga activa, acumulando mensaje de ${displayPhone}`);
      return;
    }
    
    // Después de 10 segundos, resetear y procesar
    session.rafaga_notified = false;
    session.rafaga_msgs = [];
  }

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
          sendPushoverAlert("PRODUCTO_FOTO", quote);
          await sendTextWithTyping(waId, `Dame un momento 🙌`);
          session.humanMode = true;
          io.emit("human_mode_changed", { waId: normalizePhone(waId), humanMode: true });
          saveDataToDisk();
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
    sendPushoverAlert("PRODUCTO_FOTO", quote);
    await sendTextWithTyping(waId, `Dame un momento 🙌`);
    session.humanMode = true;
    io.emit("human_mode_changed", { waId: normalizePhone(waId), humanMode: true });
    saveDataToDisk();
    return;
  }

  // ====== MULTI-PRODUCTO desde la web ======
  const multiData = parseMultiWebMessage(text);
  if(multiData && multiData.items.length >= 2) {
    session.saludo_enviado = true;
    session.multi_products = multiData.items.map((it,i) => ({
      ...it, index: i, disponible: null, // null=pendiente, true=hay, false=agotado
      foto_url_local: null,
      producto_url: it.producto_url || null
    }));
    session.multi_total = multiData.total;
    session.state = "MULTI_ESPERANDO_DISPONIBILIDAD";
    
    // Descargar imágenes
    for(const mp of session.multi_products) {
      if(mp.codigo) {
        mp.foto_url_local = await descargarImagenCatalogo(mp.codigo, waId);
      }
    }
    
    // Resumen al cliente
    const lista = session.multi_products.map((p,i) => 
      `${i+1}. ${p.producto||'Producto'} ${p.talla?'('+p.talla+')':''} - ₡${(p.precio||0).toLocaleString()}`
    ).join("\n");
    
    await sendTextWithTyping(waId,
      `¡Hola! Pura vida 🙌\n\n` +
      `Vi que te interesan ${session.multi_products.length} productos:\n\n${lista}\n\n` +
      `Déjame revisar cuáles tenemos disponibles. Un momento... 🔍`
    );
    
    // Notificar al dueño con la lista
    const profile = getProfile(waId);
    const multiQuote = {
      waId,
      phone: profile.phone || waId,
      name: profile.name || "",
      type: "multi",
      products: session.multi_products,
      total: session.multi_total,
      created_at: new Date().toISOString()
    };
    pendingQuotes.set(waId, multiQuote);
    console.log("📤 Emitiendo new_pending_multi:", waId, multiQuote.products?.length, "productos");
    io.emit("new_pending_multi", multiQuote);
    
    // Pushover
    const phoneF = formatPhone(profile.phone || waId);
    sendPushoverAlert("MULTI_PRODUCTO", {
      phone: profile.phone || waId,
      producto: `${session.multi_products.length} productos`,
      talla_color: session.multi_products.map(p => p.producto).join(", ")
    });
    
    saveDataToDisk();
    return;
  }

  // Detectar mensaje web ("Me interesa") - producto individual
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
    
    session.producto=webData.producto; session.precio=webData.precio; session.codigo=webData.codigo; session.foto_url=fotoLocal || webData.foto_url; session.producto_url=webData.producto_url;
    let detalles=[];
    if(webData.talla)detalles.push(`Talla: ${webData.talla}`);
    if(webData.color)detalles.push(`Color: ${webData.color}`);
    if(webData.tamano)detalles.push(`Tamaño: ${webData.tamano}`);
    let resumenProducto=`📦 *${webData.producto||'Producto'}*`;
    if(webData.precio)resumenProducto+=`\n💰 ₡${webData.precio.toLocaleString()}`;
    if(detalles.length>0)resumenProducto+=`\n👕 ${detalles.join(", ")}`;
    if(detalles.length>0){
      session.talla_color=detalles.join(", "); session.state="ESPERANDO_CONFIRMACION_VENDEDOR";
      await sendTextWithTyping(waId, `Dame un momento 🙌`);
      addPendingQuote(session); return;
    }
    session.state="ESPERANDO_TALLA";
    await sendTextWithTyping(waId,`¡Hola! Pura vida 🙌 Vi que te interesa:\n\n${resumenProducto}\n\n${frase("pedir_talla",waId)}`);
    return;
  }

  // Normalizar 1/2 a si/no
  const numResp=text.trim();
  if(numResp==="1")text="si"; if(numResp==="2")text="no";
  const lower=norm(fixTypos(text));

  
  // ✅ Detectar solicitud de APARTAR/SEPARAR producto (sin pagar)
  const ESTADOS_POST_EXISTENCIA = ["ESPERANDO_CONFIRMACION_VENDEDOR"];
  const pideApartar = /\b(apart|separ|guard|reserv).*\b(mientras|llego|voy|rato|ratito|momento)|\b(me lo|lo)\s*(apartan?|separan?|guardan?|reservan?)|apartame|separame|guardame|reservame|mientras llego|ya voy para alla|ya voy para allá/i;
  
  if (ESTADOS_POST_EXISTENCIA.includes(session.state) && pideApartar.test(lower)) {
    await sendTextWithTyping(waId,
      `Lamentablemente no te lo puedo separar 😔\n\n` +
      `Pero si te interesa el producto, podés coordinarlo directamente con nosotros 🙌\n\n` +
      `Dame un momento que te paso con un compañer@ para ayudarte.`
    );
    session.humanMode = true;
  // ✅ Detectar preguntas por tipo de producto (precio, disponibilidad, estilo, descripción)
  // ====== BÚSQUEDA POR TIPO DE PRODUCTO ======
  // Detectar si menciona alguna categoría de producto
  const regexProducto = /jeans?|pantalon(?:es)?|short(?:s)?|chaqueta(?:s)?|jacket(?:s)?|blusa(?:s)?|vestido(?:s)?|falda(?:s)?|camisa(?:s)?|camiseta(?:s)?|sueter|sweater|saco(?:s)?|accesorio(?:s)?|conjunto(?:s)?|ropa/i;
  const _matchProducto = regexProducto.test(lower);
  const _matchPrecio = /(?:qu[ée]|cu[aá]nto|precio|valen?|cuestan?).*(?:jeans?|blusas?|vestidos?|faldas?|pantalon(?:es)?|shorts?)/i.test(lower);
  const _matchPrecio2 = /(?:jeans?|blusas?|vestidos?|faldas?|pantalon(?:es)?|shorts?).*(?:qu[ée]|precio|valen?|cuestan?)/i.test(lower);
  const _matchDisp = /(?:tienen|hay|venden|manejan|ofrecen|busco|quiero|necesito).*(?:jeans?|blusas?|vestidos?|faldas?|pantalon(?:es)?|shorts?|chaquetas?|camisas?|camisetas?)/i.test(lower);
  const COLORES_REGEX = /negro|negra|blanco|blanca|azul|rojo|roja|verde|amarill[ao]|rosad[ao]|\brosa\b|morad[ao]|gris|beige|caf[eé]|naranja|celeste|lila|fucsia|coral|vino|crema|dorad[ao]|platead[ao]|turquesa/i;
  const _matchEstilo = (/(?:plus|skinny|recto|campana|ancho|slim|straight|tejida?|crop|pretina|elasticada|rasgad|boyfriend|mom|wide|palazzo|tiro|manga|\d{1,2}\/\d{1,2})/.test(lower) || COLORES_REGEX.test(lower)) && _matchProducto;

  console.log(`🔍 CATEGORIA-CHECK: lower="${lower}" state="${session.state}" prod=${_matchProducto} disp=${_matchDisp} estilo=${_matchEstilo}`);

  if ((_matchProducto || _matchPrecio || _matchPrecio2 || _matchDisp || _matchEstilo) &&
      (session.state === "NEW" || session.state === "PREGUNTANDO_ALGO_MAS" || session.state === "ESPERANDO_RESPUESTA_CATALOGO")) {

    await loadCatalog();

    // ── Detectar género mencionado (singular, plural, variantes) ──
    const mencionaDama  = /\b(dama|damas|mujer|mujeres|femenin[ao]|señora|señoras|chica|chicas|ella|ellas)\b/i.test(lower);
    const mencionaCabal = /\b(caballero|caballeros|hombre|hombres|masculin[ao]|señor|señores|chico|chicos|varón|varon|varones|él|para\s*el\b)\b/i.test(lower);
    const mencionaNino  = /\b(niño|niños|niña|niñas|nino|ninos|nina|ninas|adolescente|adolescentes|juvenil|juveniles|infantil|kids?|escolar)\b/i.test(lower);
    const generoEspecificado = mencionaDama || mencionaCabal || mencionaNino;

    // ── Mapeo categoría → géneros posibles ──
    // Si la categoría puede ser para más de un género, preguntar siempre
    const mapeoGeneros = {
      'jeans':      ['damas', 'caballeros', 'ninos'],
      'pantalones': ['damas', 'caballeros', 'ninos'],
      'shorts':     ['damas', 'caballeros', 'ninos'],
      'chaquetas':  ['damas', 'caballeros', 'ninos'],
      'camisas':    ['damas', 'caballeros', 'ninos'],
      'camisetas':  ['damas', 'caballeros', 'ninos'],
      'blusas':     ['damas', 'ninas'],
      'vestidos':   ['damas', 'ninas'],
      'faldas':     ['damas', 'ninas'],
      'conjuntos':  ['damas', 'ninas'],
      'accesorios': ['damas'],
    };

    // ── Detectar categoría del mensaje ──
    const mapeoCategoria = {
      'jean': 'jeans', 'jeans': 'jeans',
      'pantalon': 'pantalones', 'pantalones': 'pantalones',
      'short': 'shorts', 'shorts': 'shorts',
      'chaqueta': 'chaquetas', 'chaquetas': 'chaquetas',
      'jacket': 'chaquetas', 'jackets': 'chaquetas',
      'blusa': 'blusas', 'blusas': 'blusas',
      'vestido': 'vestidos', 'vestidos': 'vestidos',
      'falda': 'faldas', 'faldas': 'faldas',
      'camisa': 'camisas', 'camisas': 'camisas',
      'camiseta': 'camisetas', 'camisetas': 'camisetas',
      'sueter': 'chaquetas', 'sweater': 'chaquetas', 'saco': 'chaquetas',
      'conjunto': 'conjuntos', 'conjuntos': 'conjuntos',
      'accesorio': 'accesorios', 'accesorios': 'accesorios',
    };

    let categoriaDetectada = null;
    for (const [palabra, cat] of Object.entries(mapeoCategoria)) {
      if (lower.includes(palabra)) { categoriaDetectada = cat; break; }
    }

    // ── Determinar root según género ──
    function getRootByGenero(cat, genero) {
      if (genero === 'damas')     return 'damas';
      if (genero === 'caballeros') return 'caballeros';
      if (genero === 'ninos')     return 'ninos';
      return 'damas'; // fallback
    }

    const saludo = /hola|buenas|buenos|hey/i.test(lower) ? '¡Hola! Pura vida 🙌\n\n' : '';

    // ── Si no especificó género y la categoría tiene múltiples géneros → PREGUNTAR ──
    const generosPosCat = categoriaDetectada ? (mapeoGeneros[categoriaDetectada] || ['damas']) : ['damas'];
    const debePreguntar = !generoEspecificado && generosPosCat.length > 1 && session.state !== "ESPERANDO_RESPUESTA_CATALOGO";

    if (debePreguntar) {
      // Construir pregunta según géneros posibles
      let opcionesGenero = generosPosCat.map(g => {
        if (g === 'damas') return 'damas';
        if (g === 'caballeros') return 'caballeros';
        if (g === 'ninos') return 'niños/niñas';
      }).join(', ');
      // Quitar última coma y poner "o"
      const partes = generosPosCat.map(g => g === 'ninos' ? 'niños/niñas' : g);
      const preguntaGenero = partes.length === 2 
        ? `${partes[0]} o ${partes[1]}`
        : `${partes.slice(0,-1).join(', ')} o ${partes[partes.length-1]}`;

      // Guardar descripción/estilo para usarla después de la respuesta de género
      const _estiloParaGuardar = lower.replace(/hola|buenas|buenos|hey|tienen|hay|busco|quiero|para|\?|¿|!/gi, '').replace(categoriaDetectada || '', '').trim();

      await sendTextWithTyping(waId,
        `${saludo}¡Claro que tenemos ${categoriaDetectada || 'eso'}! 😊\n\n¿Buscás para ${preguntaGenero}?`
      );
      session.saludo_enviado = true;
      session.state = "ESPERANDO_RESPUESTA_CATALOGO";
      session.ultimaCategoriaBuscada = categoriaDetectada;
      session.ultimaDescripcionBuscada = _estiloParaGuardar || null;
      session.generosPosCat = generosPosCat;
      saveDataToDisk();
      return;
    }

    // ── Determinar root final ──
    let rootFinal = 'damas';
    if (mencionaCabal) rootFinal = 'caballeros';
    else if (mencionaNino) rootFinal = 'ninos';
    else if (session.state === "ESPERANDO_RESPUESTA_CATALOGO" && session.ultimaCategoriaBuscada) {
      // Respuesta al género preguntado
      if (/\b(dama|damas|mujer|mujeres|femenino|para\s*ella)\b/i.test(lower)) rootFinal = 'damas';
      else if (/\b(caballero|hombre|masculino|para\s*él|para\s*el)\b/i.test(lower)) rootFinal = 'caballeros';
      else if (/\b(ni[ñn][oa]|niños|infantil)\b/i.test(lower)) rootFinal = 'ninos';
      categoriaDetectada = categoriaDetectada || session.ultimaCategoriaBuscada;
    }

    if (!categoriaDetectada) {
      // No detectamos categoría → IA
      const aiResp = await askAI(text);
      if (aiResp) { await sendTextWithTyping(waId, aiResp); }
      return;
    }

    const resultado = buscarPreciosPorTipo(text, rootFinal);

    // ── Sin productos en catálogo online → mensaje contextual + humano ──
    if (!resultado || resultado.encontrados === 0) {
      session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
      const quote = {
        waId, phone: profile.phone || waId, name: profile.name || "",
        producto: `❓ Busca: ${categoriaDetectada} para ${rootFinal} — ${text.trim()}`,
        precio: null, codigo: null, foto_url: null, talla_color: null,
        consulta_producto: true, created_at: new Date().toISOString()
      };
      pendingQuotes.set(waId, quote);
      io.emit("new_pending", quote);
      sendPushoverAlert("PRODUCTO_CATALOGO", quote);

      // No hay en catálogo → avisar y pasar a humano
      await sendTextWithTyping(waId, `Dame un momento, ya te ayudo 🙌`);
      session.humanMode = true;
      io.emit("human_mode_changed", { waId: normalizePhone(waId), humanMode: true });
      return;
    }

    const linkBase = `${CATALOG_URL}/catalogo.html?root=${rootFinal}&cat=${resultado.categoria}`;

    // ── Buscar descripción específica en nombres ──
    const stopWords = /^(hola|tienen|hay|jean|jeans|blusa|blusas|vestido|vestidos|falda|faldas|pantalon|pantalones|short|shorts|chaqueta|para|dama|mujer|caballero|hombre|nino|niño|quiero|busco|me|interesa|de|que|con|los|las|un|una|si|no|y|o|también|tambien|a|es)$/i;
    const palabrasClave = lower.replace(/[¿?!¡]/g, '').split(/\s+/).filter(w => w.length > 3 && !stopWords.test(w));
    const especificacion = resultado.estiloDetectado;

    let productosConMatch = [];
    if (especificacion) {
      productosConMatch = resultado.productos.filter(p => p.nombre.toLowerCase().includes(especificacion.toLowerCase()));
    }
    if (productosConMatch.length === 0 && palabrasClave.length > 0) {
      productosConMatch = resultado.productos.filter(p =>
        palabrasClave.some(w => p.nombre.toLowerCase().includes(w))
      );
    }

    const descripcionBuscada = especificacion || palabrasClave.filter(w => !/^\d/.test(w) && w.length > 3).join(' ');
    const hayMatch = productosConMatch.length > 0;

    if (descripcionBuscada && hayMatch) {
      const precios = productosConMatch.map(p => p.descuento > 0 ? Math.round(p.precio * (1-p.descuento/100)) : p.precio);
      const minP = Math.min(...precios), maxP = Math.max(...precios);
      const conDesc = productosConMatch.filter(p => p.descuento > 0);
      let msg = `${saludo}¡Sí! Tenemos ${resultado.categoria} con ${descripcionBuscada} 🎉\n\n`;
      msg += minP === maxP ? `💰 ₡${minP.toLocaleString()}\n\n` : `💰 Desde ₡${minP.toLocaleString()} hasta ₡${maxP.toLocaleString()}\n\n`;
      if (conDesc.length > 0) msg += `🔥 ${conDesc.length > 1 ? 'Varios' : 'Uno'} con descuento hasta ${Math.max(...conDesc.map(p=>p.descuento))}% OFF\n\n`;
      msg += `Revisalos acá 👇\n${linkBase}`;
      await sendTextWithTyping(waId, msg);
    } else if (descripcionBuscada && !hayMatch) {
      let msg = `${saludo}¡Tenemos ${resultado.categoria}! 😊 Desde ₡${resultado.minPrecio.toLocaleString()} hasta ₡${resultado.maxPrecio.toLocaleString()}.\n\n`;
      msg += `No estoy seguro si tenemos con ${descripcionBuscada}, pero podés revisar todos los estilos disponibles acá 👇\n${linkBase}`;
      await sendTextWithTyping(waId, msg);
    } else {
      let msg = `${saludo}¡Claro! Tenemos ${resultado.display || resultado.categoria} desde ₡${resultado.minPrecio.toLocaleString()} hasta ₡${resultado.maxPrecio.toLocaleString()} 🛍️`;
      if (resultado.conDescuento > 0) msg += `\n\n🔥 Varias opciones con descuento, hasta ${resultado.maxDescuento}% OFF`;
      msg += `\n\nRevisalos acá 👇\n${linkBase}`;
      await sendTextWithTyping(waId, msg);
    }

    session.ultimaCategoriaBuscada = resultado.categoria;
    session.saludo_enviado = true;
    session.state = "ESPERANDO_RESPUESTA_CATALOGO";
    saveDataToDisk();
    return;
  }

  // ✅ Capturar respuesta de género cuando bot preguntó ¿para damas/caballeros/niños?
  if (session.state === "ESPERANDO_RESPUESTA_CATALOGO" && session.ultimaCategoriaBuscada && session.generosPosCat) {
    const esRespDama   = /\b(dama|damas|mujer|mujeres|femenin[ao]|señora|señoras|chica|chicas|ella|ellas)\b/i.test(lower);
    const esRespCabal  = /\b(caballero|caballeros|hombre|hombres|masculin[ao]|señor|señores|chico|chicos|varón|varon|varones)\b/i.test(lower);
    const esRespNino   = /\b(niño|niños|niña|niñas|nino|ninos|nina|ninas|adolescente|adolescentes|juvenil|infantil|kids?|escolar)\b/i.test(lower);
    const esRespGenero = esRespDama || esRespCabal || esRespNino;

    if (esRespGenero) {
      const catResp  = session.ultimaCategoriaBuscada;
      const rootResp = esRespCabal ? 'caballeros' : esRespNino ? 'ninos' : 'damas';
      const saludo   = /hola|buenas|buenos|hey/i.test(lower) ? '¡Hola! Pura vida 🙌\n\n' : '';

      await loadCatalog();
      // Incluir descripción guardada si existe (ej: "campana", "negro", "pretina ancha")
      const descGuardada = session.ultimaDescripcionBuscada || '';
      const queryResp = descGuardada ? `${catResp} ${descGuardada}` : catResp;
      const resultadoResp = buscarPreciosPorTipo(queryResp, rootResp);

      if (!resultadoResp || resultadoResp.encontrados === 0) {
        // No hay en catálogo → avisar y pasar a humano
        const labelGenero = rootResp === 'caballeros' ? 'caballeros' : rootResp === 'ninos' ? 'niños/niñas' : 'damas';
        await sendTextWithTyping(waId,
          `Dame un momento, ya te ayudo 🙌`
        );
        session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
        session.humanMode = true;
        session.generosPosCat = null;
        const quote = {
          waId, phone: profile.phone || waId, name: profile.name || "",
          producto: `❓ Busca: ${catResp} para ${labelGenero}`,
          precio: null, codigo: null, foto_url: null, talla_color: null,
          consulta_producto: true, created_at: new Date().toISOString()
        };
        pendingQuotes.set(waId, quote);
        io.emit("new_pending", quote);
        sendPushoverAlert("PRODUCTO_CATALOGO", quote);
        io.emit("human_mode_changed", { waId: normalizePhone(waId), humanMode: true });
        saveDataToDisk();
        return;
      }

      const linkResp = `${CATALOG_URL}/catalogo.html?root=${rootResp}&cat=${resultadoResp.categoria}`;
      let msg = `¡Claro! Tenemos ${catResp} desde ₡${resultadoResp.minPrecio.toLocaleString()} hasta ₡${resultadoResp.maxPrecio.toLocaleString()} 🛍️`;
      if (resultadoResp.conDescuento > 0) msg += `\n\n🔥 Varias opciones con descuento, hasta ${resultadoResp.maxDescuento}% OFF`;
      msg += `\n\nRevisalos acá 👇\n${linkResp}`;
      await sendTextWithTyping(waId, msg);
      session.ultimaCategoriaBuscada = catResp;
      session.ultimaDescripcionBuscada = null;
      session.generosPosCat = null;
      session.state = "ESPERANDO_RESPUESTA_CATALOGO";
      session.saludo_enviado = true;
      saveDataToDisk();
      return;
    }
  }

  // ✅ Detectar talla suelta con contexto de categoría anterior
  if (session.ultimaCategoriaBuscada && (session.state === "ESPERANDO_RESPUESTA_CATALOGO" || session.state === "NEW")) {
    const regexTallaSuelta = /^(?:y\s+)?(?:talla\s+)?(\d{1,2}\/\d{1,2})\s*(?:tienen|hay|tiene)?$/i;
    const regexTallaLetraSuelta = /^(?:y\s+)?(?:talla\s+)?(?:en\s+)?\b(xxl|2xl|3xl|xl|xs|s|m|l)\b\s*(?:tienen|hay|tiene)?$/i;
    const matchSuelta = lower.trim().match(regexTallaSuelta) || lower.trim().match(regexTallaLetraSuelta);
    
    if (matchSuelta) {
      const tallaQuery = `${session.ultimaCategoriaBuscada} ${matchSuelta[1]}`;
      console.log(`🔍 TALLA-CONTEXTO: "${lower}" → buscando "${tallaQuery}" en categoría ${session.ultimaCategoriaBuscada}`);
      await loadCatalog();
      const resultadoTalla = buscarPreciosPorTipo(tallaQuery);
      
      if (resultadoTalla && resultadoTalla.encontrados > 0) {
        let linkCat = `${CATALOG_URL}/catalogo.html?root=${resultadoTalla.rootCategoria}&cat=${resultadoTalla.categoria}`;
        if (resultadoTalla.tallaDetectada && resultadoTalla.tallaDisponible) {
          linkCat += `&talla=${encodeURIComponent(resultadoTalla.tallaDetectada)}`;
        }
        
        if (resultadoTalla.encontrados === 1) {
          const p = resultadoTalla.productos[0];
          const pf = p.descuento > 0 ? Math.round(p.precio * (1 - p.descuento / 100)) : p.precio;
          const dt = p.descuento > 0 ? ` (${p.descuento}% OFF)` : '';
          await sendTextWithTyping(waId, `¡Sí! Tenemos ${p.nombre} a ₡${pf.toLocaleString()}${dt} 👕\n\nRevisalo acá 👇\n${linkCat}`);
        } else {
          let msg = resultadoTalla.tallaDetectada 
            ? `¡Sí! Tenemos ${resultadoTalla.display} en talla ${resultadoTalla.tallaDetectada}, varios estilos disponibles 🛍️`
            : `¡Claro! Tenemos ${resultadoTalla.display} desde ₡${resultadoTalla.minPrecio.toLocaleString()} hasta ₡${resultadoTalla.maxPrecio.toLocaleString()} 🛍️`;
          if (resultadoTalla.conDescuento > 0) {
            msg += `\n\n🔥 Además tenemos varias opciones con descuento, hasta ${resultadoTalla.maxDescuento}% OFF`;
          }
          msg += `\n\nRevisalas acá 👇\n${linkCat}`;
          await sendTextWithTyping(waId, msg);
        }
        session.state = "ESPERANDO_RESPUESTA_CATALOGO";
        saveDataToDisk();
        return;
      } else if (resultadoTalla && resultadoTalla.tallaDetectada && !resultadoTalla.tallaDisponible) {
        const linkSinTalla = `${CATALOG_URL}/catalogo.html?root=${resultadoTalla.rootCategoria}&cat=${resultadoTalla.categoria}`;
        await sendTextWithTyping(waId, `No tenemos ${resultadoTalla.display} en talla ${resultadoTalla.tallaDetectada} en este momento 😔\n\nPero podés revisar todos los ${resultadoTalla.display} disponibles acá 👇\n${linkSinTalla}`);
        session.state = "ESPERANDO_RESPUESTA_CATALOGO";
        saveDataToDisk();
        return;
      }
    }
  }

  // ✅ Detectar "esos son todos" después de mostrar catálogo
  const preguntaSonTodos = /(?:esos|esas|estos|estas)\s*(?:son|nomas|nomás|nada mas|nada más)?\s*(?:todos|todas|todo|lo que hay|lo que tienen|tienen)/i;
  const preguntaHayMas = /(?:hay|tienen|no hay)\s*(?:mas|más|otros?|otras?)/i;
  
  if ((preguntaSonTodos.test(lower) || preguntaHayMas.test(lower)) && (session.state === "ESPERANDO_RESPUESTA_CATALOGO" || session.ultimaCategoriaBuscada)) {
    session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
    saveDataToDisk();
    
    const quote = {
      waId,
      phone: profile.phone || waId,
      name: profile.name || "",
      producto: `❓ Pregunta si hay más: ${text.trim()}`,
      precio: null, codigo: null, foto_url: null, talla_color: null,
      consulta_producto: true,
      created_at: new Date().toISOString()
    };
    pendingQuotes.set(waId, quote);
    io.emit("new_pending", quote);
    sendPushoverAlert("PRODUCTO_CATALOGO", quote);
    
    await sendTextWithTyping(waId,
      `En el catálogo online tenemos esos 😊 Dame un momento, te paso con un compañer@ para que te ayude mejor 🙌`
    );
    session.ultimaCategoriaBuscada = null;
    return;
  }


  // ✅ Detectar CANCELACIÓN de compra durante el flujo (ANTES de la IA)
  const ESTADOS_VENTA_CANCEL = ["ESPERANDO_CONFIRMACION_VENDEDOR", "MULTI_ESPERANDO_DISPONIBILIDAD", "ESPERANDO_TALLA"];
  const pideCancelar = /(?:ya no|no quiero|cancelar|cancela|cancelemos|mejor no|dejalo|déjalo|olvidalo|olvídalo|no me interesa|cambié de opinión|cambie de opinion|no va|nel|ya no lo quiero|ya no quiero|no lo quiero|desisto|solo preguntaba|solo pregunto|solo consultaba|nada mas|nada más|no gracias|no, gracias|no por ahora|luego veo|después veo|despues veo|voy a pensarlo|lo pienso|tal vez luego|tal vez después|quizás luego|quizas luego|era solo una consulta|solo era consulta|no por el momento|por ahora no|ahora no|no ocupo|no necesito)/i;
  
  if(ESTADOS_VENTA_CANCEL.includes(session.state) && pideCancelar.test(lower)){
    await sendTextWithTyping(waId,
      `¡Con gusto! 😊 Cualquier cosa aquí estamos para ayudarte.\n\n¡Pura vida! 🙌\n\n${CATALOG_URL}`
    );
    pendingQuotes.delete(waId);
    io.emit("pending_resolved", { waId });
    resetSession(session);
    saveDataToDisk();
    return;
  }

  // ============ IA: Detectar interrupciones en medio del flujo ============
  // Si está en modo humano (ESPERANDO_CONFIRMACION_VENDEDOR) → bot no interviene
  if(session.state==="ESPERANDO_CONFIRMACION_VENDEDOR"){return;}
  // ⚠️ NO clasificar si estamos esperando SINPE (imagen o texto de pago deben ir directo al handler)
  if(session.state!=="NEW"&&session.state!=="PREGUNTANDO_ALGO_MAS"){
    const estadosConRespuesta=["ESPERANDO_DETALLES_FOTO","ESPERANDO_TALLA"]; // ESPERANDO_CONFIRMACION_VENDEDOR = modo humano, bot no interviene
    if(estadosConRespuesta.includes(session.state)){
      const stateDesc=getStateDescription(session.state);
      const classification=await classifyMessage(text,session.state,stateDesc);
      
      if(classification==="FAQ"){
        const aiResp=await askAI(text);
        const recordatorio=FRASES.recordatorio_flujo[session.state]||"";
        if(aiResp){const cleanResp=sanitizeLinks(aiResp);await sendTextWithTyping(waId,recordatorio?`${cleanResp}\n\n${recordatorio}`:cleanResp);}
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
        
        // Validar que la respuesta de la IA sea coherente y no invente tonterías
        const respuestaInvalida = !aiResp || 
          aiResp.length < 10 || 
          /no tengo información|no puedo ayudar|no sé|no estoy seguro|como modelo de lenguaje|como asistente|como IA/i.test(aiResp) ||
          !/tienda|producto|catálogo|ropa|vaca|envío|sinpe|precio|dama|visita|whatsapp|horario|heredia/i.test(aiResp.toLowerCase());
        
        // Si la IA no pudo responder o respondió algo incoherente → ESCALAR AL DUEÑO
        if(respuestaInvalida){
          await sendTextWithTyping(waId,
            "Disculpá, eso no te lo puedo responder en este momento 😅\n\n" +
            "Dame un momento que voy a consultar y te respondo pronto 🙌"
          );
          
          // Notificar al dueño via Pushover
          const profile = profiles.get(waId) || {};
          sendPushoverAlert("FUERA_LOGICA", {
            waId,
            phone: profile.phone || waId,
            name: profile.name || "",
            mensaje: text,
            estado: session.state
          });
          
          // También crear pending quote para que aparezca en panel
          pendingQuotes.set(waId, {
            waId,
            phone: profile.phone || waId,
            name: profile.name || "",
            producto: `❓ Consulta: ${text.slice(0,50)}...`,
            timestamp: Date.now()
          });
          emitPendingQuotes();
          
          session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
          saveDataToDisk();
          return;
        }
        
        // Si la IA respondió algo coherente, enviar su respuesta
        await sendTextWithTyping(waId,`${sanitizeLinks(aiResp)}${recordatorio?`\n\n${recordatorio}`:""}`);
        return;
      }
      // RESPUESTA_FLUJO → continuar normalmente
    }
  }

  // ✅ Detectar preguntas sobre envío en cualquier estado de venta activa (excepto cuando ya están dando datos)
  const ESTADOS_VENTA_ACTIVA = ["ESPERANDO_TALLA","ESPERANDO_CONFIRMACION_VENDEDOR"];
  const regexPreguntaEnvio = /(?:hac[eé]n?\s*env[ií]o|costo\s*(?:de[l]?\s*)?env[ií]o|cu[áa]nto\s*(?:cuesta|sale|cobra|es)\s*(?:el\s*)?env[ií]o|env[ií]an?\s*a\s+\w|mandan?\s*a\s+\w|llega\s*a\s+\w|env[ií]os?\s*a\s+\w)/i;
  
  if(ESTADOS_VENTA_ACTIVA.includes(session.state) && regexPreguntaEnvio.test(text)){
    const zonaMatch = text.match(/(?:a|en|para|hacia)\s+(san\s*jos[ée]|heredia|alajuela|cartago|puntarenas|lim[oó]n|guanacaste|gam|[a-záéíóú\s]{3,20}?)(?:\s*[?,.]|$)/i);
    const zonaTexto = zonaMatch ? zonaMatch[1].trim() : null;
    
    let respEnvio = `¡Claro! Sí hacemos envíos a todo el país con Correos de Costa Rica 📦\n\n` +
      `🏙️ GAM (área metropolitana): ₡2,500\n` +
      `🌄 Fuera de GAM: ₡3,500\n` +
      `🕐 Tarda entre 4-5 días hábiles en llegar\n`;
    
    const tieneSi = /\bsi\b|sí|quiero|dale|claro|por\s*fa|me\s*interesa/i.test(text);
    
    const recordatorio = FRASES.recordatorio_flujo[session.state] || "";
    if(recordatorio) respEnvio += `\n${recordatorio}`;
    
    await sendTextWithTyping(waId, respEnvio);
    saveDataToDisk();
    return;
  }

  // ============ MÁQUINA DE ESTADOS ============

  if(session.state==="ESPERANDO_TALLA"){
    session.talla_color=text.trim(); session.state="ESPERANDO_CONFIRMACION_VENDEDOR";
    addPendingQuote(session); return;
  }

  if(session.state==="ESPERANDO_CONFIRMACION_VENDEDOR"){return;} // empleado responde directo

  // ====== MULTI: Esperando a que dueño confirme disponibilidad ======
  if(session.state==="MULTI_ESPERANDO_DISPONIBILIDAD"){
    await sendTextWithTyping(waId, "Estoy revisando tu lista, un momento 🙌");
    return;
  }

  // ====== MULTI: Cliente elige cuáles comprar ======
  // ====== MULTI: Selección (legacy — ya no se alcanza, fallback seguro) ======
  if(session.state==="MULTI_SELECCION_CLIENTE"){
    session.humanMode = true;
    session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
    io.emit("human_mode_changed", { waId: normalizePhone(waId), humanMode: true });
    await sendTextWithTyping(waId, frase("espera_vendedor", waId));
    saveDataToDisk();
    return;
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

  // ============================================================
  // ESTADOS LEGACY — ya no se alcanzan en el flujo nuevo híbrido.
  // Si alguna sesión antigua llega aquí, se redirige al empleado.
  // ============================================================
  const ESTADOS_LEGACY = [
    "PREGUNTANDO_METODO", "ESPERANDO_UBICACION_ENVIO", "ZONA_RECIBIDA",
    "PRECIO_TOTAL_ENVIADO", "ESPERANDO_SINPE",
    "ESPERANDO_DATOS_ENVIO", "CONFIRMANDO_DATOS_ENVIO"
  ];
  if(ESTADOS_LEGACY.includes(session.state)){
    console.log(`⚠️ Estado legacy: ${session.state} para ${waId} → forzando modo humano`);
    session.humanMode = true;
    session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
    io.emit("human_mode_changed", { waId: normalizePhone(waId), humanMode: true });
    emitSessionUpdate(normalizePhone(waId), session);
    await sendTextWithTyping(waId, frase("espera_vendedor", waId));
    saveDataToDisk();
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

  // ✅ Detectar solicitud de CAMBIO de prenda
  const pideCambio = /(?:necesito|quiero|puedo|como|cómo).*(?:hacer|realizar).*cambio|cambiar.*prenda|cambio.*producto|devolver|devolución|devolucion/i;
  if(pideCambio.test(lower)){
    session.saludo_enviado = true;
    saveDataToDisk();
    const saludo = /hola|buenas|buenos|hey|pura vida/i.test(lower) ? "¡Hola! Pura vida 🙌\n\n" : "";
    await sendTextWithTyping(waId,
      `${saludo}¡Claro! Para cambios debés presentarte a nuestra tienda 🏪\n\n` +
      `📍 ${STORE_ADDRESS}\n\n` +
      `📋 Requisitos:\n` +
      `• Llevar la prenda que querés cambiar\n` +
      `• Presentar la factura de compra (indispensable)\n` +
      `• Tenés 30 días a partir de la fecha de factura\n\n` +
      `¡Te esperamos! 😊`
    );
    return;
  }

  // ✅ Productos que definitivamente NO vendemos (zapatos) → Respuesta directa
  const productosNoVendemos = /zapato|zapatos|tenis|zapatilla|zapatillas|calzado|sandalia|sandalias|tacones|botas|cortina|cortinas|sabana|sabanas|sábana|sábanas|cobija|cobijas|edredon|edredón|almohada|almohadas|ropa de cama|adorno|adornos|cristal|cristalería|cristaleria|mueble|muebles|hogar|decoracion|decoración/i;
  if(productosNoVendemos.test(lower)){
    session.saludo_enviado = true;
    saveDataToDisk();
    const saludo = /hola|buenas|buenos|hey|pura vida/i.test(lower) ? "¡Hola! Pura vida 🙌\n\n" : "";
    // Detectar si es producto de hogar
    const esHogar = /cortina|sabana|sábana|cobija|edredon|edredón|almohada|ropa de cama|adorno|cristal|mueble|hogar|decoracion|decoración/i.test(lower);
    if(esHogar){
      await sendTextWithTyping(waId,
        `${saludo}No vendemos productos para el hogar, solamente ropa 👕\n\n` +
        `Te invito a revisar nuestro catálogo:\n🛍️ ${CATALOG_URL}`
      );
    } else {
      await sendTextWithTyping(waId,
        `${saludo}No vendemos zapatos, solamente ropa para damas, caballeros y niños 👕\n\n` +
        `Nos podés visitar en:\n📍 ${STORE_ADDRESS}\n\n` +
        `Por ahora vendemos en línea por WhatsApp ropa para damas que podés revisar acá:\n🛍️ ${CATALOG_URL}`
      );
    }
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

  // ✅ Detectar si preguntan por categoría INACTIVA (verificar dinámicamente)
  const detectaCaballero = /\b(hombre|hombres|caballero|caballeros|masculino)\b/i;
  const detectaNino = /niño|niña|niños|niñas|infantil|ropa de niño|ropa infantil/i;
  const detectaEscolar = /escolar|uniforme escolar/i;
  
  let categoriaInactiva = null;
  if (detectaCaballero.test(lower) && !categoriaActiva("caballeros")) {
    categoriaInactiva = "caballeros";
  } else if (detectaNino.test(lower) && !categoriaActiva("ninos")) {
    categoriaInactiva = "niños";
  } else if (detectaEscolar.test(lower) && !categoriaActiva("escolar")) {
    categoriaInactiva = "escolar";
  }
  
  if (categoriaInactiva) {
    session.saludo_enviado = true;
    session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
    saveDataToDisk();
    
    const quote = {
      waId,
      phone: profile.phone || waId,
      name: profile.name || "",
      producto: `❓ Categoría ${categoriaInactiva}: ${text.trim()}`,
      precio: null, codigo: null, foto_url: null, talla_color: null,
      consulta_producto: true,
      created_at: new Date().toISOString()
    };
    pendingQuotes.set(waId, quote);
    io.emit("new_pending", quote);
    sendPushoverAlert("PRODUCTO_CATALOGO", quote);
    
    await sendTextWithTyping(waId,
      `¡Hola! Pura vida 🙌 Dame un momento, te paso con un compañer@ y ya te respondemos 😊`
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
  // ⚠️ EXCLUIR preguntas FAQ que usan palabras como "que" pero no son sobre productos
  const esFAQ = /hora|horario|abierto|abren|cierran|cierra|cerrar|atienden|atenci[oó]n|cuando abren|costo.*envi[oó]|envi[oó].*costo|apartado|separar|reservar|cambio|devoluci[oó]n|d[oó]nde est[aá]|ubicaci[oó]n|direcci[oó]n|c[oó]mo llegar|forma.*pago|m[eé]todo.*pago|garantia|garant[ií]a/i.test(lower);
  
  const preguntaEspecifica = /oferta|descuento|rebaja|promo|dama|caballero|hombre|mujer|niñ|nin|blusa|vestido|jean|pantalon/i.test(lower);
  
  if(!esFAQ && /tienen|hay|busco|quiero ver|necesito|catalogo|productos|que venden|que tienen/i.test(lower)){
    if(preguntaEspecifica){
      // ✅ FALLBACK: Si tiene categoría específica, buscar precios ANTES de caer a IA
      console.log(`🔍 FALLBACK-CATEGORIA: "${lower}" → intentando buscarPreciosPorTipo`);
      const resultadoFB = buscarPreciosPorTipo(text);
      
      if(resultadoFB && resultadoFB.encontrados > 0){
        session.ultimaCategoriaBuscada = resultadoFB.categoria;
        session.saludo_enviado = true;
        const linkFB = `${CATALOG_URL}/catalogo.html?root=${resultadoFB.rootCategoria}&cat=${resultadoFB.categoria}`;
        if(resultadoFB.encontrados === 1){
          const p = resultadoFB.productos[0];
          const precioFinal = p.descuento > 0 ? Math.round(p.precio * (1 - p.descuento / 100)) : p.precio;
          const descuentoText = p.descuento > 0 ? ` (${p.descuento}% OFF)` : '';
          let msg1FB = `¡Sí! Tenemos ${p.nombre} a ₡${precioFinal.toLocaleString()}${descuentoText} 👕`;
          msg1FB += `\n\nRevisalo acá 👇\n${linkFB}`;
          await sendTextWithTyping(waId, msg1FB);
        } else {
          let msgFB = `¡Claro! Tenemos ${resultadoFB.display} desde ₡${resultadoFB.minPrecio.toLocaleString()} hasta ₡${resultadoFB.maxPrecio.toLocaleString()} 🛍️`;
          if (resultadoFB.conDescuento > 0) {
            msgFB += `\n\n🔥 Además tenemos varias opciones de ${resultadoFB.display} con descuento, hasta ${resultadoFB.maxDescuento}% OFF`;
          }
          msgFB += `\n\nRevisalas acá 👇\n${linkFB}`;
          await sendTextWithTyping(waId, msgFB);
        }
        session.state = "ESPERANDO_RESPUESTA_CATALOGO";
        saveDataToDisk();
        return;
      }
      
      // Si no hay productos de esa categoría → responder según tipo
      if(resultadoFB && resultadoFB.encontrados === 0){
        session.saludo_enviado = true;
        session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
        saveDataToDisk();
        
        const quote = {
          waId,
          phone: profile.phone || waId,
          name: profile.name || "",
          producto: `❓ Busca: ${text.trim()}`,
          precio: null, codigo: null, foto_url: null, talla_color: null,
          consulta_producto: true,
          created_at: new Date().toISOString()
        };
        pendingQuotes.set(waId, quote);
        io.emit("new_pending", quote);
        sendPushoverAlert("PRODUCTO_CATALOGO", quote);
        
        await sendTextWithTyping(waId,
          `¡Hola! Pura vida 🙌 Dame un momento, te paso con un compañer@ y ya te respondemos 😊`
        );
        return;
      }
      
      // Detectar si pregunta por hombre/caballero/niño → pasar a compañer@
      if(/caballero|hombre|niñ|nin/i.test(lower) && !/blusa|vestido|jean|pantalon|oferta|descuento/i.test(lower)){
        session.saludo_enviado = true;
        session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
        saveDataToDisk();
        
        const quote = {
          waId,
          phone: profile.phone || waId,
          name: profile.name || "",
          producto: `❓ Consulta: ${text.trim()}`,
          precio: null, codigo: null, foto_url: null, talla_color: null,
          consulta_producto: true,
          created_at: new Date().toISOString()
        };
        pendingQuotes.set(waId, quote);
        io.emit("new_pending", quote);
        sendPushoverAlert("PRODUCTO_CATALOGO", quote);
        
        await sendTextWithTyping(waId,
          `¡Hola! Pura vida 🙌 Dame un momento, te paso con un compañer@ y ya te respondemos 😊`
        );
        return;
      }
      
      // Para dama/mujer sin categoría específica → catálogo general
      if(/dama|mujer/i.test(lower)){
        session.saludo_enviado = true;
        session.catalogo_enviado = true;
        saveDataToDisk();
        await sendTextWithTyping(waId,
          `¡Te invito a revisar nuestro catálogo! 🛍️\n\n${CATALOG_URL}\n\n` +
          `Si te gusta algo, dale al botón 'Me interesa' y te confirmamos disponibilidad 😊`
        );
        return;
      }
      // Si nada matcheó, dejar que caiga a la IA abajo
    } else {
      // Pregunta genérica sin categoría específica → catálogo general
      if(!session.saludo_enviado){session.saludo_enviado=true;}
      session.catalogo_enviado=true;saveDataToDisk();
      const saludo = /hola|buenas|buenos|hey|pura vida/i.test(lower) ? "¡Hola! Pura vida 🙌\n\n" : "";
      await sendTextWithTyping(waId,`${saludo}${frase("catalogo",waId)}\n\n${CATALOG_URL}`);
      return;
    }
  }

  // ✅ Para todo lo demás → IA analiza y responde
  console.log(`🤖 CAYÓ A IA GENÉRICA: text="${text}" state="${session.state}" lower="${lower}"`);
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
      await sendTextWithTyping(waId,"Si tenés alguna duda, podés llamarnos al 2237-3335 🙌");
    }
  }
}

// ============ ACCIONES PANEL ============
async function executeAction(clientWaId, actionType, data = {}) {
  const session = getSession(clientWaId);

  if (actionType === "DISMISS") {
    // Eliminar pending del servidor y marcar como visto para no recrear al reiniciar
    pendingQuotes.delete(clientWaId);
    session.pendingDismissed = true;
    io.emit("pending_resolved", { waId: clientWaId });
    // Cancelar alerta de Pushover si hay receipt pendiente
    const alert = alertsLog.filter(a => a.waId === normalizePhone(clientWaId) && a.estado === "pendiente").pop();
    if (alert?.receipt && PUSHOVER_APP_TOKEN) {
      try {
        await fetch(`https://api.pushover.net/1/receipts/${alert.receipt}/cancel.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: PUSHOVER_APP_TOKEN })
        });
        alert.estado = "atendida";
        alert.fecha_atendida = new Date().toISOString();
        console.log(`✅ Pushover cancelado: ${alert.receipt}`);
      } catch(e) { console.log(`⚠️ Error cancelando Pushover: ${e.message}`); }
    }
    saveDataToDisk();
    return { success: true, message: "Visto" };
  }

  if (actionType === "SI_HAY") {
    session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
    pendingQuotes.delete(clientWaId);
    account.metrics.quotes_sent += 1;
    const price = session.precio || 0;
    await sendTextWithTyping(clientWaId,
      `${frase("si_hay", clientWaId)}\n\n📦 ${session.producto || 'Artículo'}\n👕 ${session.talla_color || '-'}\n💰 ₡${price.toLocaleString()}\n\nDame un momento, te paso con un compañer@ para coordinar los detalles 🙌`
    );
    saveDataToDisk();
    io.emit("pending_resolved", { waId: clientWaId });
    session.humanMode = true;
    io.emit("human_mode_changed", { waId: normalizePhone(clientWaId), humanMode: true });
    emitSessionUpdate(normalizePhone(clientWaId), session);
    return { success: true, message: "Stock confirmado, chat pasado al empleado" };
  }

  if (actionType === "ENVIO") {
    // Solo guarda el costo de envío para pre-llenar el modal de resumen
    const shipping = Number(data.shipping || 0);
    session.shipping_cost = shipping;
    session.delivery_method = "envio";
    emitSessionUpdate(normalizePhone(clientWaId), session);
    saveDataToDisk();
    return { success: true, message: `Costo envío ₡${shipping.toLocaleString()} guardado en sesión` };
  }

  if (actionType === "NO_HAY") {
    session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
    session.humanMode = true;
    await sendTextWithTyping(clientWaId, frase("no_hay", clientWaId) + `\n\n${CATALOG_URL}\n\nDame un momento, te paso con un compañer@ por si te podemos ayudar con algo más 🙌`);
    pendingQuotes.delete(clientWaId);
    io.emit("pending_resolved", { waId: clientWaId });
    io.emit("human_mode_changed", { waId: normalizePhone(clientWaId), humanMode: true });
    emitSessionUpdate(normalizePhone(clientWaId), session);
    saveDataToDisk();
    return { success: true, message: "No hay enviado, pasado a humano" };
  }

  // ====== MULTI-PRODUCTO: Dueño marca cuáles hay ======
  if (actionType === "MULTI_DISPONIBILIDAD") {
    // data.disponibles = [0, 2, 3] — índices de productos disponibles
    const disponibles = data.disponibles || [];
    const precios = data.precios || {}; // { "0": 8500, "2": 12000 } — precios confirmados
    
    if(!session.multi_products) return { success: false, message: "No hay lista multi" };
    
    // Marcar disponibilidad y actualizar precios
    for(const mp of session.multi_products) {
      mp.disponible = disponibles.includes(mp.index);
      if(precios[String(mp.index)] !== undefined) mp.precio = Number(precios[String(mp.index)]);
    }
    
    const hayDisponibles = session.multi_products.filter(p => p.disponible);
    const noHay = session.multi_products.filter(p => !p.disponible);
    
    pendingQuotes.delete(clientWaId);
    io.emit("pending_resolved", { waId: clientWaId });
    
    if(hayDisponibles.length === 0) {
      // Ninguno disponible
      session.state = "PREGUNTANDO_ALGO_MAS";
      await sendTextWithTyping(clientWaId,
        `Uy, revisé y por el momento no tenemos disponible ninguno de los que pediste 😔\n\n` +
        `Te invito a revisar el catálogo por si te gusta algo más:\n${CATALOG_URL}`
      );
      saveDataToDisk();
      return { success: true, message: "Ninguno disponible" };
    }
    
    // Informar los que no hay (si los hubiera) CON LINKS de los que SÍ hay
    if(noHay.length > 0 && hayDisponibles.length > 0) {
      // Construir lista de links de productos disponibles
      const linksDisponibles = hayDisponibles.map((p, i) => 
        `✅ ${p.producto || 'Producto'} - ₡${(p.precio||0).toLocaleString()}\n${CATALOG_URL}/img/${p.codigo}.webp`
      ).join("\n\n");
      
      const noHayNombres = noHay.map(p => p.producto).join(", ");
      
      // Guardar producto disponible para el flujo
      if(hayDisponibles.length === 1) {
        const p = hayDisponibles[0];
        session.producto = p.producto;
        session.precio = p.precio;
        session.codigo = p.codigo;
        session.talla_color = [p.talla, p.color, p.tamano].filter(Boolean).join(", ");
        session.foto_url = p.foto_url_local || p.foto_url;
        session.multi_disponibles = hayDisponibles;
        session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
        session.humanMode = true;
        io.emit("human_mode_changed", { waId: normalizePhone(clientWaId), humanMode: true });
        emitSessionUpdate(normalizePhone(clientWaId), session);
        await sendTextWithTyping(clientWaId,
          `No tenemos ${noHayNombres} 😔\n\n` +
          `Pero sí te puedo ofrecer:\n\n${linksDisponibles}\n\n` +
          `Dame un momento, te paso con un compañer@ para coordinar los detalles 🙌`
        );
      } else {
        // Varios disponibles — pasar al empleado
        session.multi_disponibles = hayDisponibles;
        session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
        session.humanMode = true;
        io.emit("human_mode_changed", { waId: normalizePhone(clientWaId), humanMode: true });
        emitSessionUpdate(normalizePhone(clientWaId), session);
        const totalDispParcial = hayDisponibles.reduce((s,p) => s + (p.precio||0), 0);
        await sendTextWithTyping(clientWaId,
          `No tenemos ${noHayNombres} 😔\n\n` +
          `Pero sí te puedo ofrecer:\n\n${linksDisponibles}\n\n` +
          `💰 Total disponible: ₡${totalDispParcial.toLocaleString()}\n\n` +
          `Dame un momento, te paso con un compañer@ para coordinar los detalles 🙌`
        );
      }
      
      saveDataToDisk();
      return { success: true, message: "Parcial con opciones" };
    }
    
    // Enviar foto individual de CADA producto disponible
    for(let i = 0; i < hayDisponibles.length; i++) {
      const p = hayDisponibles[i];
      const caption = `${i+1}. ${p.producto || 'Producto'}${p.talla ? ' · Talla: ' + p.talla : ''}${p.color ? ' · Color: ' + p.color : ''}\n💰 ₡${(p.precio||0).toLocaleString()}`;
      
      let fotoEnviada = false;
      // Intentar enviar foto local
      if(p.foto_url_local && !p.foto_url_local.startsWith('data:')) {
        try {
          const imgPath = path.join(PERSISTENT_DIR, p.foto_url_local);
          if(fs.existsSync(imgPath)) {
            const imgBuffer = fs.readFileSync(imgPath);
            await sock.sendMessage(clientWaId, { image: imgBuffer, caption });
            fotoEnviada = true;
          }
        } catch(e) { console.log(`⚠️ Error foto multi ${i}: ${e.message}`); }
      }
      // Fallback: intentar descargar del catálogo
      if(!fotoEnviada && p.codigo) {
        try {
          const localPath = await descargarImagenCatalogo(p.codigo, clientWaId);
          if(localPath) {
            const imgPath = path.join(PERSISTENT_DIR, localPath);
            if(fs.existsSync(imgPath)) {
              const imgBuffer = fs.readFileSync(imgPath);
              await sock.sendMessage(clientWaId, { image: imgBuffer, caption });
              fotoEnviada = true;
            }
          }
        } catch(e) { console.log(`⚠️ Error descarga foto multi ${i}: ${e.message}`); }
      }
      // Último fallback: solo texto
      if(!fotoEnviada) {
        await sendTextWithTyping(clientWaId, caption);
      }
      
      // Pequeña pausa entre fotos para no saturar
      if(i < hayDisponibles.length - 1) await new Promise(r => setTimeout(r, 1500));
    }
    
    if(hayDisponibles.length === 1) {
      // Solo uno disponible — pasar al empleado
      const p = hayDisponibles[0];
      session.producto = p.producto;
      session.precio = p.precio;
      session.codigo = p.codigo;
      session.talla_color = [p.talla, p.color, p.tamano].filter(Boolean).join(", ");
      session.foto_url = p.foto_url_local || p.foto_url;
      session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
      session.humanMode = true;
      io.emit("human_mode_changed", { waId: normalizePhone(clientWaId), humanMode: true });
      emitSessionUpdate(normalizePhone(clientWaId), session);
      await sendTextWithTyping(clientWaId,
        `¡Ese sí lo tenemos! 🎉\n\n📦 ${session.producto}\n👕 ${session.talla_color || '-'}\n💰 ₡${(session.precio||0).toLocaleString()}\n\nDame un momento, te paso con un compañer@ para coordinar los detalles 🙌`
      );
    } else {
      // Varios disponibles — pasar al empleado
      session.state = "ESPERANDO_CONFIRMACION_VENDEDOR";
      session.multi_disponibles = hayDisponibles;
      session.humanMode = true;
      io.emit("human_mode_changed", { waId: normalizePhone(clientWaId), humanMode: true });
      emitSessionUpdate(normalizePhone(clientWaId), session);
      const totalDisp = hayDisponibles.reduce((s,p) => s + p.precio, 0);
      const listaDispAll = hayDisponibles.map(p =>
        `✅ ${p.producto || 'Producto'} - ₡${(p.precio||0).toLocaleString()}`
      ).join("\n");
      await sendTextWithTyping(clientWaId,
        `¡Buenas noticias! Esos ${hayDisponibles.length} productos sí los tenemos 🎉\n\n${listaDispAll}\n\n💰 Total: ₡${totalDisp.toLocaleString()}\n\nDame un momento, te paso con un compañer@ para coordinar los detalles 🙌`
      );
    }
    
    saveDataToDisk();
    return { success: true, message: `${hayDisponibles.length} disponibles enviados al cliente` };
  }

  if (actionType === "PAGADO") {
    account.metrics.sinpe_confirmed += 1;
    pendingQuotes.delete(clientWaId);
    io.emit("pending_resolved", { waId: clientWaId });
    const profile = getProfile(clientWaId);
    profile.purchases = (profile.purchases || 0) + 1;
    const precio = session.precio || 0;
    const shipping = session.shipping_cost || 0;
    const total = precio + shipping;

    // Registrar venta
    const sale = {
      id: `V-${Date.now().toString(36).toUpperCase()}`,
      date: new Date().toISOString(),
      waId: clientWaId,
      phone: profile.phone || clientWaId,
      name: profile.name || "",
      producto: session.producto,
      codigo: session.codigo,
      talla_color: session.talla_color,
      method: session.delivery_method || "envio",
      precio,
      shipping,
      total,
      zone: session.client_zone,
      envio_datos: session.envio_datos_raw || null,
      sinpe_reference: session.sinpe_reference || null,
      comprobante_url: session.comprobante_url || null,
      foto_url: session.foto_url,
      status: "alistado",
      guia_correos: "",
      fecha_alistado: "",
      fecha_envio: "",
      fecha_entregado: ""
    };
    salesLog.push(sale);
    account.metrics.sales_completed = (account.metrics.sales_completed || 0) + 1;
    account.metrics.total_revenue = (account.metrics.total_revenue || 0) + total;
    console.log(`💰 VENTA #${sale.id}: ₡${total.toLocaleString()} - ${session.producto}`);
    updateCrmClient(clientWaId, sale);
    io.emit("sale_completed", sale);
    resetSession(session);
    saveDataToDisk();
    return { success: true, message: `Venta #${sale.id} registrada ₡${total.toLocaleString()}` };
  }

  if (actionType === "MENSAJE") {
    const texto = String(data.texto || "").trim();
    if (!texto) return { success: false, message: "Vacío" };
    await sendTextDirect(clientWaId, texto);
    // Resetear timer de inactividad
    session.humanModeLastActivity = Date.now();
    return { success: true, message: "Enviado" };
  }

  if (actionType === "TOMAR_CHAT") {
    session.humanMode = true;
    session.humanModeManual = true; // Manual — no se libera automáticamente
    session.humanModeAt = Date.now();
    session.humanModeLastActivity = Date.now();
    saveDataToDisk();
    console.log(`👤 Chat tomado manualmente: ${clientWaId}`);
    io.emit("human_mode_changed", { waId: normalizePhone(clientWaId), humanMode: true });
    emitSessionUpdate(normalizePhone(clientWaId), session);
    return { success: true, message: "Chat tomado. Bot pausado para este cliente." };
  }

  if (actionType === "LIBERAR_CHAT") {
    session.humanMode = false;
    session.humanModeManual = false;
    session.humanModeAt = null;
    session.humanModeLastActivity = null;
    saveDataToDisk();
    console.log(`🤖 Chat liberado manualmente al bot: ${clientWaId}`);
    io.emit("human_mode_changed", { waId: normalizePhone(clientWaId), humanMode: false });
    return { success: true, message: "Chat liberado. Bot retoma el control." };
  }

  if (actionType === "SINPE_ERROR") {
    // Notificar al cliente que hay un problema con el comprobante
    await sendTextWithTyping(clientWaId,
      `⚠️ Hay un problema con el comprobante que enviaste.\n\n` +
      `Por favor mandame de nuevo una foto clara del comprobante de SINPE 🧾📸\n\n` +
      `Asegurate que se vea:\n` +
      `• El monto\n` +
      `• La fecha\n` +
      `• El número de referencia`
    );
    saveDataToDisk();
    return { success: true, message: "Error SINPE notificado al cliente" };
  }

  if (actionType === "NO_ENVIO_ZONA") {
    await sendTextWithTyping(clientWaId,
      `Lo sentimos, no hacemos envíos a ${session.client_zone || "esa zona"} 😔\n\n` +
      `Si podés pasar a la tienda con mucho gusto te atendemos:\n` +
      `🏪 ${STORE_ADDRESS}\n🕒 ${HOURS_DAY}`
    );
    resetSession(session);
    saveDataToDisk();
    return { success: true, message: "Sin envío a esa zona" };
  }

  return { success: false, message: "Acción desconocida" };
}

// ============ SOCKET.IO ============
io.on("connection", (socket) => {
  let authenticated = false;
  socket.on("auth", (pin) => {
    // Aceptar PIN normal o 'auto' para entrada directa
    if (pin === PANEL_PIN || pin === "auto") {
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
      // Serializar sesiones activas con datos relevantes para el resumen
      const activeSessions = {};
      for (const [wId, s] of sessions.entries()) {
        if (s.producto || s.precio || s.talla_color || s.shipping_cost || s.envio_datos_raw || s.humanMode) {
          activeSessions[wId] = {
            producto: s.producto || null,
            precio: s.precio || null,
            talla_color: s.talla_color || null,
            shipping_cost: s.shipping_cost || null,
            envio_datos_raw: s.envio_datos_raw || null,
            delivery_method: s.delivery_method || null,
            client_zone: s.client_zone || null,
            humanMode: s.humanMode || false,
            humanModeManual: s.humanModeManual || false,
            humanModeAt: s.humanModeAt || null,
            humanModeLastActivity: s.humanModeLastActivity || null
          };
        }
      }
      socket.emit("init_data", { pending: Array.from(pendingQuotes.values()), pendingZones, history: fullHistory.slice(-500), contacts: Array.from(profiles.values()), metrics: account.metrics, sales: salesLog.slice(-50), crmClients: Array.from(crmClients.values()), humanModeChats: Array.from(sessions.entries()).filter(([,s]) => s.humanMode).map(([id]) => id), activeSessions, quickReplies });
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
  socket.on("toggle_bot_disabled", (data) => {
    if (!data.waId) return;
    const p = getProfile(data.waId);
    p.botDisabled = data.botDisabled;
    // Si se desactiva el bot para este contacto, activar humanMode en su sesión
    const s = sessions.get(normalizePhone(data.waId));
    if (s) {
      s.humanMode = data.botDisabled;
      s.humanModeManual = data.botDisabled;
      if (data.botDisabled) { s.humanModeAt = Date.now(); s.humanModeLastActivity = Date.now(); }
      else { s.humanModeAt = null; s.humanModeLastActivity = null; }
      io.emit("human_mode_changed", { waId: normalizePhone(data.waId), humanMode: data.botDisabled, manual: data.botDisabled });
    }
    saveDataToDisk();
    io.emit("contact_updated", { contact: p });
  });
  socket.on("add_contact", (data) => { if (!data.waId) return; const p = getProfile(data.waId); if (data.name) p.name = data.name; saveDataToDisk(); io.emit("contact_added", { contact: p }); });
  socket.on("update_contact", (data) => { if (!data.waId) return; const p = getProfile(data.waId); if (data.name !== undefined) p.name = data.name; if (data.blocked !== undefined) p.blocked = data.blocked; saveDataToDisk(); io.emit("contact_updated", { contact: p }); });
  socket.on("delete_contact", (data) => { if (!data.waId) return; profiles.delete(data.waId); saveDataToDisk(); io.emit("contact_deleted", { waId: data.waId }); });
  socket.on("delete_chats", (data) => { if (!data.waId) return; const n = normalizePhone(data.waId); chatHistory = chatHistory.filter(m => m.waId !== n); sessions.delete(n); pendingQuotes.delete(n); saveDataToDisk(); io.emit("chats_deleted", { waId: n }); });
  
  // Purgar datos antiguos por fecha
  socket.on("purge_data", (data) => {
    const { beforeDate, purgeSessions, purgeSales, purgeHistory } = data;
    if (!beforeDate) return socket.emit("purge_result", { success: false, error: "Falta fecha" });
    const cutoff = new Date(beforeDate).getTime();
    let sessionsDeleted = 0, salesDeleted = 0, historyDeleted = 0;
    
    if (purgeSessions) {
      const before = sessions.size;
      for (const [id, s] of sessions.entries()) {
        if (s.last_activity && s.last_activity < cutoff) {
          sessions.delete(id);
          sessionsDeleted++;
        }
      }
    }
    
    if (purgeSales) {
      const before = salesLog.length;
      salesLog = salesLog.filter(s => {
        const saleTime = s.date ? new Date(s.date).getTime() : (s.timestamp ? new Date(s.timestamp).getTime() : Date.now());
        return saleTime >= cutoff;
      });
      salesDeleted = before - salesLog.length;
    }
    
    if (purgeHistory) {
      const before = chatHistory.length;
      chatHistory = chatHistory.filter(m => {
        const msgTime = m.timestamp ? new Date(m.timestamp).getTime() : Date.now();
        return msgTime >= cutoff;
      });
      historyDeleted = before - chatHistory.length;
    }
    
    saveDataToDisk();
    console.log(`🗑️ PURGA: sesiones=${sessionsDeleted} ventas=${salesDeleted} historial=${historyDeleted} (antes de ${beforeDate})`);
    socket.emit("purge_result", { success: true, sessionsDeleted, salesDeleted, historyDeleted });
  });
  socket.on("get_metrics", () => { socket.emit("metrics", { metrics: account.metrics }); });
  socket.on("get_quick_replies", () => { socket.emit("quick_replies", { quickReplies }); });
  socket.on("save_quick_replies", (data) => { if (!Array.isArray(data.quickReplies)) return; quickReplies = data.quickReplies; saveDataToDisk(); io.emit("quick_replies", { quickReplies }); });
  socket.on("search_history", (filters) => { const results = searchHistory(filters); socket.emit("history_results", { count: results.length, messages: results }); });
});

// ============ ENDPOINTS ============
// ── PUSHOVER CALLBACK: Pushover llama aquí cuando el empleado hace Acknowledge ──
app.post("/api/pushover/callback", express.urlencoded({ extended: true }), express.json(), (req, res) => {
  // Pushover envía: receipt, acknowledged, acknowledged_at, acknowledged_by, called_back, called_back_at
  const { receipt, acknowledged, acknowledged_at } = req.body;
  
  if (!receipt) return res.sendStatus(200); // Responder siempre 200 a Pushover
  
  // Buscar la alerta por receipt
  const alert = alertsLog.find(a => a.receipt === receipt);
  if (alert && acknowledged === "1") {
    alert.estado = "atendida";
    alert.fecha_atendida = acknowledged_at 
      ? new Date(parseInt(acknowledged_at) * 1000).toISOString() 
      : new Date().toISOString();
    // Calcular minutos de respuesta
    const inicio = new Date(alert.fecha).getTime();
    const fin = new Date(alert.fecha_atendida).getTime();
    alert.minutos_respuesta = Math.round((fin - inicio) / 60000);
    saveDataToDisk();
    console.log(`✅ Alerta ${alert.id} atendida en ${alert.minutos_respuesta} min`);
  }
  
  res.sendStatus(200);
});

// ── API: Stats y log de alertas ──
app.get("/api/admin/alerts", adminAuth, (req, res) => {
  const { from, to, limit } = req.query;
  const now = new Date();
  const today = now.toISOString().slice(0,10);
  const weekAgo = new Date(now - 7*24*60*60*1000).toISOString();
  const monthAgo = new Date(now - 30*24*60*60*1000).toISOString();

  let filtered = [...alertsLog].reverse(); // Más recientes primero
  if (from) filtered = filtered.filter(a => a.fecha >= from);
  if (to)   filtered = filtered.filter(a => a.fecha <= to + "T23:59:59");
  if (limit) filtered = filtered.slice(0, parseInt(limit));

  // Stats globales
  const total     = alertsLog.length;
  const atendidas = alertsLog.filter(a => a.estado === "atendida").length;
  const pendientes= alertsLog.filter(a => a.estado === "pendiente").length;
  const tiempos   = alertsLog.filter(a => a.minutos_respuesta !== null).map(a => a.minutos_respuesta);
  const promMin   = tiempos.length > 0 ? Math.round(tiempos.reduce((s,v)=>s+v,0) / tiempos.length) : null;
  const maxMin    = tiempos.length > 0 ? Math.max(...tiempos) : null;
  const minMin    = tiempos.length > 0 ? Math.min(...tiempos) : null;

  // Stats por período
  const alertsToday = alertsLog.filter(a => a.fecha.startsWith(today));
  const alertsWeek  = alertsLog.filter(a => a.fecha >= weekAgo);
  const alertsMonth = alertsLog.filter(a => a.fecha >= monthAgo);

  // Stats por tipo
  const byTipo = {};
  alertsLog.forEach(a => {
    if (!byTipo[a.tipo]) byTipo[a.tipo] = { total:0, atendidas:0 };
    byTipo[a.tipo].total++;
    if (a.estado === "atendida") byTipo[a.tipo].atendidas++;
  });

  res.json({
    stats: {
      total, atendidas, pendientes,
      pct_atendidas: total > 0 ? Math.round((atendidas/total)*100) : 0,
      tiempo_promedio_min: promMin,
      tiempo_max_min: maxMin,
      tiempo_min_min: minMin,
      today:  { total: alertsToday.length,  atendidas: alertsToday.filter(a=>a.estado==="atendida").length },
      week:   { total: alertsWeek.length,   atendidas: alertsWeek.filter(a=>a.estado==="atendida").length },
      month:  { total: alertsMonth.length,  atendidas: alertsMonth.filter(a=>a.estado==="atendida").length },
      by_tipo: byTipo
    },
    alerts: filtered
  });
});

app.get("/health", (req, res) => res.send("OK"));
app.get("/status", (req, res) => res.json({ connection: connectionStatus, phone: connectedPhone, botPaused, storeOpen: isStoreOpen(), metrics: account.metrics }));
app.get("/api/history", (req, res) => {
  const results = searchHistory({ phone: req.query.phone, from: req.query.from, to: req.query.to, text: req.query.text });
  res.json({ count: results.length, messages: results });
});

app.use(express.json());

app.post("/api/admin/purge", (req, res) => {
  const pwd = req.query.pwd || req.headers['x-admin-pwd'] || req.body?.pwd;
  const token = req.query.token || req.headers['x-admin-token'] || req.body?.token;
  let authed = false;
  // Check token
  if(token && adminTokens.has(token)) {
    const t = adminTokens.get(token);
    if(t.expires > Date.now()) authed = true;
    else adminTokens.delete(token);
  }
  if(!authed && (pwd === ADMIN_PASSWORD || pwd === USER_PASSWORD)) authed = true;
  if(!authed && req.headers.cookie) {
    if(req.headers.cookie.includes(`admin_pwd=${ADMIN_PASSWORD}`) || req.headers.cookie.includes(`admin_pwd=${USER_PASSWORD}`)) authed = true;
  }
  if(!authed) return res.status(403).json({ success: false, error: "No autorizado" });
  
  const { beforeDate, purgeSessions, purgeSales, purgeHistory, purgeAlerts } = req.body;
  if (!beforeDate) return res.json({ success: false, error: "Falta fecha" });
  
  const cutoff = new Date(beforeDate).getTime();
  let sessionsDeleted = 0, salesDeleted = 0, historyDeleted = 0;
  
  if (purgeSessions) {
    for (const [id, s] of sessions.entries()) {
      if (s.last_activity && s.last_activity < cutoff) {
        sessions.delete(id);
        sessionsDeleted++;
      }
    }
  }
  
  if (purgeSales) {
    const before = salesLog.length;
    salesLog = salesLog.filter(s => {
      const saleTime = s.date ? new Date(s.date).getTime() : (s.timestamp ? new Date(s.timestamp).getTime() : Date.now());
      return saleTime >= cutoff;
    });
    salesDeleted = before - salesLog.length;
  }
  
  if (purgeHistory) {
    const before = chatHistory.length;
    chatHistory = chatHistory.filter(m => {
      const msgTime = m.timestamp ? new Date(m.timestamp).getTime() : Date.now();
      return msgTime >= cutoff;
    });
    historyDeleted = before - chatHistory.length;
  }

  let alertsDeleted = 0;
  if (purgeAlerts) {
    const before = alertsLog.length;
    alertsLog = alertsLog.filter(a => {
      const t = a.fecha ? new Date(a.fecha).getTime() : Date.now();
      return t >= cutoff;
    });
    alertsDeleted = before - alertsLog.length;
  }
  
  // Resetear métricas si se purgaron sesiones o ventas
  if(purgeSessions || purgeSales) {
    account.metrics.chats_total = 0;
    account.metrics.quotes_sent = 0;
    account.metrics.intent_yes = 0;
    account.metrics.intent_no = 0;
    account.metrics.delivery_envio = 0;
    account.metrics.delivery_recoger = 0;
    account.metrics.sinpe_confirmed = 0;
    account.metrics.sales_completed = salesLog.length;
    account.metrics.total_revenue = salesLog.reduce((s, v) => s + (v.total||0), 0);
    account.metrics.estados_sent = 0;
    account.metrics.mensajes_enviados = 0;
    account.metrics.ia_calls = 0;
  }
  
  saveDataToDisk();
  console.log(`🗑️ PURGA: sesiones=${sessionsDeleted} ventas=${salesDeleted} historial=${historyDeleted} alertas=${alertsDeleted} (antes de ${beforeDate})`);
  res.json({ success: true, sessionsDeleted, salesDeleted, historyDeleted, alertsDeleted });
});

app.get("/api/sales", (req, res) => {
  const { from, to } = req.query;
  let filtered = salesLog;
  if(from) filtered = filtered.filter(s => s.date >= from);
  if(to) filtered = filtered.filter(s => s.date <= to);
  const totalRevenue = filtered.reduce((sum, s) => sum + (s.total||0), 0);
  const totalShipping = filtered.reduce((sum, s) => sum + (s.shipping||0), 0);
  res.json({ 
    count: filtered.length, 
    total_revenue: totalRevenue,
    total_shipping: totalShipping,
    net_revenue: totalRevenue - totalShipping,
    sales: filtered.reverse() 
  });
});



// ============ API CRM ============
app.get("/api/crm/clients", adminAuth, (req, res) => {
  const { type, days } = req.query;
  let clients = Array.from(crmClients.values());
  
  // Filtrar por tipo
  if (type && type !== "todos") {
    clients = clients.filter(c => c.type === type);
  }
  
  // Filtrar por días sin comprar
  if (days) {
    const cutoff = Date.now() - (parseInt(days) * 24 * 60 * 60 * 1000);
    clients = clients.filter(c => new Date(c.lastPurchase).getTime() < cutoff);
  }
  
  // Ordenar por última compra (más reciente primero)
  clients.sort((a, b) => new Date(b.lastPurchase) - new Date(a.lastPurchase));
  
  res.json({
    total: clients.length,
    clients: clients
  });
});

app.get("/api/crm/stats", adminAuth, (req, res) => {
  const clients = Array.from(crmClients.values());
  const stats = {
    total: clients.length,
    primera: clients.filter(c => c.type === "primera").length,
    repetido: clients.filter(c => c.type === "repetido").length,
    frecuente: clients.filter(c => c.type === "frecuente").length,
    totalRevenue: clients.reduce((sum, c) => sum + c.totalSpent, 0),
    avgPurchases: clients.length > 0 ? (clients.reduce((sum, c) => sum + c.purchaseCount, 0) / clients.length).toFixed(1) : 0
  };
  res.json(stats);
});

// ============ ADMIN PANEL ============

// Middleware de auth con roles (dueno/usuario)
function adminAuth(req, res, next) {
  const pwd = req.query.pwd || req.headers['x-admin-pwd'];
  const token = req.query.token || req.headers['x-admin-token'];
  // Check token de sesión
  if(token && adminTokens.has(token)) {
    const t = adminTokens.get(token);
    if(t.expires > Date.now()) {
      req.role = t.pwd === ADMIN_PASSWORD ? "dueno" : "usuario";
      return next();
    } else { adminTokens.delete(token); }
  }
  // Check password
  if(pwd === ADMIN_PASSWORD) { req.role = "dueno"; return next(); }
  if(pwd === USER_PASSWORD) { req.role = "usuario"; return next(); }
  // Check cookies
  if(req.headers.cookie) {
    if(req.headers.cookie.includes(`admin_pwd=${ADMIN_PASSWORD}`)) { req.role = "dueno"; return next(); }
    if(req.headers.cookie.includes(`admin_pwd=${USER_PASSWORD}`)) { req.role = "usuario"; return next(); }
  }
  res.status(401).send(`
    <html><head><title>Admin - TICObot</title><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f1117}
    .login{background:#1a1d27;padding:30px;border-radius:12px;box-shadow:0 2px 20px rgba(0,0,0,.3);text-align:center;max-width:350px;width:90%;border:1px solid #2a2e3d}
    h2{margin:0 0 20px;color:#e4e6ef}input{width:100%;padding:12px;border:1px solid #2a2e3d;border-radius:8px;font-size:16px;box-sizing:border-box;margin-bottom:15px;background:#0f1117;color:#e4e6ef}
    button{width:100%;padding:12px;background:#22c55e;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;font-weight:bold}
    button:hover{background:#1da851}.hint{color:#8b8fa3;font-size:12px;margin-top:10px}</style></head>
    <body><div class="login"><h2>🐄 La Vaca Admin</h2><form method="GET"><input name="pwd" type="password" placeholder="Contraseña" autofocus>
    <button type="submit">Entrar</button></form></div></body></html>
  `);
}

app.get("/admin", adminAuth, (req, res) => {
  const pwd = req.query.pwd || '';
  // Generar token de sesión temporal (válido 24h)
  const sessionToken = Buffer.from(pwd + ':' + Date.now()).toString('base64');
  adminTokens.set(sessionToken, { pwd, expires: Date.now() + 86400000 });
  res.setHeader('Set-Cookie', `admin_pwd=${pwd}; Path=/; Max-Age=86400; SameSite=Lax`);
  const htmlPath = path.join(__dirname, "public", "control.html");
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace("const ADMIN_TOKEN_INJECTED = '';", `const ADMIN_TOKEN_INJECTED = '${sessionToken}';`);
  res.send(html);
});

// API: Obtener rol actual
app.get("/api/admin/role", adminAuth, (req, res) => {
  res.json({ role: req.role });
});

// API: Crear venta manual (atención humana por WhatsApp)
app.post("/api/admin/sales/manual", adminAuth, express.json(), (req, res) => {
  const { producto, precio, talla_color, method, phone, name, zone, shipping, envio_datos, sinpe_reference, notas } = req.body;
  if(!producto || !precio || !method) return res.status(400).json({ error: "Faltan datos obligatorios: producto, precio, método" });
  const parsedPrecio = Number(precio) || 0;
  const parsedShipping = Number(shipping) || 0;
  const total = parsedPrecio + parsedShipping;
  const normalizedPhone = phone ? normalizePhone(phone) : "";
  const sale = {
    id: `VM-${Date.now().toString(36).toUpperCase()}`,
    date: new Date().toISOString(),
    waId: normalizedPhone,
    phone: phone || "",
    name: name || "",
    producto, codigo: "", talla_color: talla_color || "",
    method, precio: parsedPrecio, shipping: parsedShipping, total,
    zone: zone || "", envio_datos: envio_datos || "",
    sinpe_reference: sinpe_reference || "", comprobante_url: "", foto_url: "",
    status: "alistado", guia_correos: "", fecha_alistado: "", fecha_envio: "", fecha_entregado: "",
    manual: true, notas: notas || ""
  };
  salesLog.push(sale);
  account.metrics.sales_completed = (account.metrics.sales_completed || 0) + 1;
  account.metrics.total_revenue = (account.metrics.total_revenue || 0) + total;
  if(normalizedPhone) {
    const profile = getProfile(normalizedPhone);
    if(name) profile.name = name;
    profile.purchases = (profile.purchases || 0) + 1;
    updateCrmClient(normalizedPhone, sale);
  }
  saveDataToDisk();
  io.emit("sale_completed", sale);
  console.log(`📝 VENTA MANUAL #${sale.id}: ₡${total.toLocaleString()} - ${producto} (${method})`);
  res.json({ success: true, sale });
});

// API: Actualizar venta (guia, fechas, status)
app.post("/api/admin/sales/update", adminAuth, express.json(), (req, res) => {
  const { saleId, field, value } = req.body;
  if(!saleId || !field) return res.status(400).json({ error: "Faltan datos" });
  
  const sale = salesLog.find(s => s.id === saleId);
  if(!sale) return res.status(404).json({ error: "Venta no encontrada" });
  
  const allowedFields = ["status", "guia_correos", "fecha_alistado", "fecha_envio", "fecha_entregado"];
  if(!allowedFields.includes(field)) return res.status(400).json({ error: "Campo no permitido" });
  
  sale[field] = value;
  
  // Auto-actualizar status según fechas
  if(field === "fecha_entregado" && value) sale.status = "entregado";
  else if(field === "fecha_envio" && value && sale.status !== "entregado") sale.status = "en_transito";
  else if(field === "status") sale.status = value;
  
  saveDataToDisk();
  console.log(`📝 Venta ${saleId}: ${field} = ${value} (status: ${sale.status})`);
  res.json({ success: true, sale });
});

app.get("/api/admin/dashboard", adminAuth, (req, res) => {
  const now = new Date();
  const today = now.toISOString().slice(0,10);
  const weekAgo = new Date(now - 7*24*60*60*1000).toISOString();
  const monthAgo = new Date(now - 30*24*60*60*1000).toISOString();
  
  // Ventas
  const salesToday = salesLog.filter(s => s.date && s.date.startsWith(today));
  const salesWeek = salesLog.filter(s => s.date >= weekAgo);
  const salesMonth = salesLog.filter(s => s.date >= monthAgo);
  
  const sumTotal = arr => arr.reduce((s,v) => s + (v.total||0), 0);
  const sumShipping = arr => arr.reduce((s,v) => s + (v.shipping||0), 0);
  
  // Sesiones activas y su estado
  const activeSessions = [];
  const abandoned = [];
  const noFollowUp = [];
  const noStock = [];
  
  const TWO_HOURS = 2*60*60*1000;
  
  for(const [wId, s] of sessions.entries()){
    const profile = profiles.get(wId) || {};
    const lastActivity = s.last_activity || 0;
    const age = Date.now() - lastActivity;
    const info = {
      waId: wId,
      phone: profile.phone || wId,
      name: profile.name || "",
      state: s.state,
      producto: s.producto,
      precio: s.precio,
      talla: s.talla_color,
      method: s.delivery_method,
      last_activity: new Date(lastActivity).toISOString(),
      age_minutes: Math.round(age/60000)
    };
    
    if(s.state !== "NEW"){
      activeSessions.push(info);
      
      // Abandonados: cliente no respondió en >2h mientras bot esperaba respuesta
      const clientWaiting = ["PREGUNTANDO_METODO","PRECIO_TOTAL_ENVIADO","ESPERANDO_UBICACION_ENVIO","ESPERANDO_SINPE","ESPERANDO_DATOS_ENVIO","CONFIRMANDO_DATOS_ENVIO"];
      if(clientWaiting.includes(s.state) && age > TWO_HOURS){
        abandoned.push(info);
      }
      
      // Sin seguimiento del operador: dueño no respondió
      const ownerWaiting = ["ESPERANDO_CONFIRMACION_VENDEDOR","ZONA_RECIBIDA","MULTI_ESPERANDO_DISPONIBILIDAD"];
      if(ownerWaiting.includes(s.state) && age > 30*60*1000){ // >30 min
        noFollowUp.push(info);
      }
    }
  }
  
  // Chats agotados (de pendingQuotes con acción AGOTADO)
  // Contamos desde métricas
  
  // Historial de conversaciones únicas del día
  const todayMessages = fullHistory.filter(m => m.timestamp && m.timestamp.startsWith(today));
  const uniqueChatsToday = [...new Set(todayMessages.map(m => m.waId))].length;
  const weekMessages = fullHistory.filter(m => m.timestamp >= weekAgo);
  const uniqueChatsWeek = [...new Set(weekMessages.map(m => m.waId))].length;
  
  res.json({
    timestamp: now.toISOString(),
    connection: connectionStatus,
    phone: connectedPhone,
    botPaused,
    storeOpen: isStoreOpen(),
    
    metrics: account.metrics,
    
    sales: {
      today: { count: salesToday.length, revenue: sumTotal(salesToday), shipping: sumShipping(salesToday), net: sumTotal(salesToday) - sumShipping(salesToday) },
      week: { count: salesWeek.length, revenue: sumTotal(salesWeek), shipping: sumShipping(salesWeek), net: sumTotal(salesWeek) - sumShipping(salesWeek) },
      month: { count: salesMonth.length, revenue: sumTotal(salesMonth), shipping: sumShipping(salesMonth), net: sumTotal(salesMonth) - sumShipping(salesMonth) },
      all: { count: salesLog.length, revenue: sumTotal(salesLog), shipping: sumShipping(salesLog), net: sumTotal(salesLog) - sumShipping(salesLog) },
      recent: salesLog.slice(-20).reverse()
    },
    
    chats: {
      today: uniqueChatsToday,
      week: uniqueChatsWeek,
      active: activeSessions.length,
      active_list: activeSessions
    },
    
    alerts: {
      abandoned: abandoned,
      no_followup: noFollowUp
    },
    
    contacts_total: profiles.size
  });
});

app.get("/api/admin/sales", adminAuth, (req, res) => {
  const { from, to, limit } = req.query;
  let filtered = [...salesLog];
  if(from) filtered = filtered.filter(s => s.date >= from);
  if(to) filtered = filtered.filter(s => s.date <= to);
  filtered.reverse();
  if(limit) filtered = filtered.slice(0, parseInt(limit));
  const totalRevenue = filtered.reduce((s,v) => s + (v.total||0), 0);
  res.json({ count: filtered.length, revenue: totalRevenue, sales: filtered });
});

app.get("/api/admin/chats", adminAuth, (req, res) => {
  const { waId, from, to, limit } = req.query;
  let filtered = [...fullHistory];
  if(waId) filtered = filtered.filter(m => m.waId === waId);
  if(from) filtered = filtered.filter(m => m.timestamp >= from);
  if(to) filtered = filtered.filter(m => m.timestamp <= to);
  if(limit) filtered = filtered.slice(-parseInt(limit));
  
  // Agrupar por conversación
  const convos = {};
  filtered.forEach(m => {
    if(!convos[m.waId]) convos[m.waId] = { waId: m.waId, phone: m.phone, name: m.name, messages: [], first: m.timestamp, last: m.timestamp };
    convos[m.waId].messages.push(m);
    if(m.timestamp > convos[m.waId].last) convos[m.waId].last = m.timestamp;
  });
  
  const convoList = Object.values(convos).sort((a,b) => b.last.localeCompare(a.last));
  res.json({ count: convoList.length, conversations: convoList.slice(0, parseInt(limit)||50) });
});

// ============ CONTACTS API ============

app.get("/api/admin/contacts", adminAuth, (req, res) => {
  const { search } = req.query;
  let list = Array.from(profiles.values());
  if (search) {
    const s = search.toLowerCase();
    list = list.filter(p => (p.name||'').toLowerCase().includes(s) || (p.waId||'').includes(s));
  }
  // Enriquecer con stats de ventas
  const statsByPhone = {};
  salesLog.forEach(sale => {
    const phone = sale.waId || sale.phone || '';
    if (!phone) return;
    if (!statsByPhone[phone]) statsByPhone[phone] = { count: 0, total: 0, last: null };
    statsByPhone[phone].count++;
    statsByPhone[phone].total += (sale.total || 0);
    if (!statsByPhone[phone].last || sale.date > statsByPhone[phone].last) statsByPhone[phone].last = sale.date;
  });
  list = list.map(p => ({
    ...p,
    purchases: statsByPhone[p.waId]?.count || p.purchases || 0,
    total_spent: statsByPhone[p.waId]?.total || 0,
    last_purchase: statsByPhone[p.waId]?.last || null
  }));
  list.sort((a, b) => (b.purchases || 0) - (a.purchases || 0));
  res.json({ total: list.length, contacts: list });
});

app.post("/api/admin/contacts", adminAuth, express.json(), (req, res) => {
  const { waId, name, phone, notes, botDisabled } = req.body;
  if (!waId) return res.status(400).json({ error: "waId requerido" });
  const id = normalizePhone(waId);
  const existing = profiles.get(id) || { waId: id, purchases: 0, created_at: new Date().toISOString() };
  if (name !== undefined) existing.name = name;
  if (phone !== undefined) existing.phone = phone;
  if (notes !== undefined) existing.notes = notes;
  if (botDisabled !== undefined) {
    existing.botDisabled = botDisabled;
    // Sincronizar humanMode en sesión activa
    const s = sessions.get(id);
    if (s) {
      s.humanMode = botDisabled;
      s.humanModeManual = botDisabled;
      if (botDisabled) { s.humanModeAt = s.humanModeAt || Date.now(); s.humanModeLastActivity = Date.now(); }
      else { s.humanModeAt = null; s.humanModeLastActivity = null; }
      io.emit("human_mode_changed", { waId: id, humanMode: botDisabled, manual: botDisabled });
    }
  }
  profiles.set(id, existing);
  saveDataToDisk();
  res.json({ success: true, contact: existing });
});

app.delete("/api/admin/contacts/:waId", adminAuth, (req, res) => {
  const id = normalizePhone(decodeURIComponent(req.params.waId));
  if (!profiles.has(id)) return res.status(404).json({ error: "No encontrado" });
  profiles.delete(id);
  saveDataToDisk();
  res.json({ success: true });
});

app.delete("/api/admin/sales/:saleId", adminAuth, (req, res) => {
  const idx = salesLog.findIndex(s => s.id === req.params.saleId);
  if (idx === -1) return res.status(404).json({ error: "Venta no encontrada" });
  salesLog.splice(idx, 1);
  saveDataToDisk();
  res.json({ success: true });
});

// ============ INICIAR ============
server.listen(PORT, async () => {
  // Asegurar que /data existe
  if (!fs.existsSync(PERSISTENT_DIR)) { try { fs.mkdirSync(PERSISTENT_DIR, { recursive: true }); } catch(e) { console.log("⚠️ No se pudo crear /data:", e.message); } }
  loadDataFromDisk();
  loadCrmData();
  loadCategoriasActivas();
  loadHistory();
  
  // Cargar catálogo y categorías activas
  await loadCatalog();
    
  console.log(`
╔═══════════════════════════════════════════════════╗
║  🐄 TICO-bot - La Vaca CR                         ║
╠═══════════════════════════════════════════════════╣
║  🕒 Horario: ${HOURS_DAY.padEnd(36)}║
║  ⏱️ Delay: ${(DELAY_MIN + "-" + DELAY_MAX + " seg").padEnd(37)}║
║  🌐 Catálogo: ${CATALOG_URL.slice(0,33).padEnd(34)}║
║  📦 Productos: ${String(catalogProducts.length).padEnd(33)}║
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
