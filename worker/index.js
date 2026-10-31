// KRYPTON MARKETS v2 — قنوات متعددة + جدولة مقاومة للفشل
// نفس الربط القديم: KV باسم CONFIG + أسرار TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / ADMIN_KEY + كرون كل دقيقة.

const MAIN_ID = "main";
const MAX_CHANNELS = 20;
const MIN = 60000;

const DEFAULT_CHANNEL = {
  id: MAIN_ID,
  name: "القناة الرئيسية",
  chatId: "",                      // فارغ = يستخدم TELEGRAM_CHAT_ID من الأسرار
  enabled: true,
  title: "KRYPTON MARKETS",
  channelUrl: "https://t.me/Krypton_coins",
  buttonText: "",
  symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"],
  showHighLow: true,
  showVolume: true,
  tzOffset: 0,
  price: { enabled: true, every: 5 },
  hourly: { enabled: true },
  fourHour: { enabled: true },
  daily: { enabled: false, hour: 21 },
  alerts: { enabled: false, threshold: 3, window: "15m", cooldown: 60 }
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const BINANCE_ENDPOINTS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api-gcp.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com"
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

function cors(response) {
  const h = new Headers(response.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  h.set("access-control-allow-headers", "Content-Type, Authorization");
  return new Response(response.body, { status: response.status, headers: h });
}

function isAuthorized(request, env) {
  const supplied = request.headers.get("authorization") || "";
  return Boolean(env.ADMIN_KEY) && supplied === `Bearer ${env.ADMIN_KEY}`;
}

function checkKV(env) {
  if (!env.CONFIG) throw new Error("KV_BINDING_MISSING");
}

// ---------- Config (قنوات) ----------

const merge = (...objs) => Object.assign({}, ...objs.map(o =>
  Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined))));

function num(v, min, max, code, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(code);
  return n;
}

function cleanSymbols(value) {
  if (!Array.isArray(value)) throw new Error("INVALID_SYMBOLS");
  const symbols = [...new Set(value.map(x => String(x).trim().toUpperCase()).filter(Boolean))];
  if (!symbols.length || symbols.length > 100) throw new Error("INVALID_SYMBOL_COUNT");
  if (symbols.some(s => !/^[A-Z0-9]{5,20}$/.test(s) || !s.endsWith("USDT"))) {
    throw new Error("INVALID_SYMBOL_FORMAT");
  }
  return symbols;
}

function normalizeChannel(body, old) {
  const b = body || {};
  const o = old || {};
  const pick = (k, d) => (b[k] !== undefined ? b[k] : (o[k] !== undefined ? o[k] : d));

  const chatId = String(pick("chatId", "")).trim();
  if (chatId && !/^(@[A-Za-z][A-Za-z0-9_]{4,31}|-?\d{5,20})$/.test(chatId)) throw new Error("INVALID_CHAT_ID");

  const price = merge(DEFAULT_CHANNEL.price, o.price, b.price);
  const hourly = merge(DEFAULT_CHANNEL.hourly, o.hourly, b.hourly);
  const fourHour = merge(DEFAULT_CHANNEL.fourHour, o.fourHour, b.fourHour);
  const daily = merge(DEFAULT_CHANNEL.daily, o.daily, b.daily);
  const alerts = merge(DEFAULT_CHANNEL.alerts, o.alerts, b.alerts);

  const window = String(alerts.window);
  if (!["5m", "15m", "30m", "1h"].includes(window)) throw new Error("INVALID_ALERT_WINDOW");
  const threshold = Number(alerts.threshold);
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 50) throw new Error("INVALID_ALERT_THRESHOLD");

  return {
    id: o.id || b.id,
    name: String(pick("name", "قناة")).trim().slice(0, 40) || "قناة",
    chatId,
    enabled: pick("enabled", true) !== false,
    title: String(pick("title", DEFAULT_CHANNEL.title)).trim().slice(0, 50) || DEFAULT_CHANNEL.title,
    channelUrl: String(pick("channelUrl", "")).trim().slice(0, 200),
    buttonText: String(pick("buttonText", "")).trim().slice(0, 60),
    symbols: cleanSymbols(pick("symbols", DEFAULT_CHANNEL.symbols)),
    showHighLow: pick("showHighLow", true) !== false,
    showVolume: pick("showVolume", true) !== false,
    tzOffset: num(pick("tzOffset", 0), -12, 14, "INVALID_TZ", 0),
    price: { enabled: price.enabled !== false, every: num(price.every, 1, 1440, "INVALID_INTERVAL", 5) },
    hourly: { enabled: hourly.enabled !== false },
    fourHour: { enabled: fourHour.enabled !== false },
    daily: { enabled: daily.enabled === true, hour: num(daily.hour, 0, 23, "INVALID_DAILY_HOUR", 21) },
    alerts: {
      enabled: alerts.enabled === true,
      threshold,
      window,
      cooldown: num(alerts.cooldown, 5, 1440, "INVALID_COOLDOWN", 60)
    }
  };
}

async function getChannels(env) {
  checkKV(env);
  const saved = await env.CONFIG.get("channels", "json");
  if (Array.isArray(saved) && saved.length) return saved;

  // ترحيل تلقائي من الإعداد القديم bot_config → قناة main بنفس السلوك السابق
  const legacy = (await env.CONFIG.get("bot_config", "json")) || {};
  return [normalizeChannel({
    id: MAIN_ID,
    title: legacy.title,
    channelUrl: legacy.channelUrl,
    symbols: legacy.symbols,
    showHighLow: legacy.showHighLow,
    showVolume: legacy.showVolume,
    price: { every: legacy.priceEveryMinutes },
    buttonText: "📢 JOIN KRYPTON MARKETS"
  }, DEFAULT_CHANNEL)];
}

async function saveChannels(env, list) {
  await env.CONFIG.put("channels", JSON.stringify(list));
}

function findChannel(list, id) {
  const ch = list.find(c => c.id === id);
  if (!ch) throw new Error("CHANNEL_NOT_FOUND");
  return ch;
}

function newId() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return "c" + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

// ---------- State (مخزّن في KV: كتابة فقط عند النشر الناجح) ----------

const memory = { slots: {}, last: {}, endpoint: null };

async function loadState(env) {
  const s = await env.CONFIG.get("state", "json");
  return { slots: {}, last: {}, errors: {}, cooldown: {}, ...(s || {}) };
}

async function saveState(env, state, channels) {
  const ids = new Set(channels.map(c => c.id));
  const keep = k => ids.has(k.split(":")[0]);
  for (const part of ["slots", "last", "cooldown"]) {
    state[part] = Object.fromEntries(Object.entries(state[part] || {}).filter(([k]) => keep(k)));
  }
  state.errors = Object.fromEntries(Object.entries(state.errors || {}).filter(([k]) => ids.has(k)));
  const cutoff = Date.now() - 86400000;
  state.cooldown = Object.fromEntries(Object.entries(state.cooldown).filter(([, t]) => t > cutoff));
  await env.CONFIG.put("state", JSON.stringify(state));
}

// ---------- Formatting ----------

function fmt(value, digits = 8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  if (digits <= 0) return Math.round(n).toLocaleString("en-US");
  return n.toLocaleString("en-US", { maximumSignificantDigits: Math.max(1, Math.min(21, Math.floor(digits))) });
}

function signed(value, suffix = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  return `${n > 0 ? "+" : ""}${fmt(n)}${suffix}`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function timeLabel(tz = 0) {
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date(Date.now() + tz * 3600000));
  return `${text} UTC${tz === 0 ? "" : (tz > 0 ? "+" : "") + tz}`;
}

const coinName = s => s.replace(/USDT$/, "");
const SEP = "━━━━━━━━━━━━━━━━━━";

// ---------- Binance ----------

class BadRequestError extends Error {
  constructor(msg) { super(msg); this.code = "BAD_REQUEST"; }
}

async function binanceGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const errors = [];
  const order = memory.endpoint
    ? [memory.endpoint, ...BINANCE_ENDPOINTS.filter(x => x !== memory.endpoint)]
    : BINANCE_ENDPOINTS;

  for (const base of order) {
    try {
      const response = await fetch(`${base}${path}${qs ? "?" + qs : ""}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
        cf: { cacheTtl: 0, cacheEverything: false }
      });
      const body = await response.text();
      if (response.status === 400) throw new BadRequestError(body.slice(0, 200));
      if (!response.ok) { errors.push(`${base}: HTTP ${response.status}`); continue; }
      const data = JSON.parse(body);
      memory.endpoint = base;
      return data;
    } catch (error) {
      if (error instanceof BadRequestError) throw error;
      errors.push(`${base}: ${error.message}`);
    }
  }

  console.error("BINANCE_ERRORS:", JSON.stringify(errors));
  throw new Error("BINANCE_ALL_ENDPOINTS_FAILED");
}

async function tickerCall(path, symbols, extra) {
  const params = symbols.length === 1
    ? { symbol: symbols[0], ...extra }
    : { symbols: JSON.stringify(symbols), ...extra };
  const data = await binanceGet(path, params);
  return Array.isArray(data) ? data : [data];
}

async function fetchTickers(symbols, path, extra) {
  try {
    return await tickerCall(path, symbols, extra);
  } catch (error) {
    if (error.code !== "BAD_REQUEST") throw error;
    const all = await binanceGet("/api/v3/ticker/price");
    const valid = new Set(all.map(x => x.symbol));
    const usable = symbols.filter(s => valid.has(s));
    console.warn("INVALID_SYMBOLS_SKIPPED:", symbols.filter(s => !valid.has(s)).join(","));
    if (!usable.length) throw new Error("NO_VALID_SYMBOLS");
    return tickerCall(path, usable, extra);
  }
}

// ctx.cache: نفس الطلب لا يتكرر داخل نفس الدقيقة لو أكثر من قناة تستخدم نفس العملات
function getTickers(ctx, symbols, path = "/api/v3/ticker/24hr", extra = {}) {
  const key = path + JSON.stringify(extra) + symbols.join(",");
  if (!ctx.cache.has(key)) {
    const p = fetchTickers(symbols, path, extra);
    ctx.cache.set(key, p);
    p.catch(() => ctx.cache.delete(key));
  }
  return ctx.cache.get(key);
}

async function getWindowData(ctx, symbols, windowSize) {
  const tickers = await getTickers(ctx, symbols, "/api/v3/ticker", { windowSize });
  const by = new Map(tickers.map(t => [t.symbol, t]));
  return symbols.map(symbol => {
    const t = by.get(symbol);
    if (!t || !Number.isFinite(Number(t.priceChangePercent))) return { symbol, available: false };
    return {
      symbol, available: true,
      open: Number(t.openPrice), close: Number(t.lastPrice),
      change: Number(t.priceChange), percent: Number(t.priceChangePercent)
    };
  });
}

async function getDailyData(ctx, symbols) {
  const tickers = await getTickers(ctx, symbols);
  const by = new Map(tickers.map(t => [t.symbol, t]));
  return symbols.map(symbol => {
    const t = by.get(symbol);
    if (!t || !Number.isFinite(Number(t.priceChangePercent))) return { symbol, available: false };
    return {
      symbol, available: true,
      close: Number(t.lastPrice), change: Number(t.priceChange), percent: Number(t.priceChangePercent)
    };
  });
}

// ---------- Message builders ----------

function marketDirection(items) {
  const valid = items.filter(x => x.available);
  if (!valid.length) return { label: "DATA UNAVAILABLE", emoji: "⚪" };
  const average = valid.reduce((s, i) => s + i.percent, 0) / valid.length;
  if (average >= 0.5) return { label: "BULLISH MARKET", emoji: "🟢", average };
  if (average <= -0.5) return { label: "BEARISH MARKET", emoji: "🔴", average };
  return { label: "SIDEWAYS MARKET", emoji: "🟡", average };
}

function topMovers(items, count = 5) {
  const valid = items.filter(x => x.available);
  return {
    gainers: [...valid].sort((a, b) => b.percent - a.percent).slice(0, count),
    losers: [...valid].sort((a, b) => a.percent - b.percent).slice(0, count)
  };
}

function moversBlock(list, emptyText) {
  return list.length
    ? list.map(x => `${x.percent < 0 ? "🔴" : "🟢"} ${escapeHtml(coinName(x.symbol))}: ${signed(x.percent, "%")}`).join("\n")
    : emptyText;
}

function priceRows(ch, tickers) {
  const by = new Map(tickers.map(t => [t.symbol, t]));
  const rows = [];
  for (const symbol of ch.symbols) {
    const t = by.get(symbol);
    if (!t) continue;
    const pct = Number(t.priceChangePercent);
    const emoji = pct > 0 ? "🟢 ▲" : pct < 0 ? "🔴 ▼" : "⚪ ●";
    let row = `${emoji} <b>${escapeHtml(coinName(symbol))}/USDT</b>\n`;
    row += `Price: <b>$${fmt(t.lastPrice)}</b>\n`;
    row += `24H Change: ${signed(t.priceChange, " USDT")} (${signed(pct, "%")})`;
    if (ch.showHighLow) row += `\n24H High: $${fmt(t.highPrice)} | Low: $${fmt(t.lowPrice)}`;
    if (ch.showVolume) row += `\n24H Volume: $${fmt(t.quoteVolume, 7)}\nTrades: ${fmt(t.count, 0)}`;
    rows.push(row);
  }
  return rows;
}

const ROW_SEP = `\n\n${SEP}\n\n`;

function buildPriceMessages(ch, tickers) {
  const rows = priceRows(ch, tickers);
  if (!rows.length) throw new Error("NO_PRICE_DATA");

  const footer = `\n\n${SEP}\n🕒 ${timeLabel(ch.tzOffset)}\n📡 Source: Binance Spot`;
  const header = (part, total) =>
    `📊 <b>${escapeHtml(ch.title)}</b>\n` +
    `<b>LIVE CRYPTO MARKET UPDATE${total > 1 ? ` (${part}/${total})` : ""}</b>\n${SEP}\n\n`;

  const LIMIT = 3800;
  const chunks = [];
  let current = [];
  for (const row of rows) {
    const trial = [...current, row].join(ROW_SEP);
    if (current.length && header(9, 9).length + trial.length + footer.length > LIMIT) {
      chunks.push(current);
      current = [row];
    } else current.push(row);
  }
  chunks.push(current);
  return chunks.map((c, i) => header(i + 1, chunks.length) + c.join(ROW_SEP) + footer);
}

function buildHourlyMessage(ch, items, windowLabel = "1H") {
  const dir = marketDirection(items);
  const mv = topMovers(items);
  const valid = items.filter(x => x.available);
  let m =
    `📊 <b>${escapeHtml(ch.title)}</b>\n<b>HOURLY MARKET ANALYSIS</b>\n${SEP}\n\n` +
    `${dir.emoji} <b>${dir.label}</b>\n`;
  if (dir.average !== undefined) m += `Average selected-coin movement: ${signed(dir.average, "%")}\n`;
  m += `Coins analyzed: ${valid.length}/${ch.symbols.length}\n\n${SEP}\n` +
    `🏆 <b>TOP GAINERS · ${windowLabel}</b>\n${moversBlock(mv.gainers, "No hourly data available.")}` +
    `\n\n📉 <b>TOP LOSERS · ${windowLabel}</b>\n${moversBlock(mv.losers, "No hourly data available.")}` +
    `\n\n${SEP}\n<b>BITCOIN STATUS</b>\n`;
  const btc = items.find(x => x.symbol === "BTCUSDT");
  m += btc && btc.available
    ? `Price: $${fmt(btc.close)}\n${windowLabel} Change: ${signed(btc.change)} (${signed(btc.percent, "%")})\n`
    : "Hourly Bitcoin data unavailable.\n";
  m += `\n${SEP}\n🕒 ${timeLabel(ch.tzOffset)}\n📡 Source: Binance Spot\n⚠️ Market data is informational, not financial advice.`;
  return m;
}

function buildFourHourMessage(ch, items) {
  const dir = marketDirection(items);
  const mv = topMovers(items);
  let m =
    `🌍 <b>${escapeHtml(ch.title)}</b>\n<b>4-HOUR MARKET TREND REPORT</b>\n${SEP}\n\n` +
    `${dir.emoji} <b>${dir.label}</b>\n`;
  if (dir.average !== undefined) m += `Average selected-coin movement: ${signed(dir.average, "%")}\n`;
  m += `Coins analyzed: ${items.filter(x => x.available).length}/${ch.symbols.length}\n\n${SEP}\n` +
    `🚀 <b>TOP PERFORMERS · 4H</b>\n${moversBlock(mv.gainers, "No data available.")}` +
    `\n\n📉 <b>WEAKEST PERFORMERS · 4H</b>\n${moversBlock(mv.losers, "No data available.")}` +
    `\n\n${SEP}\n🕒 ${timeLabel(ch.tzOffset)}\n📡 Source: Binance Spot\n⚠️ Informational report, not financial advice.`;
  return m;
}

function buildDailyMessage(ch, items) {
  const dir = marketDirection(items);
  const mv = topMovers(items);
  let m =
    `📅 <b>${escapeHtml(ch.title)}</b>\n<b>DAILY MARKET SUMMARY · 24H</b>\n${SEP}\n\n` +
    `${dir.emoji} <b>${dir.label}</b>\n`;
  if (dir.average !== undefined) m += `Average selected-coin movement: ${signed(dir.average, "%")}\n`;
  m += `\n${SEP}\n🏆 <b>BEST OF THE DAY</b>\n${moversBlock(mv.gainers, "No data available.")}` +
    `\n\n📉 <b>WORST OF THE DAY</b>\n${moversBlock(mv.losers, "No data available.")}\n`;
  const btc = items.find(x => x.symbol === "BTCUSDT");
  if (btc && btc.available) m += `\n${SEP}\n<b>BITCOIN</b>\nPrice: $${fmt(btc.close)} (${signed(btc.percent, "%")})\n`;
  m += `\n${SEP}\n🕒 ${timeLabel(ch.tzOffset)}\n📡 Source: Binance Spot\n⚠️ Informational report, not financial advice.`;
  return m;
}

function buildAlertMessage(ch, list, windowLabel) {
  const lines = list.map(x =>
    `${x.percent > 0 ? "🚀" : "🔻"} <b>${escapeHtml(coinName(x.symbol))}</b>: ${signed(x.percent, "%")} · $${fmt(x.close)}`
  ).join("\n");
  return `🚨 <b>${escapeHtml(ch.title)}</b>\n<b>BIG MOVE ALERT · ${windowLabel.toUpperCase()}</b>\n${SEP}\n\n${lines}\n\n${SEP}\n🕒 ${timeLabel(ch.tzOffset)}\n📡 Source: Binance Spot`;
}

// ---------- Telegram ----------

async function telegramCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_SECRETS_MISSING");
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    let response, result;
    try {
      response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
      });
      result = await response.json();
    } catch (error) {
      lastError = error;
      await sleep(attempt * 1000);
      continue;
    }

    if (response.ok && result.ok) return result.result;

    lastError = new Error(`TELEGRAM_HTTP_${response.status}: ${result.description || "Telegram error"}`);
    if (response.status !== 429 && response.status < 500) throw lastError; // أخطاء دائمة
    await sleep(Math.min((result.parameters?.retry_after || attempt) * 1000, 20000));
  }
  throw lastError;
}

function chatOf(env, ch) {
  const id = ch.chatId || env.TELEGRAM_CHAT_ID;
  if (!id) throw new Error("CHAT_ID_MISSING");
  return id;
}

async function sendPost(env, ch, text) {
  const payload = {
    chat_id: chatOf(env, ch),
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  if (ch.channelUrl) {
    payload.reply_markup = {
      inline_keyboard: [[{ text: ch.buttonText || `📢 JOIN ${ch.title}`, url: ch.channelUrl }]]
    };
  }
  return telegramCall(env, "sendMessage", payload);
}

// ---------- Publish jobs ----------

async function publishPrices(env, ch, ctx) {
  const tickers = await getTickers(ctx, ch.symbols);
  const messages = buildPriceMessages(ch, tickers);
  let result;
  for (let i = 0; i < messages.length; i++) {
    if (i) await sleep(1100);
    result = await sendPost(env, ch, messages[i]);
  }
  return { ok: true, type: "PRICE_UPDATE", message_id: result.message_id, parts: messages.length };
}

async function publishHourly(env, ch, ctx) {
  const items = await getWindowData(ctx, ch.symbols, "1h");
  if (!items.some(x => x.available)) throw new Error("NO_HOURLY_DATA");
  const r = await sendPost(env, ch, buildHourlyMessage(ch, items));
  return { ok: true, type: "HOURLY_ANALYSIS", message_id: r.message_id };
}

async function publishFourHour(env, ch, ctx) {
  const items = await getWindowData(ctx, ch.symbols, "4h");
  if (!items.some(x => x.available)) throw new Error("NO_4H_DATA");
  const r = await sendPost(env, ch, buildFourHourMessage(ch, items));
  return { ok: true, type: "FOUR_HOUR_REPORT", message_id: r.message_id };
}

async function publishDaily(env, ch, ctx) {
  const items = await getDailyData(ctx, ch.symbols);
  if (!items.some(x => x.available)) throw new Error("NO_DAILY_DATA");
  const r = await sendPost(env, ch, buildDailyMessage(ch, items));
  return { ok: true, type: "DAILY_SUMMARY", message_id: r.message_id };
}

async function publishAlerts(env, ch, ctx) {
  const a = ch.alerts;
  const items = (await getWindowData(ctx, ch.symbols, a.window))
    .filter(x => x.available && Math.abs(x.percent) >= a.threshold);
  const now = Date.now();
  const fresh = items
    .filter(x => now - (ctx.state.cooldown[`${ch.id}:${x.symbol}`] || 0) >= a.cooldown * MIN)
    .sort((x, y) => Math.abs(y.percent) - Math.abs(x.percent))
    .slice(0, 15);

  if (!fresh.length) return { ok: true, type: "ALERT", skipped: true };

  const r = await sendPost(env, ch, buildAlertMessage(ch, fresh, a.window));
  for (const x of fresh) ctx.state.cooldown[`${ch.id}:${x.symbol}`] = now;
  ctx.dirty = true;
  return { ok: true, type: "ALERT", message_id: r.message_id };
}

// ---------- Scheduler ----------
// مشاكل النسخة القديمة: الحالة كانت في ذاكرة الـ isolate فقط، فأي دقيقة تفوت أو تفشل تضيع للأبد.
// هنا: آخر موعد ناجح محفوظ في KV (كتابة واحدة فقط عند النشر) + تعويض الفائت + نشر القنوات بدون تزاحم.

const JOB_ORDER = ["four_hour", "daily", "hourly", "price", "alerts"];

function jobsFor(env, ch) {
  const jobs = [];
  if (ch.fourHour.enabled) jobs.push({ key: "four_hour", ms: 240 * MIN, grace: 30 * MIN, persist: true, run: (c) => publishFourHour(env, ch, c) });
  if (ch.daily.enabled) {
    const utcHour = (((ch.daily.hour - ch.tzOffset) % 24) + 24) % 24;
    jobs.push({ key: "daily", ms: 1440 * MIN, offset: utcHour * 60 * MIN, grace: 60 * MIN, persist: true, run: (c) => publishDaily(env, ch, c) });
  }
  if (ch.hourly.enabled) jobs.push({ key: "hourly", ms: 60 * MIN, grace: 15 * MIN, persist: true, run: (c) => publishHourly(env, ch, c) });
  if (ch.price.enabled) jobs.push({ key: "price", ms: ch.price.every * MIN, grace: 10 * MIN, persist: ch.price.every >= 5, run: (c) => publishPrices(env, ch, c) });
  if (ch.alerts.enabled) jobs.push({ key: "alerts", ms: 5 * MIN, grace: 5 * MIN, persist: false, run: (c) => publishAlerts(env, ch, c) });
  return jobs.sort((a, b) => JOB_ORDER.indexOf(a.key) - JOB_ORDER.indexOf(b.key));
}

const slotOf = (now, ms, offset = 0) => Math.floor((now - offset) / ms) * ms + offset;

function isJobDue(job, seen, slotStart, now) {
  const late = now - slotStart;
  if (!seen) return late < MIN;                 // أول مرة: ننشر فقط في دقيقة الموعد نفسها
  if (slotStart <= seen) return false;          // هذا الموعد نُشر سابقاً
  if (job.persist) {
    // الدقيقة الأولى طبيعية. وبعدها ننتظر دقيقتين قبل التعويض حتى لا نكرر بسبب تأخر انتشار KV
    return late < MIN || (late >= 2 * MIN && late <= job.grace);
  }
  return late <= job.grace;
}

async function runWithRetry(env, fn) {
  const delay = Number(env.RETRY_DELAY_MS ?? 2000);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await fn(); }
    catch (error) {
      lastError = error;
      console.error(`JOB_ATTEMPT_${attempt}_FAILED:`, error.message);
      // أخطاء الإعدادات الدائمة لا فائدة من تكرارها
      if (/^(TELEGRAM_HTTP_4(?!29)|CHAT_ID_MISSING|TELEGRAM_SECRETS_MISSING|NO_VALID_SYMBOLS)/.test(error.message)) break;
      if (attempt < 3) await sleep(delay * attempt);
    }
  }
  throw lastError;
}

async function runDue(env, now = Date.now()) {
  const channels = (await getChannels(env)).filter(c => c.enabled);
  const state = await loadState(env);
  const ctx = { cache: new Map(), state, dirty: false };
  const results = [];

  const perChannel = channels.map(async ch => {
    const due = [];
    for (const job of jobsFor(env, ch)) {
      const key = `${ch.id}:${job.key}`;
      const seen = Math.max(state.slots[key] || 0, memory.slots[key] || 0);
      const slotStart = slotOf(now, job.ms, job.offset || 0);
      if (isJobDue(job, seen, slotStart, now)) due.push({ job, key, slotStart });
    }

    for (let i = 0; i < due.length; i++) {
      const { job, key, slotStart } = due[i];
      if (i) await sleep(1100); // تيليغرام: ~منشور واحد بالثانية لكل قناة
      try {
        const r = await runWithRetry(env, () => job.run(ctx));
        memory.slots[key] = slotStart;
        if (job.persist) { state.slots[key] = slotStart; ctx.dirty = true; }
        if (r.message_id && (job.persist || job.key === "alerts")) {
          state.last[key] = { message_id: r.message_id, at: new Date().toISOString() };
          ctx.dirty = true;
        }
        if (r.message_id) memory.last[key] = { message_id: r.message_id, at: new Date().toISOString() };
        if (state.errors[ch.id]?.job === job.key) { delete state.errors[ch.id]; ctx.dirty = true; }
        results.push({ channel: ch.id, job: job.key, ...r });
      } catch (error) {
        const prev = state.errors[ch.id];
        if (!prev || prev.message !== error.message || prev.job !== job.key) {
          state.errors[ch.id] = { job: job.key, message: error.message, at: new Date().toISOString() };
          ctx.dirty = true;
        }
        results.push({ channel: ch.id, job: job.key, ok: false, error: error.message });
      }
    }
  });

  await Promise.allSettled(perChannel);
  if (ctx.dirty) await saveState(env, state, channels);
  return results;
}

async function publishNow(env, ch, jobName) {
  const map = {
    price: publishPrices, hourly: publishHourly,
    four_hour: publishFourHour, daily: publishDaily, alerts: publishAlerts
  };
  const fn = map[jobName];
  if (!fn) throw new Error("INVALID_JOB");
  const state = await loadState(env);
  const r = await fn(env, ch, { cache: new Map(), state, dirty: false });
  if (r.message_id) {
    state.last[`${ch.id}:${jobName}`] = { message_id: r.message_id, at: new Date().toISOString() };
    memory.last[`${ch.id}:${jobName}`] = state.last[`${ch.id}:${jobName}`];
    await saveState(env, state, await getChannels(env));
  }
  return r;
}

// ---------- Telegram connection test ----------

async function testChannel(env, ch) {
  const chat_id = chatOf(env, ch);
  const me = await telegramCall(env, "getMe", {});
  const chat = await telegramCall(env, "getChat", { chat_id });
  const member = await telegramCall(env, "getChatMember", { chat_id, user_id: me.id });
  const isAdmin = member.status === "administrator" || member.status === "creator";
  return {
    ok: true,
    bot: me.username,
    chat_title: chat.title || chat.username || String(chat.id),
    chat_id: chat.id,
    status: member.status,
    can_post: isAdmin && member.can_post_messages !== false
  };
}

// ---------- HTTP ----------

function publicState(state) {
  return { last: state.last || {}, errors: state.errors || {} };
}

function legacyState(state) {
  const l = k => state.last[`${MAIN_ID}:${k}`] || memory.last[`${MAIN_ID}:${k}`] || null;
  const err = state.errors[MAIN_ID];
  return { price: l("price"), hourly: l("hourly"), four_hour: l("four_hour"), last_error: err || null };
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (!path.startsWith("/api/")) {
    return json({ ok: true, service: "KRYPTON MARKETS", version: 2, message: "Worker is running" });
  }

  if (!isAuthorized(request, env)) {
    return json({ ok: false, error_type: "UNAUTHORIZED", error: "Check ADMIN_KEY" }, 401);
  }

  // ----- القنوات -----
  const m = path.match(/^\/api\/channels(?:\/([A-Za-z0-9_-]+))?(?:\/(publish|test))?$/);
  if (m) {
    const [, id, action] = m;
    const channels = await getChannels(env);

    if (!id && request.method === "GET") {
      return json({ ok: true, channels, state: publicState(await loadState(env)) });
    }

    if (!id && request.method === "POST") {
      if (channels.length >= MAX_CHANNELS) throw new Error("TOO_MANY_CHANNELS");
      const body = await request.json();
      if (!String(body.chatId || "").trim()) throw new Error("CHAT_ID_REQUIRED");
      const ch = normalizeChannel({ ...body, id: newId() }, { ...DEFAULT_CHANNEL, id: undefined, channelUrl: "" });
      channels.push(ch);
      await saveChannels(env, channels);
      return json({ ok: true, channel: ch });
    }

    if (id && !action && request.method === "PUT") {
      const old = findChannel(channels, id);
      const ch = normalizeChannel(await request.json(), old);
      if (id !== MAIN_ID && !ch.chatId) throw new Error("CHAT_ID_REQUIRED");
      channels[channels.findIndex(c => c.id === id)] = ch;
      await saveChannels(env, channels);
      return json({ ok: true, channel: ch });
    }

    if (id && !action && request.method === "DELETE") {
      findChannel(channels, id);
      if (channels.length === 1) throw new Error("CANNOT_DELETE_LAST");
      const rest = channels.filter(c => c.id !== id);
      await saveChannels(env, rest);
      await saveState(env, await loadState(env), rest);
      return json({ ok: true });
    }

    if (id && action === "publish" && request.method === "POST") {
      const ch = findChannel(channels, id);
      const body = await request.json().catch(() => ({}));
      const r = await publishNow(env, ch, body.job || "price");
      return json({ ...r, updated_at: timeLabel(ch.tzOffset) });
    }

    if (id && action === "test" && request.method === "POST") {
      return json(await testChannel(env, findChannel(channels, id)));
    }

    return json({ ok: false, error_type: "NOT_FOUND" }, 404);
  }

  // ----- توافق مع اللوحة القديمة (تعمل على القناة الرئيسية) -----
  if (path === "/api/config" && request.method === "GET") {
    const channels = await getChannels(env);
    const main = channels.find(c => c.id === MAIN_ID) || channels[0];
    return json({
      ok: true,
      config: { ...main, priceEveryMinutes: main.price.every },
      state: legacyState(await loadState(env))
    });
  }

  if (path === "/api/config" && request.method === "POST") {
    const body = await request.json();
    const channels = await getChannels(env);
    const idx = Math.max(0, channels.findIndex(c => c.id === MAIN_ID));
    const patch = { ...body };
    if (body.priceEveryMinutes !== undefined) patch.price = { every: body.priceEveryMinutes };
    channels[idx] = normalizeChannel(patch, channels[idx]);
    await saveChannels(env, channels);
    return json({ ok: true, config: channels[idx] });
  }

  const legacyJobs = { "/api/publish": "price", "/api/publish-hourly": "hourly", "/api/publish-4h": "four_hour" };
  if (legacyJobs[path] && request.method === "POST") {
    const channels = await getChannels(env);
    const ch = channels.find(c => c.id === MAIN_ID) || channels[0];
    const r = await publishNow(env, ch, legacyJobs[path]);
    return json({ ...r, count: ch.symbols.length, updated_at: timeLabel(ch.tzOffset) });
  }

  if (path === "/api/tick" && request.method === "POST") {
    return json({ ok: true, ran: await runDue(env) });
  }

  if (path === "/api/status" && request.method === "GET") {
    return json({ ok: true, state: publicState(await loadState(env)) });
  }

  return json({ ok: false, error_type: "NOT_FOUND" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return cors(await handleRequest(request, env));
    } catch (error) {
      console.error("WORKER_ERROR:", { message: error.message, stack: error.stack || null });
      return cors(json({ ok: false, error_type: error.message || "WORKER_ERROR", error: error.message || "Unknown error" }, 500));
    }
  },

  async scheduled(controller, env, ctx) {
    console.log("KRYPTON_MARKETS_TICK:", controller.cron, controller.scheduledTime);
    ctx.waitUntil(
      runDue(env, controller.scheduledTime || Date.now()).catch(error => {
        console.error("TICK_FAILED:", error.message);
      })
    );
  }
};

export { runDue, isJobDue, slotOf, normalizeChannel, getChannels };
