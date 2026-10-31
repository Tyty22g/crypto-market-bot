import { json, sleep, slotStart } from "./util.js";
import { JOBS, sanitizeConfig, buildInitialConfig, defaultSettings } from "./config.js";
import { fetchDataset, priceMap, getCloses, rsi, sma, applyBinanceSettings, binanceState, diagnoseEndpoints } from "./binance.js";
import { sendMessage, sendPlain, telegramCall } from "./telegram.js";
import {
  buildPriceMessages, buildReport, windowItem, REPORTS,
  buildMoveAlert, buildLevelAlert, coinName
} from "./messages.js";
import { escapeHtml } from "./util.js";

const MIN = 60000, HR = 3600000, DAY = 86400000, WEEK = 7 * DAY;
const nextMinute = () => (Math.floor(Date.now() / MIN) + 1) * MIN;

// تعريف المهام لكل قناة (الجدولة تُحسب بتوقيت القناة)
export function jobDefs(ch) {
  const j = ch.jobs;
  const tz = ch.tzOffset * HR;

  return [
    { job: "price", enabled: j.price.enabled, period: j.price.everyMinutes * MIN,
      anchor: 0, grace: 10 * MIN, data: "24hr" },
    { job: "hourly", enabled: j.hourly.enabled, period: HR,
      anchor: 0, grace: 15 * MIN, data: "1h" },
    { job: "four_hour", enabled: j.four_hour.enabled, period: 4 * HR,
      anchor: 0, grace: 30 * MIN, data: "4h" },
    { job: "daily", enabled: j.daily.enabled, period: DAY,
      anchor: j.daily.hour * HR, grace: 60 * MIN, data: "1d" },
    { job: "weekly", enabled: j.weekly.enabled, period: WEEK,
      // الأسبوع يبدأ من الخميس (1970-01-01)، لذلك نحسب أيام الإزاحة منه
      anchor: ((j.weekly.day - 4 + 7) % 7) * DAY + j.weekly.hour * HR,
      grace: 120 * MIN, data: "7d" }
  ].map(d => ({ ...d, tz }));
}

export class Engine {
  constructor() {
    this.env = null;
    this.s = { config: null, slots: {}, logs: [], last: {}, hist: {}, alert: {}, secrets: {} };
    this.loadedAt = 0;
    this.lastTickAt = null;
    this.lastAlertMinute = 0;
    this.notifyAt = new Map();
    this.authFails = new Map();
    this.dirtyState = false;
    this.forceFlush = false;
    this.flushedAt = 0;
  }

  // يقرأ الإعدادات من KV (قراءة فقط، مخزنة 30 ثانية). لا توجد Durable Objects.
  async load(env) {
    this.env = env;
    if (!env.CONFIG) throw new Error("KV_BINDING_MISSING: اربط KV باسم CONFIG");
    if (this.s.config && Date.now() - this.loadedAt < 30000) return;

    const first = !this.s.config;
    let cfg = await env.CONFIG.get("bot_config_v3", "json");

    if (!cfg) {
      let legacy = null;
      try { legacy = await env.CONFIG.get("bot_config", "json"); } catch { /* لا يهم */ }
      cfg = buildInitialConfig(env, legacy);
      await env.CONFIG.put("bot_config_v3", JSON.stringify(cfg));
    }
    if (!cfg.settings) cfg.settings = defaultSettings();

    this.s.config = cfg;
    this.s.secrets = (await env.CONFIG.get("bot_secrets", "json")) || {};

    if (first) {
      const snap = await env.CONFIG.get("bot_state", "json");
      if (snap) { this.s.logs = snap.logs || []; this.s.last = snap.last || {}; }
    }

    applyBinanceSettings(cfg.settings);
    this.loadedAt = Date.now();
  }

  async handle(env, path, body = {}) {
    try {
      if (path === "authcheck") return { status: 200, data: { ok: true, ...this.authCheck(body.ip) } };
      if (path === "authfail") return { status: 200, data: { ok: true, ...this.authFail(body.ip) } };
      await this.load(env);
      return { status: 200, data: { ok: true, ...(await this.route(path, body)) } };
    } catch (error) {
      console.error("ENGINE_ERROR:", path, error.message);
      return { status: 400, data: { ok: false, error: error.message } };
    }
  }

  // التوكن المحفوظ من اللوحة له الأولوية، وإلا نستعمل Secret الـ Worker
  tgEnv() {
    const token = this.s.secrets?.telegramToken || this.env.TELEGRAM_BOT_TOKEN;
    return { ...this.env, TELEGRAM_BOT_TOKEN: token };
  }

  // config/secrets تُكتب فوراً (نادراً). السجلات تُكتب كل 10 دقائق كحد أقصى لحماية حد KV المجاني.
  async persist(...keys) {
    const kv = this.env.CONFIG;
    if (keys.includes("config")) await kv.put("bot_config_v3", JSON.stringify(this.s.config));
    if (keys.includes("secrets")) await kv.put("bot_secrets", JSON.stringify(this.s.secrets));
    if (keys.includes("logs") || keys.includes("last")) this.dirtyState = true;

    const now = Date.now();
    if (this.dirtyState && (this.forceFlush || now - this.flushedAt >= 10 * MIN)) {
      this.dirtyState = false; this.forceFlush = false; this.flushedAt = now;
      await kv.put("bot_state", JSON.stringify({ logs: this.s.logs.slice(0, 60), last: this.s.last }));
    }
  }

  async route(path, body) {
    switch (path) {
      case "state":
        return {
          config: this.s.config,
          status: await this.status(Date.now()),
          logs: this.s.logs.slice(0, 60),
          secrets: this.secretsInfo()
        };

      case "config": {
        this.s.config = sanitizeConfig(body.config, this.s.config);
        applyBinanceSettings(this.s.config.settings);
        await this.persist("config");
        // تنظيف حالة الجدولة للقنوات المحذوفة
        const ids = new Set(this.s.config.channels.map(c => c.id));
        for (const k of Object.keys(this.s.slots)) {
          if (!ids.has(k.split(":")[0])) delete this.s.slots[k];
        }
        return { config: this.s.config };
      }

      case "diagnose": {
        const urls = (this.s.config.settings.endpoints || []).map(e => e.url);
        const extra = String(body.url || "").trim().replace(/\/+$/, "");
        if (extra && /^https:\/\/[A-Za-z0-9.-]+(:\d{2,5})?(\/[A-Za-z0-9._~\-\/]*)?$/.test(extra) && !urls.includes(extra)) urls.push(extra);
        return { results: await diagnoseEndpoints(urls, this.s.config.settings.timeoutMs) };
      }

      case "secret": return this.saveToken(body.telegramToken);

      case "publish": return this.publishNow(body.channelId, body.job);
      case "preview": return this.previewNow(body.channelId, body.job);
      case "test": return this.testNow(body.channelId);

      case "tick":
        await this.tick(Number(body.at) || Date.now());
        return {};

      default: throw new Error("NOT_FOUND");
    }
  }

  // ---------- توكن تيليغرام من اللوحة ----------

  secretsInfo() {
    const t = this.s.secrets?.telegramToken;
    return {
      source: t ? "dashboard" : this.env.TELEGRAM_BOT_TOKEN ? "env" : "none",
      masked: t ? `${t.split(":")[0]}:••••${t.slice(-4)}` : null
    };
  }

  async saveToken(token) {
    const t = String(token ?? "").trim();

    if (!t) {
      // حذف التوكن المحفوظ بالوحة (يرجع لـ Secret الـ Worker إن وجد)
      delete this.s.secrets.telegramToken;
      await this.persist("secrets");
      return { secrets: this.secretsInfo() };
    }

    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,50}$/.test(t)) {
      throw new Error("شكل التوكن غير صحيح. انسخه كامل من BotFather");
    }

    // نتحقق منه عند تيليغرام قبل الحفظ
    let me;
    try {
      me = await telegramCall({ ...this.env, TELEGRAM_BOT_TOKEN: t }, "getMe", {});
    } catch (e) {
      throw new Error("تيليغرام رفض التوكن: " + e.message);
    }

    this.s.secrets.telegramToken = t;
    await this.persist("secrets");
    return { secrets: this.secretsInfo(), bot: me.username };
  }

  // ---------- حماية من التخمين ----------

  authCheck(ip) {
    const e = this.authFails.get(ip);
    return { blocked: Boolean(e && e.n >= 10 && Date.now() - e.t < 10 * MIN) };
  }

  authFail(ip) {
    const now = Date.now();
    const e = this.authFails.get(ip);
    this.authFails.set(ip, !e || now - e.t > 10 * MIN ? { n: 1, t: now } : { n: e.n + 1, t: now });
    return this.authCheck(ip);
  }

  // ---------- المنطق الرئيسي ----------

  async tick(now) {
    this.lastTickAt = now;
    if (this.s.config.paused) return;

    const due = this.claimDue(now);
    const alerts = this.runAlerts(now).catch(e => console.error("ALERTS_FAILED:", e.message));

    if (due.length) await this.runDue(due, now);
    await alerts;
  }

  // يحجز المواعيد بشكل متزامن (قبل أي await) فلا يتكرر النشر حتى لو جاء الكرون والمنبّه معاً
  claimDue(now) {
    const due = [];
    let dirty = false;

    for (const ch of this.s.config.channels) {
      if (!ch.enabled || !ch.chatId) continue;

      for (const def of jobDefs(ch)) {
        if (!def.enabled) continue;

        const key = `${ch.id}:${def.job}`;
        const slot = slotStart(now, def.period, def.anchor, def.tz);
        const seen = this.s.slots[key];

        if (seen === undefined) {
          // isolate جديد (طريقة النسخة القديمة): ننشر فقط إذا هذي دقيقة الموعد نفسها
          if (now - slot >= MIN) { this.s.slots[key] = slot; continue; }
        } else if (slot <= seen) {
          continue;
        } else if (now - slot > def.grace) {
          // تأخر كثير: نتخطى بدل نشر تقرير قديم
          this.s.slots[key] = slot;
          dirty = true;
          console.log("SLOT_SKIPPED_TOO_LATE:", key);
          continue;
        }

        this.s.slots[key] = slot;
        dirty = true;
        due.push({ ch, def, key, prev: seen });
      }
    }

    return due;
  }

  async withRetry(fn) {
    const delay = Number(this.env.RETRY_DELAY_MS ?? 1000);
    let last;
    for (let i = 1; i <= 3; i++) {
      try { return await fn(); }
      catch (e) { last = e; if (i < 3) await sleep(delay * i); }
    }
    throw last;
  }

  async runDue(due, now) {
    // طلب واحد لكل نوع بيانات لكل القنوات
    const symbolsByType = new Map();
    for (const d of due) {
      if (!symbolsByType.has(d.def.data)) symbolsByType.set(d.def.data, new Set());
      d.ch.symbols.forEach(s => symbolsByType.get(d.def.data).add(s));
    }

    const datasets = {};
    await Promise.all([...symbolsByType].map(async ([type, set]) => {
      try { datasets[type] = await this.withRetry(() => fetchDataset(type, [...set])); }
      catch (error) { datasets[type] = { error }; }
    }));

    const techCache = new Map();

    for (const d of due) {
      const t0 = Date.now();
      try {
        const ds = datasets[d.def.data];
        if (ds.error) throw ds.error;

        const r = await this.runOne(d.ch, d.def.job, ds, now, techCache, false);
        this.record(d.ch, d.def.job, true, r.message_id, Date.now() - t0);
      } catch (error) {
        // فشل: نرجّع الموعد لتعيد الدقيقة القادمة المحاولة (ضمن فترة السماح)
        if (d.prev === undefined) delete this.s.slots[d.key];
        else this.s.slots[d.key] = d.prev;

        this.record(d.ch, d.def.job, false, null, Date.now() - t0, error.message);
        await this.notifyAdmin(d.ch, d.def.job, error.message);
      }
    }

    await this.persist("logs", "last");
  }

  async runOne(ch, job, map, now, techCache, dry) {
    let messages;

    if (job === "price") {
      messages = buildPriceMessages(ch, map, now);
    } else {
      const items = ch.symbols.map(s => windowItem(s, map.get(s)));
      if (!items.some(x => x.available)) throw new Error("NO_DATA");

      let tech = null;
      if (job === "four_hour" && ch.technicals) {
        try { tech = await this.technicals(ch, techCache); }
        catch (e) { console.warn("TECHNICALS_FAILED:", e.message); }
      }

      messages = [buildReport(ch, items, REPORTS[job], tech, now)];
    }

    if (dry) return { messages };

    let last;
    for (let i = 0; i < messages.length; i++) {
      last = await sendMessage(this.tgEnv(), ch, messages[i]);
      if (i < messages.length - 1) await sleep(400);
    }

    return { message_id: last.message_id, parts: messages.length };
  }

  async technicals(ch, cache) {
    const out = await Promise.all(ch.symbols.slice(0, 5).map(symbol => {
      if (!cache.has(symbol)) {
        cache.set(symbol, getCloses(symbol).then(c => ({
          symbol, close: c.at(-1), rsi: rsi(c), ma20: sma(c, 20), ma50: sma(c, 50)
        })).catch(() => null));
      }
      return cache.get(symbol);
    }));
    return out.filter(Boolean);
  }

  record(ch, job, ok, id, ms, err = null, manual = false) {
    const now = Date.now();
    const logs = this.s.logs;

    const same = !ok && logs.slice(0, 10).find(l =>
      !l.ok && l.ch === ch.id && l.job === job && l.err === err && now - l.t < HR
    );

    if (same) {
      same.t = now;
      same.n = (same.n || 1) + 1;
    } else {
      logs.unshift({ t: now, ch: ch.id, name: ch.name, job, ok, id: id || null, ms, err, n: 1, manual });
      if (!ok) this.forceFlush = true;
    }

    if (logs.length > 150) logs.length = 150;
    if (ok) (this.s.last[ch.id] ||= {})[job] = { t: now, id };
  }

  async notifyAdmin(ch, job, message) {
    const chat = this.s.config.adminChatId;
    if (!chat) return;

    const key = `${ch.id}:${job}`;
    if (Date.now() - (this.notifyAt.get(key) || 0) < 30 * MIN) return;
    this.notifyAt.set(key, Date.now());

    try {
      await sendPlain(this.tgEnv(), chat,
        `⚠️ <b>فشل النشر</b>\nالقناة: ${escapeHtml(ch.name)}\nالنوع: ${job}\nالخطأ: ${escapeHtml(message)}`);
    } catch { /* تجاهل */ }
  }

  // ---------- أوامر يدوية من اللوحة ----------

  channel(id) {
    const ch = this.s.config.channels.find(c => c.id === id);
    if (!ch) throw new Error("القناة غير موجودة");
    return ch;
  }

  async manualData(ch, job) {
    if (!JOBS.includes(job)) throw new Error("نوع منشور غير معروف");
    const def = jobDefs(ch).find(d => d.job === job);
    return this.withRetry(() => fetchDataset(def.data, ch.symbols));
  }

  async publishNow(channelId, job) {
    const ch = this.channel(channelId);
    const t0 = Date.now();

    try {
      const map = await this.manualData(ch, job);
      const r = await this.runOne(ch, job, map, Date.now(), new Map(), false);
      this.record(ch, job, true, r.message_id, Date.now() - t0, null, true);
      await this.persist("logs", "last");
      return { message_id: r.message_id, parts: r.parts };
    } catch (error) {
      this.record(ch, job, false, null, Date.now() - t0, error.message, true);
      await this.persist("logs");
      throw error;
    }
  }

  async previewNow(channelId, job) {
    const ch = this.channel(channelId);
    const map = await this.manualData(ch, job);
    return this.runOne(ch, job, map, Date.now(), new Map(), true);
  }

  async testNow(channelId) {
    const ch = this.channel(channelId);
    const r = await sendMessage(this.tgEnv(), ch,
      `✅ <b>${escapeHtml(ch.title)}</b>\nConnection test OK — ${escapeHtml(ch.name)}`);
    return { message_id: r.message_id };
  }

  // ---------- تنبيهات الأسعار ----------

  async runAlerts(now) {
    const minute = Math.floor(now / MIN);
    if (this.lastAlertMinute === minute) return; // الكرون والمنبّه معاً: مرة وحدة بالدقيقة
    this.lastAlertMinute = minute;

    const chs = this.s.config.channels.filter(c =>
      c.enabled && c.chatId &&
      (c.alerts.moves.enabled || c.alerts.levels.some(l => !l.triggered))
    );

    if (!chs.length) {
      this.s.hist = {};
      return;
    }

    const symbols = new Set();
    let maxMinutes = 5;
    for (const c of chs) {
      if (c.alerts.moves.enabled) {
        c.symbols.forEach(s => symbols.add(s));
        maxMinutes = Math.max(maxMinutes, c.alerts.moves.minutes);
      }
      c.alerts.levels.filter(l => !l.triggered).forEach(l => symbols.add(l.symbol));
    }

    const prices = await this.withRetry(() => priceMap([...symbols]));

    // سجل الأسعار (للمقارنة خلال آخر N دقيقة)
    const keepFrom = now - (maxMinutes + 3) * MIN;
    const hist = {};
    for (const s of symbols) {
      const arr = (this.s.hist[s] || []).filter(([t]) => t >= keepFrom);
      if (prices.has(s)) arr.push([now, prices.get(s)]);
      hist[s] = arr;
    }
    this.s.hist = hist;

    let configChanged = false;
    let alertChanged = false;
    let sent = false;

    for (const ch of chs) {
      // 1) حركة سريعة
      const mv = ch.alerts.moves;
      if (mv.enabled) {
        for (const symbol of ch.symbols) {
          const cur = prices.get(symbol);
          if (cur === undefined) continue;

          const target = now - mv.minutes * MIN;
          const ref = [...(hist[symbol] || [])].reverse().find(([t]) => t <= target);
          if (!ref || target - ref[0] > 3 * MIN) continue;

          const change = ((cur - ref[1]) / ref[1]) * 100;
          if (Math.abs(change) < mv.percent) continue;

          const key = `${ch.id}:${symbol}:${change > 0 ? "up" : "down"}`;
          if (now - (this.s.alert[key] || 0) < mv.cooldown * MIN) continue;

          this.s.alert[key] = now;
          alertChanged = true;
          sent = true;
          await this.sendAlert(ch, buildMoveAlert(ch, symbol, change, mv.minutes, ref[1], cur, now));
        }
      }

      // 2) مستويات سعرية (مرة وحدة لكل مستوى)
      for (const lv of ch.alerts.levels) {
        if (lv.triggered) continue;
        const cur = prices.get(lv.symbol);
        if (cur === undefined) continue;

        const hit = lv.dir === "above" ? cur >= lv.price : cur <= lv.price;
        if (!hit) continue;

        lv.triggered = true;
        configChanged = true;
        sent = true;
        await this.sendAlert(ch, buildLevelAlert(ch, lv, cur, now));
      }
    }

    if (configChanged) await this.persist("config");
    if (alertChanged) {
      for (const [k, t] of Object.entries(this.s.alert)) {
        if (now - t > DAY) delete this.s.alert[k];
      }
    }
    if (sent) await this.persist("logs", "last");
  }

  async sendAlert(ch, text) {
    const t0 = Date.now();
    try {
      const r = await sendMessage(this.tgEnv(), ch, text);
      this.record(ch, "alert", true, r.message_id, Date.now() - t0);
    } catch (error) {
      this.record(ch, "alert", false, null, Date.now() - t0, error.message);
      await this.notifyAdmin(ch, "alert", error.message);
    }
  }

  // ---------- الحالة للوحة ----------

  async status(now) {
    const channels = this.s.config.channels.map(ch => ({
      id: ch.id,
      name: ch.name,
      enabled: ch.enabled,
      jobs: jobDefs(ch).map(d => {
        const slot = slotStart(now, d.period, d.anchor, d.tz);
        const seen = this.s.slots[`${ch.id}:${d.job}`];
        return {
          job: d.job,
          enabled: d.enabled,
          last: this.s.last[ch.id]?.[d.job] || null,
          next: seen !== undefined && seen >= slot ? slot + d.period : slot
        };
      })
    }));

    return {
      now,
      lastTickAt: this.lastTickAt,
      nextAlarm: null,
      binance: binanceState(),
      paused: this.s.config.paused,
      channels
    };
  }
}

export const engine = new Engine();
