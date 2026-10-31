const DEFAULT_CONFIG = {
  symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"],
  title: "KRYPTON MARKETS",
  channelUrl: "https://t.me/Krypton_coins",
  showHighLow: true,
  showVolume: true,
  priceEveryMinutes: 5
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const BINANCE_ENDPOINTS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api-gcp.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com"
];

const DEFAULT_PRICE_INTERVAL_MIN = 5;

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

// ---------- Binance ----------

class BadRequestError extends Error {
  constructor(msg) { super(msg); this.code = "BAD_REQUEST"; }
}

async function binanceGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const errors = [];

  for (const base of BINANCE_ENDPOINTS) {
    try {
      const response = await fetch(`${base}${path}${qs ? "?" + qs : ""}`, {
        method: "GET",
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(6000),
        cf: { cacheTtl: 0, cacheEverything: false }
      });

      const body = await response.text();

      // 400 = رمز غير صالح؛ كل السيرفرات ستعطي نفس النتيجة، لا فائدة من التجربة
      if (response.status === 400) {
        throw new BadRequestError(body.slice(0, 200));
      }

      if (!response.ok) {
        errors.push(`${base}: HTTP ${response.status}`);
        continue;
      }

      const data = JSON.parse(body);
      console.log("BINANCE_CONNECTED:", base);
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

// طلب واحد لكل الأزواج. إذا كان فيه زوج غير صالح نتجاهله بدل ما يتعطل النشر كله.
async function getTickers(symbols, path = "/api/v3/ticker/24hr", extra = {}) {
  try {
    return await tickerCall(path, symbols, extra);
  } catch (error) {
    if (error.code !== "BAD_REQUEST") throw error;

    const all = await binanceGet("/api/v3/ticker/price");
    const valid = new Set(all.map(x => x.symbol));
    const usable = symbols.filter(s => valid.has(s));

    console.warn(
      "INVALID_SYMBOLS_SKIPPED:",
      symbols.filter(s => !valid.has(s)).join(",")
    );

    if (!usable.length) throw new Error("NO_VALID_SYMBOLS");
    return tickerCall(path, usable, extra);
  }
}

async function getBinanceTickers(symbols) {
  return { data: await getTickers(symbols) };
}

// تغيّر آخر ساعة / آخر 4 ساعات: طلب واحد فقط لكل الأزواج (بدل طلب لكل زوج)
async function getWindowData(symbols, windowSize) {
  const tickers = await getTickers(symbols, "/api/v3/ticker", { windowSize });
  const bySymbol = new Map(tickers.map(t => [t.symbol, t]));

  return symbols.map(symbol => {
    const t = bySymbol.get(symbol);

    if (!t || !Number.isFinite(Number(t.priceChangePercent))) {
      return { symbol, available: false };
    }

    return {
      symbol,
      available: true,
      open: Number(t.openPrice),
      close: Number(t.lastPrice),
      change: Number(t.priceChange),
      percent: Number(t.priceChangePercent)
    };
  });
}

const getHourlyData = symbols => getWindowData(symbols, "1h");
const getFourHourData = symbols => getWindowData(symbols, "4h");

function marketDirection(items) {
  const valid = items.filter(x => x.available);

  if (!valid.length) {
    return { label: "DATA UNAVAILABLE", emoji: "⚪", className: "NEUTRAL" };
  }

  const average =
    valid.reduce((sum, item) => sum + item.percent, 0) / valid.length;

  if (average >= 0.5) {
    return { label: "BULLISH MARKET", emoji: "🟢", className: "BULLISH", average };
  }

  if (average <= -0.5) {
    return { label: "BEARISH MARKET", emoji: "🔴", className: "BEARISH", average };
  }

  return { label: "SIDEWAYS MARKET", emoji: "🟡", className: "SIDEWAYS", average };
}

function topMovers(items, count = 5) {
  const valid = items.filter(x => x.available);

  return {
    gainers: [...valid].sort((a, b) => b.percent - a.percent).slice(0, count),
    losers: [...valid].sort((a, b) => a.percent - b.percent).slice(0, count)
  };
}

function coinName(symbol) {
  return symbol.replace(/USDT$/, "");
}

function priceRows(config, tickers) {
  const bySymbol = new Map(tickers.map(t => [t.symbol, t]));
  const rows = [];

  for (const symbol of config.symbols) {
    const t = bySymbol.get(symbol);
    if (!t) continue;

    const pct = Number(t.priceChangePercent);
    const change = Number(t.priceChange);

    const emoji = pct > 0 ? "🟢 ▲" : pct < 0 ? "🔴 ▼" : "⚪ ●";

    let row = `${emoji} <b>${escapeHtml(coinName(symbol))}/USDT</b>\n`;
    row += `Price: <b>$${fmt(t.lastPrice)}</b>\n`;
    row += `24H Change: ${signed(change, " USDT")} (${signed(pct, "%")})`;

    if (config.showHighLow) {
      row += `\n24H High: $${fmt(t.highPrice)} | Low: $${fmt(t.lowPrice)}`;
    }

    if (config.showVolume) {
      row += `\n24H Volume: $${fmt(t.quoteVolume, 7)}\nTrades: ${fmt(t.count, 0)}`;
    }

    rows.push(row);
  }

  return rows;
}

const ROW_SEP = "\n\n━━━━━━━━━━━━━━━━━━\n\n";

// إذا زادت الأزواج عن حد تيليغرام (4096 حرف) ينقسم المنشور لعدة رسائل بدل ما يفشل
function buildPriceMessages(config, tickers) {
  const rows = priceRows(config, tickers);

  if (!rows.length) throw new Error("NO_PRICE_DATA");

  const footer =
    `\n\n━━━━━━━━━━━━━━━━━━\n🕒 ${utcTime()}\n📡 Source: Binance Spot`;

  const header = (part, total) =>
    `📊 <b>${escapeHtml(config.title)}</b>\n` +
    `<b>LIVE CRYPTO MARKET UPDATE${total > 1 ? ` (${part}/${total})` : ""}</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n\n`;

  const LIMIT = 3800;
  const chunks = [];
  let current = [];

  for (const row of rows) {
    const trial = [...current, row].join(ROW_SEP);

    if (current.length && header(9, 9).length + trial.length + footer.length > LIMIT) {
      chunks.push(current);
      current = [row];
    } else {
      current.push(row);
    }
  }

  chunks.push(current);

  return chunks.map((chunk, i) =>
    header(i + 1, chunks.length) + chunk.join(ROW_SEP) + footer
  );
}

function moversBlock(list, emptyText) {
  return list.length
    ? list.map(x =>
        `${x.percent < 0 ? "🔴" : "🟢"} ${escapeHtml(coinName(x.symbol))}: ${signed(x.percent, "%")}`
      ).join("\n")
    : emptyText;
}

function buildHourlyMessage(config, hourly) {
  const direction = marketDirection(hourly);
  const movers = topMovers(hourly);
  const valid = hourly.filter(x => x.available);

  let message =
    `📊 <b>${escapeHtml(config.title)}</b>\n` +
    `<b>HOURLY MARKET ANALYSIS</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `${direction.emoji} <b>${direction.label}</b>\n`;

  if (direction.average !== undefined) {
    message += `Average selected-coin movement: ${signed(direction.average, "%")}\n`;
  }

  message +=
    `Coins analyzed: ${valid.length}/${config.symbols.length}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🏆 <b>TOP GAINERS · 1H</b>\n` +
    moversBlock(movers.gainers, "No hourly data available.") +
    `\n\n📉 <b>TOP LOSERS · 1H</b>\n` +
    moversBlock(movers.losers, "No hourly data available.") +
    `\n\n━━━━━━━━━━━━━━━━━━\n<b>BITCOIN STATUS</b>\n`;

  const btc = hourly.find(x => x.symbol === "BTCUSDT");

  if (btc && btc.available) {
    message +=
      `Price: $${fmt(btc.close)}\n` +
      `1H Change: ${signed(btc.change)} (${signed(btc.percent, "%")})\n`;
  } else {
    message += "Hourly Bitcoin data unavailable.\n";
  }

  message +=
    `\n━━━━━━━━━━━━━━━━━━\n` +
    `🕒 ${utcTime()}\n` +
    `📡 Source: Binance Spot\n` +
    `⚠️ Market data is informational, not financial advice.`;

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
    message += `Average selected-coin movement: ${signed(direction.average, "%")}\n`;
  }

  message +=
    `Coins analyzed: ${fourHour.filter(x => x.available).length}/${config.symbols.length}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🚀 <b>TOP PERFORMERS · 4H</b>\n` +
    moversBlock(movers.gainers, "No data available.") +
    `\n\n📉 <b>WEAKEST PERFORMERS · 4H</b>\n` +
    moversBlock(movers.losers, "No data available.") +
    `\n\n━━━━━━━━━━━━━━━━━━\n` +
    `🕒 ${utcTime()}\n` +
    `📡 Source: Binance Spot\n` +
    `⚠️ Informational report, not financial advice.`;

  return message;
}

// ---------- Telegram ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function telegramCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_SECRETS_MISSING");
  }

  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000)
        }
      );

      const result = await response.json();

      if (response.ok && result.ok) return result.result;

      lastError = new Error(
        `TELEGRAM_HTTP_${response.status}: ${result.description || "Telegram error"}`
      );

      // أخطاء دائمة (توكن/صلاحيات/نص): لا فائدة من إعادة المحاولة
      if (response.status !== 429 && response.status < 500) throw lastError;

      const wait = (result.parameters?.retry_after || attempt) * 1000;
      await sleep(Math.min(wait, 8000));

    } catch (error) {
      if (String(error.message).startsWith("TELEGRAM_HTTP_4") &&
          !String(error.message).startsWith("TELEGRAM_HTTP_429")) {
        throw error;
      }
      lastError = error;
      await sleep(attempt * 1000);
    }
  }

  throw lastError;
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

// ---------- Publish jobs ----------

async function publishPrices(env, config) {
  const market = await getBinanceTickers(config.symbols);
  const messages = buildPriceMessages(config, market.data);

  let result;
  for (const text of messages) {
    result = await sendPost(env, config, text);
  }

  return { ok: true, type: "PRICE_UPDATE", message_id: result.message_id, parts: messages.length };
}

async function publishHourly(env, config) {
  const hourly = await getHourlyData(config.symbols);

  if (!hourly.some(x => x.available)) throw new Error("NO_HOURLY_DATA");

  const result = await sendPost(env, config, buildHourlyMessage(config, hourly));
  return { ok: true, type: "HOURLY_ANALYSIS", message_id: result.message_id };
}

async function publishFourHour(env, config) {
  const fourHour = await getFourHourData(config.symbols);

  if (!fourHour.some(x => x.available)) throw new Error("NO_4H_DATA");

  const result = await sendPost(env, config, buildFourHourMessage(config, fourHour));
  return { ok: true, type: "FOUR_HOUR_REPORT", message_id: result.message_id };
}

// ---------- Scheduler (cron واحد كل دقيقة، والكود يقرر شنو ينشر) ----------

// لا نكتب أي شي في KV. الجدولة تُحسب من وقت الكرون نفسه.
// الذاكرة هنا اختيارية: تستعمل فقط لتعويض دقيقة فائتة إذا بقي نفس الـ isolate شغال.
const memory = { slots: {}, last: {}, last_error: null };

function priceInterval(config) {
  const n = Math.floor(Number(config.priceEveryMinutes));
  return Number.isFinite(n) && n >= 1 && n <= 1440 ? n : DEFAULT_PRICE_INTERVAL_MIN;
}

function jobList(env, config) {
  const minute = 60000;

  return [
    { key: "price", ms: priceInterval(config) * minute, grace: 10 * minute,
      run: () => publishPrices(env, config) },
    { key: "hourly", ms: 60 * minute, grace: 15 * minute,
      run: () => publishHourly(env, config) },
    { key: "four_hour", ms: 240 * minute, grace: 30 * minute,
      run: () => publishFourHour(env, config) }
  ];
}

async function runWithRetry(env, job) {
  const delay = Number(env.RETRY_DELAY_MS ?? 2000);
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await job.run();
    } catch (error) {
      lastError = error;
      console.error(`JOB_${job.key}_ATTEMPT_${attempt}_FAILED:`, error.message);
      if (attempt < 3) await sleep(delay * attempt);
    }
  }

  throw lastError;
}

async function runDue(env, now = Date.now()) {
  const config = await getConfig(env); // قراءة فقط
  const due = [];

  for (const job of jobList(env, config)) {
    const slotStart = Math.floor(now / job.ms) * job.ms;
    const seen = memory.slots[job.key] || 0;
    const late = now - slotStart;

    // isolate جديد: ننشر فقط إذا هذي دقيقة الموعد نفسها. isolate قديم: نعوّض الفائت.
    const isDue = seen
      ? slotStart > seen && late <= job.grace
      : late < 60000;

    if (!isDue) continue;

    memory.slots[job.key] = slotStart;
    due.push({ job, prev: seen });
  }

  if (!due.length) return [];

  const results = await Promise.allSettled(
    due.map(({ job }) => runWithRetry(env, job))
  );

  return results.map((r, i) => {
    const { job, prev } = due[i];

    if (r.status === "fulfilled") {
      memory.last[job.key] = {
        message_id: r.value.message_id,
        published_at: new Date().toISOString()
      };
      return { job: job.key, ok: true, ...r.value };
    }

    // فشل نهائي: نرجّع الموعد ليعيد المحاولة تعويضاً (إن بقي نفس الـ isolate)
    memory.slots[job.key] = prev;
    memory.last_error = {
      job: job.key,
      message: String(r.reason?.message || r.reason),
      at: new Date().toISOString()
    };
    return { job: job.key, ok: false, error: memory.last_error.message };
  });
}

// ---------- HTTP ----------

async function statusPayload() {
  return {
    price: memory.last.price || null,
    hourly: memory.last.hourly || null,
    four_hour: memory.last.four_hour || null,
    last_error: memory.last_error || null
  };
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (!url.pathname.startsWith("/api/")) {
    return json({ ok: true, service: "KRYPTON MARKETS", message: "Worker is running" });
  }

  if (!isAuthorized(request, env)) {
    return json({ ok: false, error_type: "UNAUTHORIZED", error: "Check ADMIN_KEY" }, 401);
  }

  if (url.pathname === "/api/config" && request.method === "GET") {
    return json({ ok: true, config: await getConfig(env), state: await statusPayload() });
  }

  if (url.pathname === "/api/config" && request.method === "POST") {
    const body = await request.json();
    const old = await getConfig(env);

    const interval = body.priceEveryMinutes === undefined
      ? priceInterval(old)
      : Math.floor(Number(body.priceEveryMinutes));

    if (!Number.isFinite(interval) || interval < 1 || interval > 1440) {
      throw new Error("INVALID_INTERVAL");
    }

    const config = {
      symbols: cleanSymbols(body.symbols),
      title: String(body.title || DEFAULT_CONFIG.title).slice(0, 50),
      channelUrl: String(body.channelUrl || old.channelUrl || DEFAULT_CONFIG.channelUrl),
      showHighLow: body.showHighLow !== false,
      showVolume: body.showVolume !== false,
      priceEveryMinutes: interval
    };

    await env.CONFIG.put("bot_config", JSON.stringify(config));
    return json({ ok: true, config });
  }

  if (url.pathname === "/api/publish" && request.method === "POST") {
    const r = await publishPrices(env, await getConfig(env));
    memory.last.price = { message_id: r.message_id, published_at: new Date().toISOString() };
    return json({ ...r, count: (await getConfig(env)).symbols.length, updated_at: utcTime() });
  }

  if (url.pathname === "/api/publish-hourly" && request.method === "POST") {
    const r = await publishHourly(env, await getConfig(env));
    memory.last.hourly = { message_id: r.message_id, published_at: new Date().toISOString() };
    return json(r);
  }

  if (url.pathname === "/api/publish-4h" && request.method === "POST") {
    const r = await publishFourHour(env, await getConfig(env));
    memory.last.four_hour = { message_id: r.message_id, published_at: new Date().toISOString() };
    return json(r);
  }

  // يشغّل نفس منطق الكرون يدوياً (للاختبار)
  if (url.pathname === "/api/tick" && request.method === "POST") {
    return json({ ok: true, ran: await runDue(env) });
  }

  if (url.pathname === "/api/status" && request.method === "GET") {
    return json({ ok: true, state: await statusPayload() });
  }

  return json({ ok: false, error_type: "NOT_FOUND" }, 404);
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

  // كرون واحد فقط "* * * * *" — الكود يقرر الأسعار/الساعة/4 ساعات بنفسه
  async scheduled(controller, env, ctx) {
    console.log("KRYPTON_MARKETS_TICK:", controller.cron, controller.scheduledTime);

    ctx.waitUntil(
      runDue(env, controller.scheduledTime || Date.now()).catch(error => {
        console.error("TICK_FAILED:", error.message);
      })
    );
  }
};
