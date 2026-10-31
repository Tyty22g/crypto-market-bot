export const DEFAULT_ENDPOINTS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api-gcp.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com"
];

// إعدادات التشغيل (تأتي من اللوحة عبر applyBinanceSettings)
const rt = {
  endpoints: DEFAULT_ENDPOINTS,
  timeoutMs: 6000,
  sticky: null,       // آخر رابط نجح: نبدأ به المرة القادمة
  lastOkAt: 0,
  lastOkBase: null,
  lastFailAt: 0,
  lastFail: null
};

export function applyBinanceSettings(settings) {
  const list = (settings?.endpoints || [])
    .filter(e => e && e.enabled !== false && e.url)
    .map(e => String(e.url).replace(/\/+$/, ""));
  rt.endpoints = list.length ? list : DEFAULT_ENDPOINTS;
  rt.timeoutMs = Math.min(30000, Math.max(2000, Number(settings?.timeoutMs) || 6000));
  if (rt.sticky && !rt.endpoints.includes(rt.sticky)) rt.sticky = null;
}

export function binanceState() {
  return {
    lastOkAt: rt.lastOkAt, lastOkBase: rt.lastOkBase,
    lastFailAt: rt.lastFailAt, lastFail: rt.lastFail
  };
}

class BadRequestError extends Error {
  constructor(msg) { super(msg); this.code = "BAD_REQUEST"; }
}

function summarize(errors) {
  const counts = new Map();
  for (const e of errors) counts.set(e.what, (counts.get(e.what) || 0) + 1);
  return [...counts].map(([k, n]) => `${k} ×${n}`).join(", ");
}

export async function binanceGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const errors = [];

  const order = rt.sticky && rt.endpoints.includes(rt.sticky)
    ? [rt.sticky, ...rt.endpoints.filter(b => b !== rt.sticky)]
    : rt.endpoints;

  for (const base of order) {
    try {
      const response = await fetch(`${base}${path}${qs ? "?" + qs : ""}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(rt.timeoutMs),
        cf: { cacheTtl: 0, cacheEverything: false }
      });

      const body = await response.text();

      if (response.status === 400) throw new BadRequestError(body.slice(0, 200));
      if (!response.ok) { errors.push({ base, what: `HTTP ${response.status}` }); continue; }

      const data = JSON.parse(body);
      rt.sticky = base;
      rt.lastOkAt = Date.now();
      rt.lastOkBase = base;
      return data;
    } catch (error) {
      if (error instanceof BadRequestError) throw error;
      errors.push({ base, what: error.name === "TimeoutError" ? "timeout" : String(error.message).slice(0, 40) });
    }
  }

  const summary = summarize(errors);
  console.error("BINANCE_ERRORS:", JSON.stringify(errors));
  rt.lastFailAt = Date.now();
  rt.lastFail = summary;
  throw new Error(`BINANCE_ALL_ENDPOINTS_FAILED (${summary})`);
}

// تشخيص: يجرب كل رابط (حتى المعطل) ويرجع النتيجة
export async function diagnoseEndpoints(urls, timeoutMs = 6000) {
  return Promise.all(urls.map(async base => {
    const t0 = Date.now();
    try {
      const r = await fetch(`${base}/api/v3/ping`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        cf: { cacheTtl: 0, cacheEverything: false }
      });
      await r.text();
      return { url: base, ok: r.ok, status: r.status, ms: Date.now() - t0 };
    } catch (e) {
      return { url: base, ok: false, status: 0, ms: Date.now() - t0,
        error: e.name === "TimeoutError" ? "timeout" : String(e.message).slice(0, 80) };
    }
  }));
}

const valid = { set: null, at: 0 };

async function validSymbols() {
  if (valid.set && Date.now() - valid.at < 3600000) return valid.set;
  const all = await binanceGet("/api/v3/ticker/price");
  valid.set = new Set(all.map(x => x.symbol));
  valid.at = Date.now();
  return valid.set;
}

async function listCall(path, symbols, extra) {
  const params = symbols.length === 1
    ? { symbol: symbols[0], ...extra }
    : { symbols: JSON.stringify(symbols), ...extra };
  const data = await binanceGet(path, params);
  return Array.isArray(data) ? data : [data];
}

// زوج غير صالح لا يوقف الباقي: نتجاهله ونكمل
async function safeList(path, symbols, extra) {
  try {
    return await listCall(path, symbols, extra);
  } catch (error) {
    if (error.code !== "BAD_REQUEST") throw error;
    const known = await validSymbols();
    const usable = symbols.filter(s => known.has(s));
    console.warn("INVALID_SYMBOLS_SKIPPED:", symbols.filter(s => !known.has(s)).join(","));
    if (!usable.length) return [];
    return listCall(path, usable, extra);
  }
}

// طلب مجمّع (100 زوج لكل طلب)
export async function tickerMap(symbols, path, extra = {}) {
  const uniq = [...new Set(symbols)];
  const chunks = [];
  for (let i = 0; i < uniq.length; i += 100) chunks.push(uniq.slice(i, i + 100));
  const lists = await Promise.all(chunks.map(c => safeList(path, c, extra)));
  return new Map(lists.flat().map(t => [t.symbol, t]));
}

export async function priceMap(symbols) {
  const map = await tickerMap(symbols, "/api/v3/ticker/price");
  return new Map([...map].map(([s, t]) => [s, Number(t.price)]));
}

export const DATASETS = {
  "24hr": ["/api/v3/ticker/24hr", {}],
  "1h": ["/api/v3/ticker", { windowSize: "1h" }],
  "4h": ["/api/v3/ticker", { windowSize: "4h" }],
  "1d": ["/api/v3/ticker", { windowSize: "1d" }],
  "7d": ["/api/v3/ticker", { windowSize: "7d" }]
};

export function fetchDataset(type, symbols) {
  const [path, extra] = DATASETS[type];
  return tickerMap(symbols, path, extra);
}

// ---- مؤشرات فنية ----

export async function getCloses(symbol, interval = "4h", limit = 100) {
  const rows = await binanceGet("/api/v3/klines", { symbol, interval, limit });
  const now = Date.now();
  return rows.filter(r => Number(r[6]) < now).map(r => Number(r[4]));
}

export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;

  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }

  let avgG = gain / period, avgL = loss / period;

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
  }

  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

export function sma(closes, n) {
  if (closes.length < n) return null;
  return closes.slice(-n).reduce((a, b) => a + b, 0) / n;
}
