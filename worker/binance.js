export const ENDPOINTS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api-gcp.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com"
];

class BadRequestError extends Error {
  constructor(msg) { super(msg); this.code = "BAD_REQUEST"; }
}

export async function binanceGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const errors = [];

  for (const base of ENDPOINTS) {
    try {
      const response = await fetch(`${base}${path}${qs ? "?" + qs : ""}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
        cf: { cacheTtl: 0, cacheEverything: false }
      });

      const body = await response.text();

      if (response.status === 400) throw new BadRequestError(body.slice(0, 200));
      if (!response.ok) { errors.push(`${base}: HTTP ${response.status}`); continue; }

      return JSON.parse(body);
    } catch (error) {
      if (error instanceof BadRequestError) throw error;
      errors.push(`${base}: ${error.message}`);
    }
  }

  console.error("BINANCE_ERRORS:", JSON.stringify(errors));
  throw new Error("BINANCE_ALL_ENDPOINTS_FAILED");
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
