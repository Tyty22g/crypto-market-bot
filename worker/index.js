
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
      "KV_BINDING_MISSING: لم يتم ربط KV بالاسم CONFIG داخل إعدادات Worker"
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
    throw new Error("INVALID_SYMBOLS: قائمة العملات غير صحيحة");
  }

  const symbols = [
    ...new Set(
      value.map(x => String(x).trim().toUpperCase()).filter(Boolean)
    )
  ];

  if (!symbols.length) {
    throw new Error("EMPTY_SYMBOLS: أضف عملة واحدة على الأقل");
  }

  if (symbols.some(s =>
    !/^[A-Z0-9]{5,20}$/.test(s) || !s.endsWith("USDT")
  )) {
    throw new Error(
      "INVALID_SYMBOL_FORMAT: استخدم أزواج Binance Spot مقابل USDT مثل BTCUSDT"
    );
  }

  if (symbols.length > 100) {
    throw new Error("TOO_MANY_SYMBOLS: الحد الأقصى 100 زوج");
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

function baghdadTime() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Binance Spot public market data
async function getBinanceTickers(symbols) {
  const params = symbols.length === 1
    ? `symbol=${encodeURIComponent(symbols[0])}`
    : `symbols=${encodeURIComponent(JSON.stringify(symbols))}`;

  const endpoints = [
    "https://api1.binance.com",
    "https://api-gcp.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com",
    "https://api4.binance.com",
    "https://data-api.binance.vision"
  ];

  const errors = [];

  for (const base of endpoints) {
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
        errors.push({
          endpoint: base,
          type: `BINANCE_HTTP_${response.status}`,
          details: body.slice(0, 300)
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

      return {
        data,
        endpoint: base
      };

    } catch (error) {
      errors.push({
        endpoint: base,
        type: "BINANCE_NETWORK_ERROR",
        details: error.message
      });
    }
  }

  const has403 = errors.some(e => e.type === "BINANCE_HTTP_403");

  const error = new Error(
    "BINANCE_ALL_ENDPOINTS_FAILED"
  );

  error.code = has403
    ? "BINANCE_HTTP_403"
    : "BINANCE_CONNECTION_FAILED";

  error.details = errors;

  throw error;
}

function buildMessage(config, tickers) {
  const bySymbol = new Map(
    tickers.map(t => [t.symbol, t])
  );

  const rows = [];

  for (const symbol of config.symbols) {
    const t = bySymbol.get(symbol);

    if (!t) {
      rows.push(
        `⚪ <b>${escapeHtml(symbol)}</b> — لا توجد بيانات حالياً`
      );
      continue;
    }

    const change = Number(t.priceChange);
    const pct = Number(t.priceChangePercent);

    const up = pct > 0;
    const down = pct < 0;

    const arrow = up ? "🟢 ▲" : down ? "🔴 ▼" : "⚪ ●";
    const sign = change > 0 ? "+" : "";

    let line =
      `${arrow} <b>${escapeHtml(symbol.replace(/USDT$/, ""))}/USDT</b>\n`;

    line += `السعر: <b>$${fmtPrice(t.lastPrice)}</b>\n`;

    line +=
      `التغير 24س: ${sign}${fmtPrice(t.priceChange)} USDT (${sign}${fmtPrice(pct)}%)`;

    if (config.showHighLow) {
      line +=
        `\nالأعلى: $${fmtPrice(t.highPrice)} | الأدنى: $${fmtPrice(t.lowPrice)}`;
    }

    if (config.showVolume) {
      line +=
        `\nحجم التداول: $${fmtMoney(t.quoteVolume)}`;
    }

    rows.push(line);
  }

  const header =
    `🟡 <b>${escapeHtml(config.title || "CRYPTO MARKET")}</b>\n` +
    `<b>Binance Spot · USDT</b>\n` +
    `━━━━━━━━━━━━━━━━━━`;

  const footer =
    `━━━━━━━━━━━━━━━━━━\n` +
    `🕒 آخر تحديث: ${baghdadTime()} (بغداد)\n` +
    `📊 المصدر: Binance Public Market Data`;

  const message =
    `${header}\n\n${rows.join("\n\n")}\n\n${footer}`;

  if (message.length > 3900) {
    throw new Error(
      "TELEGRAM_MESSAGE_TOO_LONG: قلل عدد العملات أو أوقف بعض التفاصيل"
    );
  }

  return message;
}

async function telegramCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error(
      "TELEGRAM_SECRETS_MISSING: أضف TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID"
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
      `TELEGRAM_HTTP_${response.status}: ${result.description || "فشل طلب تيليجرام"}`
    );
  }

  return result.result;
}

async function publish(env) {
  checkKV(env);

  const config = await getConfig(env);

  const market = await getBinanceTickers(config.symbols);

  const text = buildMessage(config, market.data);

  const state = await env.CONFIG.get("bot_state", "json");

  let result;

  if (state && state.message_id) {
    try {
      result = await telegramCall(env, "editMessageText", {
        chat_id: env.TELEGRAM_CHAT_ID,
        message_id: state.message_id,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      });

    } catch (error) {
      // If the old message cannot be edited, send a new one.
      if (
        !String(error.message).includes("message is not modified")
      ) {
        result = await telegramCall(env, "sendMessage", {
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true
        });
      } else {
        result = {
          message_id: state.message_id
        };
      }
    }

  } else {
    result = await telegramCall(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  }

  await env.CONFIG.put(
    "bot_state",
    JSON.stringify({
      message_id: result.message_id,
      chat_id: env.TELEGRAM_CHAT_ID,
      updated_at: new Date().toISOString()
    })
  );

  return {
    ok: true,
    message_id: result.message_id,
    updated_at: new Date().toISOString(),
    count: config.symbols.length,
    binance_endpoint: market.endpoint
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
      service: "Crypto Market Bot",
      message: "Worker is running"
    });
  }

  if (!isAuthorized(request, env)) {
    return json({
      ok: false,
      error_type: "UNAUTHORIZED",
      error: "تحقق من ADMIN_KEY"
    }, 401);
  }

  if (url.pathname === "/api/config" && request.method === "GET") {
    const config = await getConfig(env);
    const state = await env.CONFIG.get("bot_state", "json");

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

  if (url.pathname === "/api/publish" && request.method === "POST") {
    const result = await publish(env);
    return json(result);
  }

  if (url.pathname === "/api/status" && request.method === "GET") {
    const state = await env.CONFIG.get("bot_state", "json");

    return json({
      ok: true,
      state
    });
  }

  return json({
    ok: false,
    error_type: "NOT_FOUND",
    error: "المسار غير موجود"
  }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return cors(await handleRequest(request, env));

    } catch (error) {
      console.error("Worker error:", error);

      return cors(json({
        ok: false,
        error_type: error.code || "WORKER_ERROR",
        error: error.message || "حدث خطأ غير معروف",
        details: error.details || null
      }, 500));
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      publish(env).catch(error => {
        console.error("Scheduled publish failed:", error);
      })
    );
  }
};
