const $ = id => document.getElementById(id);
const ERR = {
  UNAUTHORIZED: "مفتاح ADMIN_KEY غير صحيح.",
  INVALID_CHAT_ID: "معرّف القناة غير صالح. استخدم @username أو رقم يبدأ بـ -100.",
  CHAT_ID_REQUIRED: "معرّف القناة مطلوب.",
  CHAT_ID_MISSING: "لا يوجد chat id. أضف TELEGRAM_CHAT_ID أو اكتب معرّف القناة.",
  INVALID_SYMBOL_FORMAT: "صيغة الأزواج غير صحيحة. يجب أن تنتهي بـ USDT مثل BTCUSDT.",
  INVALID_SYMBOL_COUNT: "عدد الأزواج بين 1 و100.",
  TOO_MANY_CHANNELS: "وصلت الحد الأقصى للقنوات (20).",
  CANNOT_DELETE_LAST: "لا يمكن حذف آخر قناة.",
  TELEGRAM_SECRETS_MISSING: "TELEGRAM_BOT_TOKEN غير مضبوط في Cloudflare."
};
let channels = [], state = { last: {}, errors: {} }, current = null; // current: id | "new"

const PRESETS = {
  "الرئيسية": "BTC ETH BNB SOL XRP",
  "ميم": "DOGE SHIB PEPE FLOKI BONK WIF",
  "ذكاء اصطناعي": "FET RENDER TAO WLD ARKM NEAR",
  "Layer1": "ADA AVAX DOT NEAR APT SUI TON",
  "DeFi": "UNI AAVE CRV LDO MKR COMP",
  "ألعاب": "AXS SAND MANA GALA IMX"
};

const base = () => $("workerUrl").value.trim().replace(/\/+$/, "");
function notice(msg, type = "ok") { $("notice").textContent = msg; $("notice").className = type; }
function errText(e) { const m = String(e.message || e); return ERR[m] || ERR[m.split(":")[0]] || m; }

async function api(path, options = {}) {
  if (!base() || !$("adminKey").value.trim()) throw new Error("أدخل رابط Worker ومفتاح ADMIN_KEY.");
  const r = await fetch(base() + path, { ...options, headers: { "content-type": "application/json", authorization: "Bearer " + $("adminKey").value.trim() } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error_type || data.error || "فشل الاتصال");
  return data;
}

// ----- list -----
function ago(iso) {
  if (!iso) return "—";
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? "الآن" : m < 60 ? `قبل ${m} د` : m < 1440 ? `قبل ${Math.round(m / 60)} س` : `قبل ${Math.round(m / 1440)} يوم`;
}
function renderList() {
  const box = $("channels"); box.textContent = "";
  channels.forEach(c => {
    const el = document.createElement("div");
    el.className = "card" + (c.id === current ? " sel" : "") + (c.enabled ? "" : " off");
    const b = document.createElement("b"); b.textContent = c.name + (c.enabled ? "" : " (متوقفة)");
    const s1 = document.createElement("small"); s1.textContent = `${c.title} · ${c.symbols.length} عملة · ${c.chatId || "القناة الافتراضية"}`;
    const L = k => (state.last[`${c.id}:${k}`] || {}).at;
    const s2 = document.createElement("small");
    s2.textContent = `آخر أسعار: ${ago(L("price"))} · ساعة: ${ago(L("hourly"))} · 4س: ${ago(L("four_hour"))}`;
    el.append(b, s1, s2);
    const e = state.errors[c.id];
    if (e) { const s3 = document.createElement("small"); s3.className = "err"; s3.textContent = `⚠️ ${e.job}: ${e.message}`; el.append(s3); }
    el.onclick = () => openEditor(c.id);
    box.append(el);
  });
  if (!channels.length) box.innerHTML = '<p class="hint">لا توجد قنوات.</p>';
}

async function load() {
  const d = await api("/api/channels");
  channels = d.channels; state = d.state || state; renderList();
}

// ----- editor -----
function fill(c) {
  $("f_name").value = c.name; $("f_chatId").value = c.chatId || ""; $("f_title").value = c.title;
  $("f_url").value = c.channelUrl || ""; $("f_btn").value = c.buttonText || "";
  $("f_symbols").value = c.symbols.join("\n");
  $("f_price").checked = c.price.enabled; $("f_every").value = String(c.price.every);
  $("f_hourly").checked = c.hourly.enabled; $("f_four").checked = c.fourHour.enabled;
  $("f_daily").checked = c.daily.enabled; $("f_dailyHour").value = c.daily.hour;
  $("f_alerts").checked = c.alerts.enabled; $("f_thr").value = c.alerts.threshold;
  $("f_win").value = c.alerts.window; $("f_cool").value = String(c.alerts.cooldown);
  $("f_hl").checked = c.showHighLow; $("f_vol").checked = c.showVolume;
  $("f_enabled").checked = c.enabled; $("f_tz").value = c.tzOffset;
}
const NEW_CH = {
  name: "", chatId: "", title: "", channelUrl: "", buttonText: "", enabled: true,
  symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"], showHighLow: true, showVolume: true, tzOffset: 3,
  price: { enabled: true, every: 5 }, hourly: { enabled: true }, fourHour: { enabled: true },
  daily: { enabled: false, hour: 21 }, alerts: { enabled: false, threshold: 3, window: "15m", cooldown: 60 }
};
function openEditor(id) {
  current = id;
  const isNew = id === "new";
  $("editor").hidden = false;
  $("editorTitle").textContent = isNew ? "قناة جديدة" : "تعديل: " + channels.find(c => c.id === id).name;
  fill(isNew ? NEW_CH : channels.find(c => c.id === id));
  $("startRow").hidden = !isNew; $("deleteBtn").hidden = isNew;
  document.querySelector(".pubs").hidden = isNew;
  $("chatHint").hidden = isNew || id !== "main";
  renderList(); $("editor").scrollIntoView({ behavior: "smooth" });
}
function readForm() {
  const syms = [...new Set($("f_symbols").value.split(/[\n,،\s]+/).map(x => x.trim().toUpperCase()).filter(Boolean))];
  return {
    name: $("f_name").value.trim(), chatId: $("f_chatId").value.trim(), title: $("f_title").value.trim(),
    channelUrl: $("f_url").value.trim(), buttonText: $("f_btn").value.trim(), symbols: syms,
    price: { enabled: $("f_price").checked, every: Number($("f_every").value) },
    hourly: { enabled: $("f_hourly").checked }, fourHour: { enabled: $("f_four").checked },
    daily: { enabled: $("f_daily").checked, hour: Number($("f_dailyHour").value) },
    alerts: { enabled: $("f_alerts").checked, threshold: Number($("f_thr").value), window: $("f_win").value, cooldown: Number($("f_cool").value) },
    showHighLow: $("f_hl").checked, showVolume: $("f_vol").checked, enabled: $("f_enabled").checked,
    tzOffset: Number($("f_tz").value || 0)
  };
}

function buildPresets() {
  const box = $("presets");
  Object.entries(PRESETS).forEach(([name, list]) => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = "+ " + name;
    b.onclick = () => {
      const cur = $("f_symbols").value.split(/[\n,\s]+/).filter(Boolean);
      const add = list.split(" ").map(x => x + "USDT");
      $("f_symbols").value = [...new Set([...cur, ...add])].join("\n");
    };
    box.append(b);
  });
  const clr = document.createElement("button"); clr.type = "button"; clr.textContent = "مسح";
  clr.onclick = () => { $("f_symbols").value = ""; };
  box.append(clr);
}

// ----- actions -----
$("loadBtn").onclick = async () => {
  try {
    localStorage.setItem("workerUrl", base());
    if ($("remember").checked) localStorage.setItem("adminKey", $("adminKey").value.trim()); else localStorage.removeItem("adminKey");
  } catch (e) {}
  try { await load(); notice("تم تحميل القنوات."); } catch (e) { notice(errText(e), "err"); }
};
$("newBtn").onclick = () => openEditor("new");

$("saveBtn").onclick = async () => {
  const btn = $("saveBtn"); btn.disabled = true;
  try {
    const body = readForm();
    if (current === "new") {
      if (!body.name) body.name = body.title || "قناة جديدة";
      if (!body.title) body.title = body.name;
      const d = await api("/api/channels", { method: "POST", body: JSON.stringify(body) });
      let msg = "تمت إضافة القناة.";
      if ($("f_start").checked) {
        try { await api(`/api/channels/${d.channel.id}/publish`, { method: "POST", body: JSON.stringify({ job: "price" }) }); msg += " ونُشر أول منشور."; }
        catch (e) { msg += " لكن النشر الأول فشل: " + errText(e); }
      }
      await load(); openEditor(d.channel.id); notice(msg);
    } else {
      await api("/api/channels/" + current, { method: "PUT", body: JSON.stringify(body) });
      await load(); openEditor(current); notice("تم الحفظ. التغيير يسري من الدقيقة القادمة.");
    }
  } catch (e) { notice(errText(e), "err"); }
  finally { btn.disabled = false; }
};

$("testBtn").onclick = async () => {
  try {
    if (current === "new") {
      notice("احفظ القناة أولاً ثم افحص الاتصال.", "err"); return;
    }
    const d = await api(`/api/channels/${current}/test`, { method: "POST", body: "{}" });
    notice(d.can_post ? `الاتصال سليم ✅ البوت @${d.bot} يستطيع النشر في «${d.chat_title}».`
      : `البوت @${d.bot} موجود في «${d.chat_title}» لكن ليس Admin بصلاحية النشر (${d.status}).`, d.can_post ? "ok" : "err");
  } catch (e) { notice(errText(e), "err"); }
};

document.querySelectorAll(".pub").forEach(b => b.onclick = async () => {
  b.disabled = true;
  try {
    const d = await api(`/api/channels/${current}/publish`, { method: "POST", body: JSON.stringify({ job: b.dataset.job }) });
    notice(`تم النشر ✅ رقم المنشور ${d.message_id || "—"}`);
    await load();
  } catch (e) { notice(errText(e), "err"); }
  finally { b.disabled = false; }
});

$("deleteBtn").onclick = async () => {
  if (!confirm("حذف هذه القناة من اللوحة؟ (لا يحذف القناة نفسها من تيليغرام)")) return;
  try {
    await api("/api/channels/" + current, { method: "DELETE" });
    current = null; $("editor").hidden = true; await load(); notice("تم الحذف.");
  } catch (e) { notice(errText(e), "err"); }
};

buildPresets();
try {
  $("workerUrl").value = localStorage.getItem("workerUrl") || "";
  const k = localStorage.getItem("adminKey"); if (k) { $("adminKey").value = k; $("remember").checked = true; }
} catch (e) {}
