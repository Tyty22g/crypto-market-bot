const DEFAULT_CONFIG = {
  symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"],
  title: "KRYPTON MARKETS",
  channelUrl: "https://t.me/Krypton_coins",
  showHighLow: true,
  showVolume: true
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const BINANCE_ENDPOINTS = [
  "https://api.binance.com",
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
    throw new Error("KV_BINDING_MISSING");
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
    throw new Error("INVALID_SYMBOLS");
  }

  const symbols = [
    ...new Set(
      value.map(x => String(x).trim().toUpperCase()).filter(Boolean)
    )
  ];

  if (!symbols.length || symbols.length > 100) {
    throw new Error("INVALID_SYMBOL_COUNT");
  }

  if (symbols.some(s =>
    !/^[A-Z0-9]{5,20}$/.test(s) || !s.endsWith("USDT")
  )) {
    throw new Error("INVALID_SYMBOL_FORMAT");
  }

  return symbols;
}

// تنسيق الأرقام مع معالجة digits = 0
function fmt(value, digits = 8) {
  const n = Number(value);

  if (!Number.isFinite(n)) return "N/A";

  if (digits <= 0) {
    return Math.round(n).toLocaleString("en-US");
  }

  const safeDigits = Math.max(
    1,
    Math.min(21, Math.floor(digits))
  );

  return n.toLocaleString("en-US", {
    maximumSignificantDigits: safeDigits
  });
}

function signed(value, suffix = "") {
  const n = Number(value);

  if (!Number.isFinite(n)) return "N/A";

  return `${n > 0 ? "+" : ""}${fmt(n)}${suffix}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function utcTime() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date()) + " UTC";
}

function channelButton(config) {
  return {
    inline_keyboard: [[
      {
        text: "📢 JOIN KRYPTON MARKETS",
        url: config.channelUrl || DEFAULT_CONFIG.channelUrl
      }
    ]]
  };
}

// Binance Spot 24-hour ticker
async function getBinanceTickers(symbols) {
  const params = symbols.length === 1
    ? `symbol=${encodeURIComponent(symbols[0])}`
    : `symbols=${encodeURIComponent(JSON.stringify(symbols))}`;

  const errors = [];

  for (const base of BINANCE_ENDPOINTS) {
    try {
      const url = `${base}/api/v3/ticker/24hr?${params}`;

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
        errors.push(`${base}: HTTP ${response.status}`);
        continue;
      }

      let data;

      try {
        data = JSON.parse(body);
      } catch {
        errors.push(`${base}: INVALID_JSON`);
        continue;
      }

      if (!Array.isArray(data)) {
        data = [data];
      }

      console.log("BINANCE_CONNECTED:", base);

      return {
        data,
        endpoint: base
      };

    } catch (error) {
      errors.push(`${base}: ${error.message}`);
    }
  }

  console.error("BINANCE_ERRORS:", JSON.stringify(errors));

  throw new Error("BINANCE_ALL_ENDPOINTS_FAILED");
}

// جلب شموع Binance
async function getKlines(symbol, interval, limit) {
  const errors = [];

  for (const base of BINANCE_ENDPOINTS) {
    try {
      const url =
        `${base}/api/v3/klines?symbol=${encodeURIComponent(symbol)}` +
        `&interval=${interval}&limit=${limit}`;

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
        errors.push(`${base}: HTTP ${response.status}`);
        continue;
      }

      const data = JSON.parse(body);

      if (!Array.isArray(data) || !data.length) {
        errors.push(`${base}: INVALID_KLINES`);
        continue;
      }

      return data;

    } catch (error) {
      errors.push(`${base}: ${error.message}`);
    }
  }

  console.error(
    "BINANCE_KLINES_FAILED:",
    symbol,
    JSON.stringify(errors)
  );

  return null;
}

// آخر ساعة مكتملة، دون احتساب الشمعة المفتوحة حالياً
async function getHourlyData(symbols) {
  const results = [];

  for (const symbol of symbols) {
    const candles = await getKlines(symbol, "1h", 2);

    if (!candles || candles.length < 2) {
      results.push({
        symbol,
        available: false
      });
      continue;
    }

    const candle = candles[candles.length - 2];

    const open = Number(candle[1]);
    const close = Number(candle[4]);
    const change = close - open;
    const percent = open ? (change / open) * 100 : 0;

    results.push({
      symbol,
      available: true,
      open,
      close,
      change,
      percent,
      high: Number(candle[2]),
      low: Number(candle[3]),
      volume: Number(candle[5]),
      quoteVolume: Number(candle[7]),
      trades: Number(candle[8])
    });
  }

  return results;
}

// آخر أربع ساعات مكتملة
async function getFourHourData(symbols) {
  const results = [];

  for (const symbol of symbols) {
    const candles = await getKlines(symbol, "1h", 5);

    if (!candles || candles.length < 5) {
      results.push({
        symbol,
        available: false
      });
      continue;
    }

    // استبعاد الشمعة الحالية غير المكتملة
    const completedCandles = candles.slice(0, -1);

    const first = completedCandles[0];
    const last = completedCandles[completedCandles.length - 1];

    const open = Number(first[1]);
    const close = Number(last[4]);
    const change = close - open;
    const percent = open ? (change / open) * 100 : 0;

    results.push({
      symbol,
      available: true,
      open,
      close,
      change,
      percent
    });
  }

  return results;
}

function marketDirection(items) {
  const valid = items.filter(x => x.available);

  if (!valid.length) {
    return {
      label: "DATA UNAVAILABLE",
      emoji: "⚪",
      className: "NEUTRAL"
    };
  }

  const average =
    valid.reduce((sum, item) => sum + item.percent, 0) /
    valid.length;

  if (average >= 0.5) {
    return {
      label: "BULLISH MARKET",
      emoji: "🟢",
      className: "BULLISH",
      average
    };
  }

  if (average <= -0.5) {
    return {
      label: "BEARISH MARKET",
      emoji: "🔴",
      className: "BEARISH",
      average
    };
  }

  return {
    label: "SIDEWAYS MARKET",
    emoji: "🟡",
    className: "SIDEWAYS",
    average
  };
}

function topMovers(items, count = 5) {
  const valid = items.filter(x => x.available);

  return {
    gainers: [...valid]
      .sort((a, b) => b.percent - a.percent)
      .slice(0, count),

    losers: [...valid]
      .sort((a, b) => a.percent - b.percent)
      .slice(0, count)
  };
}

function coinName(symbol) {
  return symbol.replace(/USDT$/, "");
}

function priceRows(config, tickers) {
  const bySymbol = new Map(
    tickers.map(t => [t.symbol, t])
  );

  const rows = [];

  for (const symbol of config.symbols) {
    const t = bySymbol.get(symbol);

    if (!t) continue;

    const pct = Number(t.priceChangePercent);
    const change = Number(t.priceChange);

    const emoji =
      pct > 0 ? "🟢 ▲" :
      pct < 0 ? "🔴 ▼" :
      "⚪ ●";

    let row =
      `${emoji} <b>${escapeHtml(coinName(symbol))}/USDT</b>\n`;

    row += `Price: <b>$${fmt(t.lastPrice)}</b>\n`;

    row +=
      `24H Change: ${signed(change, " USDT")} ` +
      `(${signed(pct, "%")})`;

    if (config.showHighLow) {
      row +=
        `\n24H High: $${fmt(t.highPrice)}` +
        ` | Low: $${fmt(t.lowPrice)}`;
    }

    if (config.showVolume) {
      row +=
        `\n24H Volume: $${fmt(t.quoteVolume, 7)}` +
        `\nTrades: ${fmt(t.count, 0)}`;
    }

    rows.push(row);
  }

  return rows;
}

function buildPriceMessage(config, tickers) {
  const rows = priceRows(config, tickers);

  const message =
    `📊 <b>${escapeHtml(config.title)}</b>\n` +
    `<b>LIVE CRYPTO MARKET UPDATE</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    rows.join("\n\n━━━━━━━━━━━━━━━━━━\n\n") +
    `\n\n━━━━━━━━━━━━━━━━━━\n` +
    `🕒 ${utcTime()}\n` +
    `📡 Source: Binance Spot`;

  if (message.length > 3900) {
    throw new Error("TELEGRAM_MESSAGE_TOO_LONG");
  }

  return message;
}

function buildHourlyMessage(config, tickers, hourly) {
  const direction = marketDirection(hourly);
  const movers = topMovers(hourly);

  const tickerMap = new Map(
    tickers.map(t => [t.symbol, t])
  );

  const valid = hourly.filter(x => x.available);

  let message =
    `📊 <b>${escapeHtml(config.title)}</b>\n` +
    `<b>HOURLY MARKET ANALYSIS</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `${direction.emoji} <b>${direction.label}</b>\n`;

  if (direction.average !== undefined) {
    message +=
      `Average selected-coin movement: ` +
      `${signed(direction.average, "%")}\n`;
  }

  message +=
    `Coins analyzed: ${valid.length}/${config.symbols.length}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🏆 <b>TOP GAINERS · 1H</b>\n`;

  if (movers.gainers.length) {
    message += movers.gainers.map(x =>
      `🟢 ${escapeHtml(coinName(x.symbol))}: ${signed(x.percent, "%")}`
    ).join("\n");
  } else {
    message += "No hourly data available.";
  }

  message += `\n\n📉 <b>TOP LOSERS · 1H</b>\n`;

  if (movers.losers.length) {
    message += movers.losers.map(x =>
      `🔴 ${escapeHtml(coinName(x.symbol))}: ${signed(x.percent, "%")}`
    ).join("\n");
  } else {
    message += "No hourly data available.";
  }

  message += `\n\n━━━━━━━━━━━━━━━━━━\n`;
  message += `<b>BITCOIN STATUS</b>\n`;

  const btc = hourly.find(x => x.symbol === "BTCUSDT");
  const btcTicker = tickerMap.get("BTCUSDT");

  if (btc && btc.available) {
    message +=
      `Price: $${fmt(btcTicker?.lastPrice || btc.close)}\n` +
      `1H Change: ${signed(btc.change)} ` +
      `(${signed(btc.percent, "%")})\n`;
  } else {
    message += "Hourly Bitcoin data unavailable.\n";
  }

  message +=
    `\n━━━━━━━━━━━━━━━━━━\n` +
    `🕒 ${utcTime()}\n` +
    `📡 Source: Binance Spot\n` +
    `⚠️ Market data is informational, not financial advice.`;

  if (message.length > 3900) {
    throw new Error("TELEGRAM_MESSAGE_TOO_LONG");
  }

  return message;
}

function buildFourHourMessage(config, fourHour) {
  const direction = marketDirection(fourHour);
  const movers = topMovers(fourHour);

  let message =
    `🌍 <b>${escapeHtml(config.title)}</b>\n` +
    `<b>4-HOUR MARKET TREND REPORT</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `${direction.emoji} <b>${direction.label}</b>\n`;

  if (direction.average !== undefined) {
    message +=
      `Average selected-coin movement: ` +
      `${signed(direction.average, "%")}\n`;
  }

  message +=
    `Coins analyzed: ${fourHour.filter(x => x.available).length}` +
    `/${config.symbols.length}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🚀 <b>TOP PERFORMERS · 4H</b>\n`;

  if (movers.gainers.length) {
    message += movers.gainers.map(x =>
      `🟢 ${escapeHtml(coinName(x.symbol))}: ${signed(x.percent, "%")}`
    ).join("\n");
  } else {
    message += "No data available.";
  }

  message += `\n\n📉 <b>WEAKEST PERFORMERS · 4H</b>\n`;

  if (movers.losers.length) {
    message += movers.losers.map(x =>
      `🔴 ${escapeHtml(coinName(x.symbol))}: ${signed(x.percent, "%")}`
    ).join("\n");
  } else {
    message += "No data available.";
  }

  message +=
    `\n\n━━━━━━━━━━━━━━━━━━\n` +
    `🕒 ${utcTime()}\n` +
    `📡 Source: Binance Spot\n` +
    `⚠️ Informational report, not financial advice.`;

  if (message.length > 3900) {
    throw new Error("TELEGRAM_MESSAGE_TOO_LONG");
  }

  return message;
}

async function telegramCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_SECRETS_MISSING");
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
      `TELEGRAM_HTTP_${response.status}: ` +
      `${result.description || "Telegram error"}`
    );
  }

  return result.result;
}

async function sendPost(env, config, text) {
  const result = await telegramCall(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: channelButton(config)
  });

  console.log("TELEGRAM_NEW_POST:", result.message_id);

  return result;
}

async function saveState(env, key, result) {
  // نحفظ حالة النشر فقط، وليس أسعار العملات.
  await env.CONFIG.put(
    key,
    JSON.stringify({
      message_id: result.message_id,
      chat_id: env.TELEGRAM_CHAT_ID,
      published_at: new Date().toISOString()
    })
  );
}

async function publishPrices(env) {
  const config = await getConfig(env);
  const market = await getBinanceTickers(config.symbols);

  const message = buildPriceMessage(config, market.data);
  const result = await sendPost(env, config, message);

  await saveState(env, "bot_state_price", result);

  return {
    ok: true,
    type: "PRICE_UPDATE",
    message_id: result.message_id,
    endpoint: market.endpoint
  };
}

async function publishHourly(env) {
  const config = await getConfig(env);

  const market = await getBinanceTickers(config.symbols);
  const hourly = await getHourlyData(config.symbols);

  const message = buildHourlyMessage(
    config,
    market.data,
    hourly
  );

  const result = await sendPost(env, config, message);

  await saveState(env, "bot_state_hourly", result);

  return {
    ok: true,
    type: "HOURLY_ANALYSIS",
    message_id: result.message_id
  };
}

async function publishFourHour(env) {
  const config = await getConfig(env);
  const fourHour = await getFourHourData(config.symbols);

  const message = buildFourHourMessage(config, fourHour);
  const result = await sendPost(env, config, message);

  await saveState(env, "bot_state_4h", result);

  return {
    ok: true,
    type: "FOUR_HOUR_REPORT",
    message_id: result.message_id
  };
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (!url.pathname.startsWith("/api/")) {
    return json({
      ok: true,
      service: "KRYPTON MARKETS",
      message: "Worker is running"
    });
  }

  if (!isAuthorized(request, env)) {
    return json({
      ok: false,
      error_type: "UNAUTHORIZED",
      error: "Check ADMIN_KEY"
    }, 401);
  }

  if (url.pathname === "/api/config" && request.method === "GET") {
    const config = await getConfig(env);

    const state = {
      price: await env.CONFIG.get("bot_state_price", "json"),
      hourly: await env.CONFIG.get("bot_state_hourly", "json"),
      four_hour: await env.CONFIG.get("bot_state_4h", "json")
    };

    return json({
      ok: true,
      config,
      state
    });
  }

  if (url.pathname === "/api/config" && request.method === "POST") {
    const body = await request.json();

    const config = {
      symbols: cleanSymbols(body.symbols),
      title: String(
        body.title || DEFAULT_CONFIG.title
      ).slice(0, 50),

      channelUrl: String(
        body.channelUrl || DEFAULT_CONFIG.channelUrl
      ),

      showHighLow: body.showHighLow !== false,
      showVolume: body.showVolume !== false
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

  if (url.pathname === "/api/publish" && request.method === "POST") {
    return json(await publishPrices(env));
  }

  if (
    url.pathname === "/api/publish-hourly" &&
    request.method === "POST"
  ) {
    return json(await publishHourly(env));
  }

  if (
    url.pathname === "/api/publish-4h" &&
    request.method === "POST"
  ) {
    return json(await publishFourHour(env));
  }

  if (url.pathname === "/api/status" && request.method === "GET") {
    return json({
      ok: true,
      state: {
        price: await env.CONFIG.get("bot_state_price", "json"),
        hourly: await env.CONFIG.get("bot_state_hourly", "json"),
        four_hour: await env.CONFIG.get("bot_state_4h", "json")
      }
    });
  }

  return json({
    ok: false,
    error_type: "NOT_FOUND"
  }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return cors(await handleRequest(request, env));
    } catch (error) {
      console.error("WORKER_ERROR:", {
        message: error.message,
        stack: error.stack || null
      });

      return cors(json({
        ok: false,
        error_type: error.message || "WORKER_ERROR",
        error: error.message || "Unknown error"
      }, 500));
    }
  },

  
async scheduled(controller, env, ctx) {
  const cron = controller.cron;

  console.log("KRYPTON_MARKETS_CRON:", cron);

  // الأسعار كل 5 دقائق
  if (cron === "*/5 * * * *") {
    ctx.waitUntil(
      publishPrices(env).catch(error => {
        console.error("PRICE_PUBLISH_FAILED:", error.message);
      })
    );
    return;
  }

  // تحليل السوق كل ساعة
  if (cron === "0 * * * *") {
    ctx.waitUntil(
      publishHourly(env).catch(error => {
        console.error("HOURLY_PUBLISH_FAILED:", error.message);
      })
    );
    return;
  }

  // تقرير السوق كل 4 ساعات
  if (cron === "0 */4 * * *") {
    ctx.waitUntil(
      publishFourHour(env).catch(error => {
        console.error("FOUR_HOUR_PUBLISH_FAILED:", error.message);
      })
    );
    return;
  }

  console.log("UNKNOWN_CRON_SCHEDULE:", cron);
}
      );
    }
  }
};
