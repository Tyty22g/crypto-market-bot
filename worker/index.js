
const DEFAULT_CONFIG = {
  symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"],
  showHighLow: true,
  showVolume: true,
  title: "CRYPTO MARKET"
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const BINANCE_ENDPOINTS = [
  "https://api1.binance.com",
  "https://api-gcp.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com",
  "https://data-api.binance.vision"
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS
  });
}

function cors(response) {
  const h = new Headers(response.headers);

  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET, POST, OPTIONS");
  h.set("access-control-allow-headers", "Content-Type, Authorization");

  return new Response(response.body, {
    status: response.status,
    headers: h
  });
}

function isAuthorized(request, env) {
  const supplied = request.headers.get("authorization") || "";

  return Boolean(env.ADMIN_KEY) &&
    supplied === `Bearer ${env.ADMIN_KEY}`;
}

function checkKV(env) {
  if (!env.CONFIG) {
    const error = new Error(
      "KV_BINDING_MISSING: KV binding CONFIG is missing"
    );

    error.code = "KV_BINDING_MISSING";
    throw error;
  }
}

async function getConfig(env) {
  checkKV(env);

  const saved = await env.CONFIG.get("bot_config", "json");

  return {
    ...DEFAULT_CONFIG,
    ...(saved || {})
  };
}

function cleanSymbols(value) {
  if (!Array.isArray(value)) {
    throw new Error("INVALID_SYMBOLS: Invalid coin list");
  }

  const symbols = [
    ...new Set(
      value.map(x => String(x).trim().toUpperCase()).filter(Boolean)
    )
  ];

  if (!symbols.length) {
    throw new Error("EMPTY_SYMBOLS: Add at least one coin");
  }

  if (symbols.some(s =>
    !/^[A-Z0-9]{5,20}$/.test(s) || !s.endsWith("USDT")
  )) {
    throw new Error(
      "INVALID_SYMBOL_FORMAT: Use Binance Spot USDT pairs such as BTCUSDT"
    );
  }

  if (symbols.length > 100) {
    throw new Error("TOO_MANY_SYMBOLS: Maximum 100 pairs");
  }

  return symbols;
}

function fmtPrice(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return String(value);

  return n.toLocaleString("en-US", {
    maximumSignificantDigits: 9
  });
}

function fmtMoney(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return String(value);

  return n.toLocaleString("en-US", {
    maximumSignificantDigits: 7
  });
}

function fmtPercent(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return "N/A";

  const sign = n > 0 ? "+" : "";

  return `${sign}${n.toFixed(2)}%`;
}

function fmtChange(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return "N/A";

  const sign = n > 0 ? "+" : "";

  return sign + fmtPrice(n);
}

function utcTime() {
  return new Date()
    .toISOString()
    .replace("T", " ")
    .slice(0, 19) + " GMT";
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Build query parameters for Binance
function buildTickerParams(symbols, windowSize = null) {
  const params = new URLSearchParams();

  if (symbols.length === 1) {
    params.set("symbol", symbols[0]);
  } else {
    params.set("symbols", JSON.stringify(symbols));
  }

  if (windowSize) {
    params.set("windowSize", windowSize);
  }

  return params.toString();
}

// Fetch Binance data with automatic endpoint fallback
async function fetchBinanceArray(path, params, label) {
  const errors = [];

  for (const base of BINANCE_ENDPOINTS) {
    try {
      const url = `${base}${path}?${params}`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Accept": "application/json"
        },
        cf: {
          cacheTtl: 0,
          cacheEverything: false
        }
      });

      const body = await response.text();

      if (!response.ok) {
        errors.push({
          endpoint: base,
          type: `BINANCE_HTTP_${response.status}`,
          details: body.slice(0, 250)
        });

        continue;
      }

      let data;

      try {
        data = JSON.parse(body);
      } catch {
        errors.push({
          endpoint: base,
          type: "BINANCE_INVALID_JSON",
          details: body.slice(0, 200)
        });

        continue;
      }

      if (!Array.isArray(data)) {
        errors.push({
          endpoint: base,
          type: "BINANCE_INVALID_RESPONSE",
          details: JSON.stringify(data).slice(0, 200)
        });

        continue;
      }

      console.log(`${label}_CONNECTED:`, base);

      return {
        data,
        endpoint: base
      };

    } catch (error) {
      errors.push({
        endpoint: base,
        type: "BINANCE_NETWORK_ERROR",
        details: error.message || String(error)
      });
    }
  }

  console.error(
    `${label}_DIAGNOSTICS:`,
    JSON.stringify(errors)
  );

  const error = new Error(`${label}_ALL_ENDPOINTS_FAILED`);

  error.code = `${label}_ALL_ENDPOINTS_FAILED`;
  error.details = errors;

  throw error;
}

// Fetch both 24-hour and 1-hour market statistics
async function getBinanceTickers(symbols) {
  const params24h = buildTickerParams(symbols);

  const params1h = buildTickerParams(symbols, "1h");

  const result24h = await fetchBinanceArray(
    "/api/v3/ticker/24hr",
    params24h,
    "BINANCE_24H"
  );

  const result1h = await fetchBinanceArray(
    "/api/v3/ticker",
    params1h,
    "BINANCE_1H"
  );

  return {
    data: result24h.data,
    hourlyData: result1h.data,
    endpoint: result24h.endpoint,
    hourlyEndpoint: result1h.endpoint
  };
}

// Build professional English market report
function buildMessage(config, market) {
  const tickers = market.data;
  const hourlyTickers = market.hourlyData;

  const bySymbol = new Map(
    tickers.map(t => [t.symbol, t])
  );

  const hourlyBySymbol = new Map(
    hourlyTickers.map(t => [t.symbol, t])
  );

  const validTickers = config.symbols
    .map(symbol => bySymbol.get(symbol))
    .filter(Boolean);

  const gainers = validTickers.filter(
    t => Number(t.priceChangePercent) > 0
  );

  const losers = validTickers.filter(
    t => Number(t.priceChangePercent) < 0
  );

  const unchanged = validTickers.filter(
    t => Number(t.priceChangePercent) === 0
  );

  const sorted = [...validTickers].sort(
    (a, b) =>
      Number(b.priceChangePercent) -
      Number(a.priceChangePercent)
  );

  const strongest = sorted[0];
  const weakest = sorted[sorted.length - 1];

  const rows = [];

  for (const symbol of config.symbols) {
    const t = bySymbol.get(symbol);
    const h = hourlyBySymbol.get(symbol);

    if (!t) {
      rows.push(
        `⚪ <b>${escapeHtml(symbol)}</b>\n` +
        `Market data unavailable`
      );

      continue;
    }

    const change24 = Number(t.priceChange);
    const pct24 = Number(t.priceChangePercent);

    const change1h = h ? Number(h.priceChange) : NaN;
    const pct1h = h ? Number(h.priceChangePercent) : NaN;

    const arrow24 =
      pct24 > 0 ? "🟢 ▲" :
      pct24 < 0 ? "🔴 ▼" : "⚪ ●";

    const arrow1h =
      pct1h > 0 ? "🟢 ▲" :
      pct1h < 0 ? "🔴 ▼" : "⚪ ●";

    const coinName = symbol.replace(/USDT$/, "");

    let line =
      `${arrow24} <b>${escapeHtml(coinName)}/USDT</b>\n`;

    line +=
      `💰 Price: <b>$${fmtPrice(t.lastPrice)}</b>\n`;

    line +=
      `📈 1H Change: ${arrow1h} ${fmtPercent(pct1h)} ` +
      `(${fmtChange(change1h)} USDT)\n`;

    line +=
      `📊 24H Change: ${arrow24} ${fmtPercent(pct24)} ` +
      `(${fmtChange(change24)} USDT)`;

    if (config.showHighLow) {
      line +=
        `\n🔺 24H High: $${fmtPrice(t.highPrice)}` +
        `\n🔻 24H Low: $${fmtPrice(t.lowPrice)}`;
    }

    if (config.showVolume) {
      line +=
        `\n💵 24H Volume: $${fmtMoney(t.quoteVolume)}`;
    }

    if (Number.isFinite(Number(t.count))) {
      line +=
        `\n🔄 24H Trades: ${Number(t.count).toLocaleString("en-US")}`;
    }

    rows.push(line);
  }

  const summary = [
    `🟢 Gainers: ${gainers.length}`,
    `🔴 Losers: ${losers.length}`,
    `⚪ Unchanged: ${unchanged.length}`
  ].join("  |  ");

  let highlights = "";

  if (strongest && weakest) {
    highlights =
      `\n🏆 Top Performer: ${escapeHtml(strongest.symbol.replace(/USDT$/, ""))} ` +
      `(${fmtPercent(strongest.priceChangePercent)})` +
      `\n📉 Worst Performer: ${escapeHtml(weakest.symbol.replace(/USDT$/, ""))} ` +
      `(${fmtPercent(weakest.priceChangePercent)})`;
  }

  const header =
    `🌐 <b>${escapeHtml(config.title || "CRYPTO MARKET")}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📡 BINANCE SPOT MARKET | USDT\n` +
    `⏱ Market Overview\n` +
    `${summary}` +
    `${highlights}\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  const footer =
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🕒 Last Update: ${utcTime()}\n` +
    `📊 Data Source: Binance Spot\n` +
    `⚠️ Market data only. Not financial advice.`;

  const message =
    `${header}\n\n` +
    `${rows.join("\n\n━━━━━━━━━━━━━━━━━━━━\n\n")}\n\n` +
    `${footer}`;

  if (message.length > 3900) {
    throw new Error(
      "TELEGRAM_MESSAGE_TOO_LONG: Reduce the number of coins or disable extra details"
    );
  }

  return message;
}

async function telegramCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error(
      "TELEGRAM_SECRETS_MISSING: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing"
    );
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      `TELEGRAM_HTTP_${response.status}: ${result.description || "Telegram request failed"}`
    );
  }

  return result.result;
}

// Always publish a NEW message
async function publish(env) {
  checkKV(env);

  const config = await getConfig(env);

  const market = await getBinanceTickers(config.symbols);

  const text = buildMessage(config, market);

  const result = await telegramCall(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });

  await env.CONFIG.put(
    "bot_state",
    JSON.stringify({
      message_id: result.message_id,
      chat_id: env.TELEGRAM_CHAT_ID,
      updated_at: new Date().toISOString()
    })
  );

  console.log(
    "TELEGRAM_NEW_MESSAGE_PUBLISHED:",
    result.message_id
  );

  return {
    ok: true,
    message_id: result.message_id,
    updated_at: new Date().toISOString(),
    count: config.symbols.length,
    binance_endpoint: market.endpoint,
    hourly_endpoint: market.hourlyEndpoint,
    publish_mode: "NEW_MESSAGE"
  };
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204
    });
  }

  if (!url.pathname.startsWith("/api/")) {
    return json({
      ok: true,
      service: "Crypto Market Bot",
      message: "Worker is running",
      publish_mode: "NEW_MESSAGE"
    });
  }

  if (!isAuthorized(request, env)) {
    return json({
      ok: false,
      error_type: "UNAUTHORIZED",
      error: "Check ADMIN_KEY"
    }, 401);
  }

  if (
    url.pathname === "/api/config" &&
    request.method === "GET"
  ) {
    const config = await getConfig(env);
    const state = await env.CONFIG.get("bot_state", "json");

    return json({
      ok: true,
      config,
      state
    });
  }

  if (
    url.pathname === "/api/config" &&
    request.method === "POST"
  ) {
    const body = await request.json();

    const config = {
      symbols: cleanSymbols(body.symbols),
      showHighLow: body.showHighLow !== false,
      showVolume: body.showVolume !== false,
      title: String(body.title || "CRYPTO MARKET").slice(0, 50)
    };

    await env.CONFIG.put(
      "bot_config",
      JSON.stringify(config)
    );

    return json({
      ok: true,
      config
    });
  }

  if (
    url.pathname === "/api/publish" &&
    request.method === "POST"
  ) {
    const result = await publish(env);

    return json(result);
  }

  if (
    url.pathname === "/api/status" &&
    request.method === "GET"
  ) {
    const state = await env.CONFIG.get("bot_state", "json");

    return json({
      ok: true,
      state
    });
  }

  return json({
    ok: false,
    error_type: "NOT_FOUND",
    error: "Route not found"
  }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return cors(await handleRequest(request, env));

    } catch (error) {
      console.error("Worker error:", {
        message: error.message,
        code: error.code || null,
        details: error.details || null,
        stack: error.stack || null
      });

      return cors(json({
        ok: false,
        error_type: error.code || "WORKER_ERROR",
        error: error.message || "Unknown error",
        details: error.details || null
      }, 500));
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      publish(env).catch(error => {
        console.error("Scheduled publish failed:", {
          message: error.message,
          code: error.code || null,
          details: error.details || null,
          stack: error.stack || null
        });
      })
    );
  }
};
