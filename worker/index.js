const DEFAULT_CONFIG = {
  symbols: [
    "BTCUSDT",
    "ETHUSDT",
    "BNBUSDT",
    "SOLUSDT",
    "XRPUSDT"
  ],
  channelUsername: "@Krypton_coins",
  channelUrl: "https://t.me/Krypton_coins",
  title: "KRYPTON MARKETS",
  maxCoins: 20
};

const CONFIG_KEY = "bot_config";
const STATE_KEY = "bot_state";

const BINANCE_HOSTS = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com",
  "https://data-api.binance.vision"
];


// ==========================================
// Cloudflare Worker entry points
// ==========================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    try {
      if (path === "/api/status" && request.method === "GET") {
        return jsonResponse({
          ok: true,
          worker: "KRYPTON MARKETS",
          status: "online",
          time: new Date().toISOString()
        });
      }

      if (path === "/api/config") {
        if (!isAdmin(request, env)) {
          return jsonResponse(
            { ok: false, error: "Unauthorized" },
            401
          );
        }

        if (request.method === "GET") {
          const config = await getConfig(env);

          return jsonResponse({
            ok: true,
            config
          });
        }

        if (request.method === "POST") {
          const body = await request.json();

          // Accept either {config:{...}} or a direct config object.
          const incoming = body.config || body;

          if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
            return jsonResponse({
              ok: false,
              error: "Invalid configuration"
            }, 400);
          }

          const current = await getConfig(env);
          const updated = normalizeConfig({
            ...current,
            ...incoming
          });

          await env.CONFIG.put(
            CONFIG_KEY,
            JSON.stringify(updated)
          );

          return jsonResponse({
            ok: true,
            message: "Configuration saved",
            config: updated
          });
        }

        return jsonResponse({
          ok: false,
          error: "Method not allowed"
        }, 405);
      }

      if (path === "/api/publish" && request.method === "POST") {
        if (!isAdmin(request, env)) {
          return jsonResponse(
            { ok: false, error: "Unauthorized" },
            401
          );
        }

        const result = await publish(env);

        return jsonResponse({
          ok: true,
          message: "Telegram post published",
          result
        });
      }

      return jsonResponse({
        ok: false,
        error: "Not found"
      }, 404);

    } catch (error) {
      console.error("Request failed:", error);

      return jsonResponse({
        ok: false,
        error: error.message || "Internal server error"
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      publish(env).catch(async error => {
        console.error("Scheduled publish failed:", error);

        await saveState(env, {
          lastError: error.message || String(error),
          lastErrorAt: new Date().toISOString()
        });
      })
    );
  }
};


// ==========================================
// Configuration
// ==========================================

async function getConfig(env) {
  const saved = await env.CONFIG.get(CONFIG_KEY);

  if (!saved) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    return normalizeConfig({
      ...DEFAULT_CONFIG,
      ...JSON.parse(saved)
    });
  } catch (error) {
    console.error("Invalid saved config:", error);
    return { ...DEFAULT_CONFIG };
  }
}

function normalizeConfig(config) {
  let symbols = Array.isArray(config.symbols)
    ? config.symbols
    : DEFAULT_CONFIG.symbols;

  symbols = symbols
    .map(symbol => String(symbol).trim().toUpperCase())
    .filter(symbol => /^[A-Z0-9]{4,20}$/.test(symbol));

  if (!symbols.length) {
    symbols = [...DEFAULT_CONFIG.symbols];
  }

  const maxCoins = Number(config.maxCoins);

  return {
    ...DEFAULT_CONFIG,
    ...config,
    symbols: [...new Set(symbols)],
    maxCoins: Number.isFinite(maxCoins)
      ? Math.max(1, Math.min(50, Math.floor(maxCoins)))
      : DEFAULT_CONFIG.maxCoins
  };
}


// ==========================================
// Binance data
// ==========================================

async function binanceRequest(endpoint) {
  let lastError = null;

  for (const host of BINANCE_HOSTS) {
    try {
      const response = await fetch(
        host + endpoint,
        {
          method: "GET",
          headers: {
            "Accept": "application/json"
          }
        }
      );

      if (!response.ok) {
        const message = await response.text();

        throw new Error(
          `Binance ${response.status}: ${message.slice(0, 200)}`
        );
      }

      return await response.json();

    } catch (error) {
      lastError = error;
      console.error(
        "Binance endpoint failed:",
        host,
        error.message
      );
    }
  }

  throw new Error(
    "All Binance endpoints failed: " +
    (lastError?.message || "Unknown error")
  );
}

async function getBinanceTickers(symbols) {
  const [dailyData, hourlyData] = await Promise.all([
    binanceRequest("/api/v3/ticker/24hr"),
    binanceRequest("/api/v3/ticker?windowSize=1h")
  ]);

  if (!Array.isArray(dailyData)) {
    throw new Error("Invalid Binance 24H response");
  }

  if (!Array.isArray(hourlyData)) {
    throw new Error("Invalid Binance 1H response");
  }

  const dailyMap = new Map(
    dailyData.map(item => [item.symbol, item])
  );

  const hourlyMap = new Map(
    hourlyData.map(item => [item.symbol, item])
  );

  const results = [];

  for (const symbol of symbols) {
    const daily = dailyMap.get(symbol);
    const hourly = hourlyMap.get(symbol);

    if (!daily) {
      console.warn("Symbol not found on Binance:", symbol);
      continue;
    }

    const price = Number(daily.lastPrice);
    const change24 = Number(daily.priceChange);
    const change24Percent = Number(daily.priceChangePercent);

    const change1 = hourly
      ? Number(hourly.priceChange)
      : 0;

    const change1Percent = hourly
      ? Number(hourly.priceChangePercent)
      : 0;

    if (!Number.isFinite(price) || price <= 0) {
      continue;
    }

    results.push({
      symbol,
      price,
      change1,
      change1Percent,
      change24,
      change24Percent,
      high24: Number(daily.highPrice),
      low24: Number(daily.lowPrice),
      volume24: Number(daily.quoteVolume),
      trades24: Number(daily.count)
    });
  }

  if (!results.length) {
    throw new Error("No valid coin data received from Binance");
  }

  return results;
}


// ==========================================
// Formatting
// ==========================================

function utcTime() {
  return new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return "N/A";

  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 8 : 4
  }).format(value);
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "N/A";

  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2
  }).format(value);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "N/A";

  const sign = value > 0 ? "+" : "";

  return sign + value.toFixed(2) + "%";
}

function formatChange(value) {
  if (!Number.isFinite(value)) return "N/A";

  const sign = value > 0 ? "+" : "";

  return sign + formatPrice(value);
}

function movementIcon(value) {
  if (value > 0) return "🟢 ▲";
  if (value < 0) return "🔴 ▼";
  return "⚪";
}

function shortSymbol(symbol) {
  return symbol.endsWith("USDT")
    ? symbol.slice(0, -4) + "/USDT"
    : symbol;
}


// ==========================================
// Build Telegram report
// ==========================================

function buildMessage(coins, config) {
  const sorted = [...coins].sort(
    (a, b) => b.change24Percent - a.change24Percent
  );

  const gainers = [...coins]
    .filter(coin => coin.change24Percent > 0)
    .sort((a, b) => b.change24Percent - a.change24Percent)
    .slice(0, 3);

  const losers = [...coins]
    .filter(coin => coin.change24Percent < 0)
    .sort((a, b) => a.change24Percent - b.change24Percent)
    .slice(0, 3);

  const unchanged = coins.filter(
    coin => coin.change24Percent === 0
  ).length;

  const positive = coins.filter(
    coin => coin.change24Percent > 0
  ).length;

  const negative = coins.filter(
    coin => coin.change24Percent < 0
  ).length;

  const averageChange = coins.reduce(
    (sum, coin) => sum + coin.change24Percent,
    0
  ) / coins.length;

  const lines = [];

  lines.push("🌐 <b>KRYPTON MARKETS</b>");
  lines.push("<i>Real-Time Cryptocurrency Market Report</i>");
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push("🕒 <b>Updated:</b> " + utcTime());
  lines.push("📊 <b>Market Overview</b>");
  lines.push(
    "🟢 Gainers: <b>" + positive + "</b>   " +
    "🔴 Losers: <b>" + negative + "</b>   " +
    "⚪ Unchanged: <b>" + unchanged + "</b>"
  );
  lines.push(
    "📈 Average 24H Change: <b>" +
    formatPercent(averageChange) + "</b>"
  );
  lines.push("━━━━━━━━━━━━━━━━━━━━");

  lines.push("<b>💹 COIN MARKET DATA</b>");
  lines.push("");

  for (const coin of sorted.slice(0, config.maxCoins)) {
    const symbol = escapeHtml(shortSymbol(coin.symbol));

    lines.push(
      "<b>" + symbol + "</b>  " +
      movementIcon(coin.change24Percent)
    );

    lines.push(
      "💵 Price: <b>$" +
      formatPrice(coin.price) + "</b>"
    );

    lines.push(
      "⏱ 1H: " +
      formatPercent(coin.change1Percent) +
      "  (" + formatChange(coin.change1) + ")"
    );

    lines.push(
      "📅 24H: " +
      formatPercent(coin.change24Percent) +
      "  (" + formatChange(coin.change24) + ")"
    );

    lines.push(
      "🔺 High: $" + formatPrice(coin.high24) +
      "  |  🔻 Low: $" + formatPrice(coin.low24)
    );

    lines.push(
      "📦 Volume: $" + formatNumber(coin.volume24) +
      "  |  🔄 Trades: " + formatNumber(coin.trades24)
    );

    lines.push("────────────────────");
  }

  lines.push("");
  lines.push("🏆 <b>TOP 3 GAINERS (24H)</b>");

  if (gainers.length) {
    for (const coin of gainers) {
      lines.push(
        "🟢 " + escapeHtml(shortSymbol(coin.symbol)) +
        ": <b>" + formatPercent(coin.change24Percent) + "</b>"
      );
    }
  } else {
    lines.push("No gainers in the selected coins.");
  }

  lines.push("");
  lines.push("📉 <b>TOP 3 LOSERS (24H)</b>");

  if (losers.length) {
    for (const coin of losers) {
      lines.push(
        "🔴 " + escapeHtml(shortSymbol(coin.symbol)) +
        ": <b>" + formatPercent(coin.change24Percent) + "</b>"
      );
    }
  } else {
    lines.push("No losers in the selected coins.");
  }

  lines.push("");
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push("<b>KRYPTON MARKETS</b>");
  lines.push("<i>Stay Ahead • Stay Informed</i>");
  lines.push("");
  lines.push(
    "Follow us for real-time crypto prices, " +
    "market trends and smart alerts."
  );
  lines.push(
    "📢 " + escapeHtml(config.channelUsername)
  );
  lines.push("");
  lines.push("<i>Market data provided by Binance Spot.</i>");
  lines.push(
    "<i>For informational purposes only. Not financial advice.</i>"
  );

  let message = lines.join("\n");

  // Telegram message limit is 4096 characters.
  // Keep a safety margin for Telegram HTML parsing.
  if (message.length > 3900) {
    message = message.slice(0, 3850);
    message += "\n\n<i>Report shortened to fit Telegram.</i>";
  }

  return message;
}


// ==========================================
// Telegram publishing
// ==========================================

async function sendTelegramMessage(env, text, config) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN secret is missing");
  }

  if (!env.TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_CHAT_ID secret is missing");
  }

  const channelUrl = config.channelUrl ||
    "https://t.me/Krypton_coins";

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "📢 JOIN KRYPTON MARKETS",
          url: channelUrl
        }
      ]
    ]
  };

  const telegramUrl =
    "https://api.telegram.org/bot" +
    env.TELEGRAM_BOT_TOKEN +
    "/sendMessage";

  const response = await fetch(telegramUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: keyboard
    })
  });

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      "Telegram API error: " +
      (result.description || response.status)
    );
  }

  return result.result;
}


// ==========================================
// Publish a NEW post every time
// ==========================================

async function publish(env) {
  const config = await getConfig(env);

  console.log(
    "Starting Krypton Markets publication:",
    config.symbols.join(", ")
  );

  const coins = await getBinanceTickers(config.symbols);

  const message = buildMessage(coins, config);

  // Always send a NEW Telegram message.
  // This does not edit the previous post.
  const telegramMessage = await sendTelegramMessage(
    env,
    message,
    config
  );

  const state = {
    lastMessageId: telegramMessage.message_id,
    lastChatId: telegramMessage.chat.id,
    lastPublishedAt: new Date().toISOString(),
    lastCoinCount: coins.length,
    lastError: null,
    lastErrorAt: null
  };

  await saveState(env, state);

  console.log(
    "Krypton Markets published successfully. Message ID:",
    telegramMessage.message_id
  );

  return {
    messageId: telegramMessage.message_id,
    coinsPublished: coins.length,
    publishedAt: state.lastPublishedAt
  };
}


// ==========================================
// State
// ==========================================

async function getState(env) {
  const saved = await env.CONFIG.get(STATE_KEY);

  if (!saved) return {};

  try {
    return JSON.parse(saved);
  } catch {
    return {};
  }
}

async function saveState(env, updates) {
  const current = await getState(env);

  const updated = {
    ...current,
    ...updates
  };

  await env.CONFIG.put(
    STATE_KEY,
    JSON.stringify(updated)
  );

  return updated;
}


// ==========================================
// Admin authentication
// ==========================================

function isAdmin(request, env) {
  if (!env.ADMIN_KEY) return false;

  const headerKey = request.headers.get("x-admin-key");

  const authorization = request.headers.get("Authorization") || "";

  const bearerKey = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  const suppliedKey = headerKey || bearerKey;

  return suppliedKey === env.ADMIN_KEY;
}


// ==========================================
// HTTP helpers
// ==========================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Admin-Key",
    "Content-Type": "application/json; charset=utf-8"
  };
}

function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: corsHeaders()
    }
  );
}