// طبقة المنصات: كل منصة تُحوَّل إلى شكل Binance الموحد (lastPrice, priceChange, ...)
// حتى تبقى الرسائل والتنبيهات كما هي مهما كان المصدر.
import { fetchDataset as binanceDataset } from "./binance.js";

export const PROVIDERS = {
  binance: { label: "Binance Spot", base: null },
  bybit:   { label: "Bybit Spot",   base: "https://api.bybit.com" },
  okx:     { label: "OKX Spot",     base: "https://www.okx.com" },
  kucoin:  { label: "KuCoin Spot",  base: "https://api.kucoin.com" },
  bitget:  { label: "Bitget Spot",  base: "https://api.bitget.com" },
  gateio:  { label: "Gate.io Spot", base: "https://api.gateio.ws" },
  mexc:    { label: "MEXC Spot",    base: "https://api.mexc.com" }
};
export const PROVIDER_IDS = Object.keys(PROVIDERS);

export function defaultProviderSettings() {
  const providers = {};
  for (const id of PROVIDER_IDS) providers[id] = { enabled: true, base: PROVIDERS[id].base };
  return { providers, order: [...PROVIDER_IDS], failover: true };
}

const rt = { ...defaultProviderSettings(), timeoutMs: 6000 };

export function applyProviderSettings(s) {
  const d = defaultProviderSettings();
  rt.providers = { ...d.providers, ...(s?.providers || {}) };
  rt.order = Array.isArray(s?.providerOrder) && s.providerOrder.length ? s.providerOrder : d.order;
  rt.failover = s?.failover !== false;
  rt.timeoutMs = Math.min(30000, Math.max(2000, Number(s?.timeoutMs) || 6000));
}

async function jget(url) {
  const r = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(rt.timeoutMs),
    cf: { cacheTtl: 0, cacheEverything: false }
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  try { return JSON.parse(body); } catch { throw new Error("BAD_JSON"); }
}

function mk(symbol, last, open, high, low, quoteVol) {
  const l = Number(last);
  if (!symbol || !Number.isFinite(l) || l <= 0) return null;
  const o = Number(open);
  const hasOpen = Number.isFinite(o) && o > 0;
  return {
    symbol, lastPrice: String(last), lastPriceRaw: String(last),
    openPrice: hasOpen ? String(open) : null,
    priceChange: hasOpen ? l - o : 0,
    priceChangePercent: hasOpen ? ((l - o) / o) * 100 : 0,
    highPrice: high, lowPrice: low, quoteVolume: quoteVol, count: null
  };
}

const arr = x => (Array.isArray(x) ? x : []);

// كل دالة ترجع قائمة تيكرز بشكل موحد (كل السوق بطلب واحد)
const FETCHERS = {
  async bybit(base) {
    const j = await jget(`${base}/v5/market/tickers?category=spot`);
    if (j.retCode !== undefined && j.retCode !== 0) throw new Error(`API ${j.retCode}`);
    return arr(j.result?.list).map(t => mk(t.symbol, t.lastPrice, t.prevPrice24h, t.highPrice24h, t.lowPrice24h, t.turnover24h));
  },
  async okx(base) {
    const j = await jget(`${base}/api/v5/market/tickers?instType=SPOT`);
    if (j.code !== undefined && String(j.code) !== "0") throw new Error(`API ${j.code}`);
    return arr(j.data).map(t => mk(String(t.instId || "").replace("-", ""), t.last, t.open24h, t.high24h, t.low24h, t.volCcy24h));
  },
  async kucoin(base) {
    const j = await jget(`${base}/api/v1/market/allTickers`);
    return arr(j.data?.ticker).map(t => {
      const last = Number(t.last);
      let open = Number.isFinite(Number(t.changePrice)) && t.changePrice !== null ? last - Number(t.changePrice) : NaN;
      if (!Number.isFinite(open) && t.changeRate != null) open = last / (1 + Number(t.changeRate));
      return mk(String(t.symbol || "").replace("-", ""), t.last, open, t.high, t.low, t.volValue);
    });
  },
  async bitget(base) {
    const j = await jget(`${base}/api/v2/spot/market/tickers`);
    if (j.code !== undefined && String(j.code) !== "00000") throw new Error(`API ${j.code}`);
    return arr(j.data).map(t => {
      const last = Number(t.lastPr);
      const open = Number(t.open) > 0 ? Number(t.open) : last / (1 + Number(t.change24h || 0));
      return mk(t.symbol, t.lastPr, open, t.high24h, t.low24h, t.usdtVolume ?? t.quoteVolume);
    });
  },
  async gateio(base) {
    const j = await jget(`${base}/api/v4/spot/tickers`);
    return arr(j).map(t => {
      const last = Number(t.last);
      const open = last / (1 + Number(t.change_percentage || 0) / 100);
      return mk(String(t.currency_pair || "").replace("_", ""), t.last, open, t.high_24h, t.low_24h, t.quote_volume);
    });
  },
  async mexc(base) {
    const j = await jget(`${base}/api/v3/ticker/24hr`);
    return arr(j).map(t => mk(t.symbol, t.lastPrice, t.openPrice, t.highPrice, t.lowPrice, t.quoteVolume));
  }
};

async function oneProvider(id, symbols) {
  if (id === "binance") {
    const map = await binanceDataset("24hr", symbols);
    if (!map.size) throw new Error("NO_MATCHING_SYMBOLS");
    return map;
  }
  const base = String(rt.providers[id]?.base || PROVIDERS[id].base).replace(/\/+$/, "");
  const want = new Set(symbols);
  const list = await FETCHERS[id](base);
  const map = new Map();
  for (const t of list) if (t && want.has(t.symbol)) map.set(t.symbol, t);
  if (!map.size) throw new Error(list.length ? "NO_MATCHING_SYMBOLS" : "EMPTY_RESPONSE");
  return map;
}

function orderFor(prefer) {
  const enabled = rt.order.filter(id => PROVIDERS[id] && rt.providers[id]?.enabled !== false);
  const first = prefer && prefer !== "auto" && PROVIDERS[prefer] ? prefer : null;
  const list = first ? [first, ...enabled.filter(id => id !== first)] : enabled;
  return rt.failover ? list : list.slice(0, 1);
}

// يجرب المنصات بالترتيب ويكمّل الرموز الناقصة من المنصة التالية
export async function getTickers24(symbols, prefer = "auto") {
  const result = new Map();
  const failed = [];
  const used = [];

  for (const id of orderFor(prefer)) {
    const missing = symbols.filter(s => !result.has(s));
    if (!missing.length) break;
    try {
      const map = await oneProvider(id, missing);
      for (const [s, t] of map) result.set(s, t);
      used.push(id);
    } catch (e) {
      failed.push({ id, error: String(e.message).slice(0, 80), soft: e.message === "NO_MATCHING_SYMBOLS" });
    }
  }

  if (!result.size) {
    throw new Error(`ALL_PROVIDERS_FAILED (${failed.map(f => `${f.id}: ${f.error}`).join("; ") || "none enabled"})`);
  }
  result.sourceName = used.map(id => PROVIDERS[id].label).join(" + ");
  result.providers = used;
  result.failed = failed;
  return result;
}

export function fetchData(type, symbols, prefer) {
  return type === "24hr" ? getTickers24(symbols, prefer) : binanceDataset(type, symbols);
}

export async function priceMapAny(symbols) {
  const map = await getTickers24([...new Set(symbols)], "auto");
  return new Map([...map].map(([s, t]) => [s, Number(t.lastPrice)]));
}

// اختبار منصة واحدة بدون تبديل تلقائي، ويعرض القراءة الفعلية
export async function testProvider(id) {
  if (!PROVIDERS[id]) throw new Error("منصة غير معروفة");
  const t0 = Date.now();
  try {
    const map = await oneProvider(id, ["BTCUSDT", "ETHUSDT"]);
    return {
      ok: true, ms: Date.now() - t0,
      sample: [...map.values()].map(t => ({
        symbol: t.symbol, price: t.lastPrice,
        pct: Number(t.priceChangePercent).toFixed(2)
      }))
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 120) };
  }
}
