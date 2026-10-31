import { uid } from "./util.js";

export const JOBS = ["price", "hourly", "four_hour", "daily", "weekly"];
export const MAX_CHANNELS = 20;

const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"];

const num = (v, min, max, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const int = (v, min, max, def) => Math.floor(num(v, min, max, def));

export function newChannel(over = {}) {
  return {
    id: uid("ch"),
    name: "قناة جديدة",
    enabled: true,
    chatId: "",
    channelUrl: "",
    buttonText: "",
    title: "CRYPTO MARKET",
    symbols: [...DEFAULT_SYMBOLS],
    tzOffset: 3,
    showHighLow: true,
    showVolume: true,
    technicals: false,
    jobs: {
      price: { enabled: true, everyMinutes: 5 },
      hourly: { enabled: true },
      four_hour: { enabled: true },
      daily: { enabled: false, hour: 0 },
      weekly: { enabled: false, day: 5, hour: 0 }
    },
    alerts: {
      moves: { enabled: false, percent: 3, minutes: 15, cooldown: 60 },
      levels: []
    },
    ...over
  };
}

// "btc" أو "BTCUSDT" كلاهما مقبول
export function normalizeSymbol(x) {
  let s = String(x).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return "";
  if (!s.endsWith("USDT")) s += "USDT";
  return s;
}

export function cleanSymbols(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[\n,،\s]+/);
  const symbols = [...new Set(list.map(normalizeSymbol).filter(Boolean))];

  if (!symbols.length) throw new Error("لازم زوج واحد على الأقل بكل قناة");
  if (symbols.length > 100) throw new Error("الحد الأقصى 100 زوج لكل قناة");

  const bad = symbols.find(s => !/^[A-Z0-9]{5,20}$/.test(s));
  if (bad) throw new Error(`رمز غير صالح: ${bad}`);

  return symbols;
}

const CHAT_RE = /^(@[A-Za-z][A-Za-z0-9_]{3,}|-?\d{5,})$/;

function sanitizeChannel(c, old) {
  const base = newChannel();
  const name = String(c.name ?? base.name).trim().slice(0, 40) || "قناة";
  const enabled = c.enabled !== false;
  const chatId = String(c.chatId ?? "").trim();

  if (chatId && !CHAT_RE.test(chatId)) {
    throw new Error(`[${name}] chat id غير صالح. استعمل @username أو رقم يبدأ بـ -100`);
  }
  if (enabled && !chatId) {
    throw new Error(`[${name}] اكتب chat id أو عطّل القناة`);
  }

  const channelUrl = String(c.channelUrl ?? "").trim();
  if (channelUrl && !/^https?:\/\/\S+$/.test(channelUrl)) {
    throw new Error(`[${name}] رابط القناة لازم يبدأ بـ https://`);
  }

  let symbols;
  try { symbols = cleanSymbols(c.symbols); }
  catch (e) { throw new Error(`[${name}] ${e.message}`); }

  const j = c.jobs || {};
  const a = c.alerts || {};
  const m = a.moves || {};
  const oldLevels = new Map((old?.alerts?.levels || []).map(l => [l.id, l]));

  const levels = (Array.isArray(a.levels) ? a.levels : []).slice(0, 20).map(l => {
    const price = Number(l.price);
    const symbol = normalizeSymbol(l.symbol);
    if (!symbol || !Number.isFinite(price) || price <= 0) {
      throw new Error(`[${name}] مستوى سعر غير صالح`);
    }
    const id = /^[a-z0-9_]{3,30}$/.test(String(l.id)) ? l.id : uid("lv");
    const prev = oldLevels.get(id);
    const dir = l.dir === "below" ? "below" : "above";
    const same = prev && prev.symbol === symbol && prev.dir === dir && prev.price === price;
    return { id, symbol, dir, price, triggered: same ? Boolean(l.triggered) : false };
  });

  return {
    id: /^[a-z0-9_]{3,30}$/.test(String(c.id)) ? c.id : uid("ch"),
    name,
    enabled,
    chatId,
    channelUrl,
    buttonText: String(c.buttonText ?? "").trim().slice(0, 40),
    title: String(c.title ?? base.title).trim().slice(0, 50) || base.title,
    symbols,
    tzOffset: num(c.tzOffset, -12, 14, 3),
    showHighLow: c.showHighLow !== false,
    showVolume: c.showVolume !== false,
    technicals: Boolean(c.technicals),
    jobs: {
      price: { enabled: j.price?.enabled !== false, everyMinutes: int(j.price?.everyMinutes, 1, 1440, 5) },
      hourly: { enabled: j.hourly?.enabled !== false },
      four_hour: { enabled: j.four_hour?.enabled !== false },
      daily: { enabled: Boolean(j.daily?.enabled), hour: int(j.daily?.hour, 0, 23, 0) },
      weekly: {
        enabled: Boolean(j.weekly?.enabled),
        day: int(j.weekly?.day, 0, 6, 5),
        hour: int(j.weekly?.hour, 0, 23, 0)
      }
    },
    alerts: {
      moves: {
        enabled: Boolean(m.enabled),
        percent: num(m.percent, 0.1, 100, 3),
        minutes: int(m.minutes, 1, 60, 15),
        cooldown: int(m.cooldown, 1, 1440, 60)
      },
      levels
    }
  };
}

export function sanitizeConfig(input, existing) {
  if (!input || typeof input !== "object") throw new Error("إعدادات غير صالحة");

  const channels = Array.isArray(input.channels) ? input.channels : [];
  if (channels.length > MAX_CHANNELS) throw new Error(`الحد الأقصى ${MAX_CHANNELS} قناة`);

  const oldById = new Map((existing?.channels || []).map(c => [c.id, c]));
  const clean = channels.map(c => sanitizeChannel(c, oldById.get(c.id)));

  if (new Set(clean.map(c => c.id)).size !== clean.length) {
    throw new Error("معرّف قناة مكرر");
  }

  const adminChatId = String(input.adminChatId ?? "").trim();
  if (adminChatId && !CHAT_RE.test(adminChatId)) {
    throw new Error("chat id الخاص بتنبيهات الأخطاء غير صالح");
  }

  return {
    version: 2,
    paused: Boolean(input.paused),
    adminChatId,
    channels: clean
  };
}

// أول تشغيل: ننقل إعدادات النسخة القديمة (KV) إن وجدت
export function buildInitialConfig(env, legacy) {
  const first = newChannel({
    name: "القناة الرئيسية",
    chatId: String(env.TELEGRAM_CHAT_ID || ""),
    title: legacy?.title || "KRYPTON MARKETS",
    channelUrl: legacy?.channelUrl || "https://t.me/Krypton_coins",
    symbols: legacy?.symbols?.length ? legacy.symbols : [...DEFAULT_SYMBOLS],
    showHighLow: legacy?.showHighLow !== false,
    showVolume: legacy?.showVolume !== false
  });

  first.jobs.price.everyMinutes = int(legacy?.priceEveryMinutes, 1, 1440, 5);

  return { version: 2, paused: false, adminChatId: "", channels: [first] };
}
