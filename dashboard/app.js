const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let cfg = null, status = null, logs = [], secrets = null, dirty = false;
const openIds = new Set();
let timer = null;

const JOB_LABEL = {
  price: "الأسعار", hourly: "تحليل الساعة", four_hour: "تقرير 4 ساعات",
  daily: "التقرير اليومي", weekly: "التقرير الأسبوعي", alert: "تنبيه"
};
const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const INTERVALS = [1, 2, 3, 5, 10, 15, 30, 60, 120, 240, 720, 1440];
const intervalLabel = n => n < 60 ? `كل ${n} دقيقة` : n === 60 ? "كل ساعة" : n < 1440 ? `كل ${n / 60} ساعات` : "كل يوم";
const TZ = [[0, "UTC"], [1, "UTC+1"], [2, "UTC+2 (مصر/الأردن/لبنان)"], [3, "UTC+3 (العراق/السعودية/الكويت/تركيا)"],
  [3.5, "UTC+3:30 (إيران)"], [4, "UTC+4 (الإمارات/عمان)"], [5, "UTC+5"], [8, "UTC+8"], [-5, "UTC-5 (نيويورك)"]];

// ---------- الاتصال ----------
const store = () => ($("remember").checked ? localStorage : sessionStorage);
function loadCreds() {
  const s = localStorage.getItem("cmb_url") ? localStorage : sessionStorage;
  $("workerUrl").value = s.getItem("cmb_url") || "";
  $("adminKey").value = s.getItem("cmb_key") || "";
}
const base = () => $("workerUrl").value.trim().replace(/\/+$/, "");

function notice(msg, type = "ok") { $("notice").textContent = msg; $("notice").className = type; }

async function api(path, method = "GET", body) {
  const r = await fetch(base() + path, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer " + $("adminKey").value.trim() },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data;
  try { data = await r.json(); } catch { throw new Error("رد غير صالح من الـ Worker"); }
  if (!r.ok || !data.ok) throw new Error(data.error || "فشل الاتصال");
  return data;
}

async function connect() {
  try {
    const d = await api("/api/state");
    localStorage.removeItem("cmb_url"); localStorage.removeItem("cmb_key");
    sessionStorage.removeItem("cmb_url"); sessionStorage.removeItem("cmb_key");
    store().setItem("cmb_url", base()); store().setItem("cmb_key", $("adminKey").value.trim());
    cfg = d.config; status = d.status; logs = d.logs; secrets = d.secrets; dirty = false;
    $("login").hidden = true; $("app").hidden = false;
    renderAll();
    notice("تم الاتصال.");
    clearInterval(timer);
    timer = setInterval(refreshStatus, 20000);
  } catch (e) { notice(e.message, "err"); }
}

async function refreshStatus() {
  if (!cfg || document.hidden || $("tab-status").hidden) return;
  try { const d = await api("/api/state"); status = d.status; logs = d.logs; secrets = d.secrets; renderStatus(); } catch { /* تجاهل */ }
}

// ---------- أدوات ----------
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `قبل ${s} ث`;
  if (s < 3600) return `قبل ${Math.floor(s / 60)} د`;
  if (s < 86400) return `قبل ${Math.floor(s / 3600)} س`;
  return `قبل ${Math.floor(s / 86400)} يوم`;
}
function inn(ms) {
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  if (s < 60) return `بعد ${s} ث`;
  if (s < 3600) return `بعد ${Math.floor(s / 60)} د`;
  if (s < 86400) return `بعد ${Math.floor(s / 3600)} س ${Math.floor((s % 3600) / 60)} د`;
  return `بعد ${Math.floor(s / 86400)} يوم`;
}
function hint(err) {
  if (!err) return "";
  if (/chat not found/i.test(err)) return " — الـ chat id غلط أو البوت مو مضاف للقناة";
  if (/not enough rights|forbidden|can't post|kicked/i.test(err)) return " — البوت لازم يكون أدمن بصلاحية النشر";
  if (/BINANCE.*(451|403)/i.test(err)) return " — Binance تحجب منطقة السيرفر. أضف رابط وسيط من تبويب الاتصال";
  if (/BINANCE/i.test(err)) return " — تعذر الاتصال بـ Binance. افحص الروابط من تبويب الاتصال";
  if (/NO_DATA|NO_PRICE/i.test(err)) return " — ما وصلت بيانات للأزواج";
  return "";
}
function setPath(obj, path, val) {
  const k = path.split(".");
  let o = obj;
  for (let i = 0; i < k.length - 1; i++) o = o[k[i]];
  o[k[k.length - 1]] = val;
}
function markDirty() {
  dirty = true;
  $("dirty").textContent = "● تغييرات غير محفوظة";
  $("saveBtn").disabled = false;
}
function clean() {
  dirty = false; $("dirty").textContent = ""; $("saveBtn").disabled = true;
}

// ---------- حقول ----------
const F = {
  text: (label, path, v, ph = "", dir = "") =>
    `<label>${label}<input data-path="${path}" data-type="text" value="${esc(v)}" placeholder="${esc(ph)}" ${dir}></label>`,
  chk: (label, path, v) =>
    `<label class="check"><input type="checkbox" data-path="${path}" data-type="bool" ${v ? "checked" : ""}> ${label}</label>`,
  num: (label, path, v, min, max, step = 1) =>
    `<label>${label}<input type="number" data-path="${path}" data-type="num" value="${esc(v)}" min="${min}" max="${max}" step="${step}"></label>`,
  sel: (label, path, v, opts) =>
    `<label>${label}<select data-path="${path}" data-type="num">${opts.map(([val, t]) =>
      `<option value="${val}" ${Number(val) === Number(v) ? "selected" : ""}>${t}</option>`).join("")}</select></label>`
};
const DEF_TPL = "$" + "{price}";
const PROV = [["binance", "Binance"], ["bybit", "Bybit"], ["okx", "OKX"], ["kucoin", "KuCoin"],
  ["bitget", "Bitget"], ["gateio", "Gate.io"], ["mexc", "MEXC"]];
F.selS = (label, path, v, opts) =>
  `<label>${label}<select data-path="${path}" data-type="text">${opts.map(([val, t]) =>
    `<option value="${val}" ${val === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>`;
const HOURS = Array.from({ length: 24 }, (_, i) => [i, String(i).padStart(2, "0") + ":00"]);

function channelCard(ch, i) {
  const p = `channels.${i}`;
  const j = ch.jobs, mv = ch.alerts.moves;
  const lv = ch.alerts.levels.map((l, k) => `
    <div class="row">
      <span class="grow" dir="ltr">${esc(l.symbol.replace(/USDT$/, ""))} ${l.dir === "above" ? "▲ فوق" : "▼ تحت"} ${esc(l.price)}</span>
      ${l.triggered ? `<span class="badge ok">تم التنبيه</span><button class="secondary small" data-act="rearm" data-i="${i}" data-j="${k}">إعادة تفعيل</button>` : `<span class="badge">فعّال</span>`}
      <button class="danger small" data-act="del-level" data-i="${i}" data-j="${k}">حذف</button>
    </div>`).join("") || `<p class="muted">ما أكو مستويات.</p>`;

  return `
  <details class="card" data-id="${esc(ch.id)}" ${openIds.has(ch.id) ? "open" : ""}>
    <summary><span>${esc(ch.name)}</span>
      <span class="badge ${ch.enabled ? "" : "off"}">${ch.enabled ? "فعّالة" : "معطلة"}</span>
      <span class="muted" style="margin-right:auto">${ch.symbols.length} زوج</span></summary>
    <div class="body">
      ${F.text("اسم القناة (للوحة فقط)", `${p}.name`, ch.name)}
      ${F.chk("القناة فعّالة", `${p}.enabled`, ch.enabled)}
      ${F.text("Chat ID أو @username للقناة", `${p}.chatId`, ch.chatId, "@MyChannel أو -100123456789", 'dir="ltr"')}
      ${F.selS("المنصة (مصدر الأسعار)", `${p}.provider`, ch.provider || "auto",
        [["auto", "تلقائي (حسب ترتيب المنصات)"], ...PROV])}
      ${F.selS("شكل المنشور", `${p}.format`, ch.format || "full",
        [["full", "كامل (أسعار + تقارير)"], ["price_only", "سعر فقط مثل $5677.77666"]])}
      ${ch.format === "price_only" ? F.text("قالب الرسالة ({price} {arrow} {change} {symbol})", `${p}.priceTemplate`, ch.priceTemplate || DEF_TPL, "", 'dir="ltr"') +
        F.chk("فواصل الآلاف (5,677.77)", `${p}.priceGrouping`, ch.priceGrouping) +
        `<p class="hint">ينشر السعر فقط لكل عملة بالقائمة. اضبط «نشر الأسعار» كل 3 دقائق مثلاً. تقارير الساعة والـ4 ساعات تُتجاهل بهذا الشكل.</p>` : ""}
      ${F.text("عنوان المنشور", `${p}.title`, ch.title)}
      ${F.text("رابط القناة (زر الانضمام تحت المنشور)", `${p}.channelUrl`, ch.channelUrl, "https://t.me/...", 'dir="ltr"')}
      ${F.text("نص الزر (اختياري)", `${p}.buttonText`, ch.buttonText, "📢 JOIN ...")}
      <label>العملات (كل عملة بسطر. تكتب BTC أو BTCUSDT)
        <textarea rows="7" dir="ltr" spellcheck="false" data-path="${p}.symbols" data-type="symbols">${esc(ch.symbols.join("\n"))}</textarea></label>
      ${F.sel("فرق التوقيت (يحدد وقت التقارير والعرض)", `${p}.tzOffset`, ch.tzOffset, TZ)}
      ${F.chk("إظهار أعلى/أدنى سعر 24س", `${p}.showHighLow`, ch.showHighLow)}
      ${F.chk("إظهار حجم التداول", `${p}.showVolume`, ch.showVolume)}

      <div class="sec"><h3>الجدولة</h3>
        ${F.chk("نشر الأسعار", `${p}.jobs.price.enabled`, j.price.enabled)}
        ${F.sel("كل كم", `${p}.jobs.price.everyMinutes`, j.price.everyMinutes, INTERVALS.map(n => [n, intervalLabel(n)]))}
        ${F.chk("تحليل الساعة (كل ساعة)", `${p}.jobs.hourly.enabled`, j.hourly.enabled)}
        ${F.chk("تقرير 4 ساعات", `${p}.jobs.four_hour.enabled`, j.four_hour.enabled)}
        ${F.chk("مؤشرات RSI و MA داخل تقرير الـ4 ساعات (لأول 5 عملات)", `${p}.technicals`, ch.technicals)}
        ${F.chk("تقرير يومي", `${p}.jobs.daily.enabled`, j.daily.enabled)}
        ${F.sel("ساعة التقرير اليومي", `${p}.jobs.daily.hour`, j.daily.hour, HOURS)}
        ${F.chk("تقرير أسبوعي", `${p}.jobs.weekly.enabled`, j.weekly.enabled)}
        <div class="grid2">
          ${F.sel("اليوم", `${p}.jobs.weekly.day`, j.weekly.day, DAYS.map((d, k) => [k, d]))}
          ${F.sel("الساعة", `${p}.jobs.weekly.hour`, j.weekly.hour, HOURS)}
        </div>
        <p class="hint">كل المواعيد بتوقيت القناة اللي اخترته فوق.</p>
      </div>

      <div class="sec"><h3>تنبيهات الأسعار</h3>
        ${F.chk("تنبيه عند حركة سريعة", `${p}.alerts.moves.enabled`, mv.enabled)}
        <div class="grid2">
          ${F.num("النسبة %", `${p}.alerts.moves.percent`, mv.percent, 0.1, 100, 0.1)}
          ${F.num("خلال كم دقيقة", `${p}.alerts.moves.minutes`, mv.minutes, 1, 60)}
        </div>
        ${F.num("لا يكرر نفس التنبيه قبل (دقيقة)", `${p}.alerts.moves.cooldown`, mv.cooldown, 1, 1440)}
        <label>مستويات سعرية (تنبيه مرة وحدة)</label>
        ${lv}
        <div class="grid2" data-newlevel="${i}">
          <input placeholder="BTC" dir="ltr" data-nl="symbol">
          <input placeholder="السعر" type="number" step="any" dir="ltr" data-nl="price">
        </div>
        <div class="actions">
          <select data-nl="dir" style="width:auto"><option value="above">فوق ▲</option><option value="below">تحت ▼</option></select>
          <button class="secondary small" data-act="add-level" data-i="${i}">+ إضافة مستوى</button>
        </div>
      </div>

      <div class="sec"><h3>أدوات</h3>
        <div class="actions">
          <select data-role="job" style="width:auto">${Object.entries(JOB_LABEL).filter(([k]) => k !== "alert")
            .map(([k, t]) => `<option value="${k}">${t}</option>`).join("")}</select>
          <button data-act="publish" data-i="${i}">نشر الآن</button>
          <button class="secondary" data-act="preview" data-i="${i}">معاينة</button>
          <button class="secondary" data-act="test" data-i="${i}">تجربة اتصال</button>
          <button class="danger" data-act="remove" data-i="${i}">حذف القناة</button>
        </div>
      </div>
    </div>
  </details>`;
}

// ---------- العرض ----------
function renderChannels() {
  $("channels").innerHTML = cfg.channels.map(channelCard).join("") ||
    `<div class="panel muted">ما أكو قنوات. اضغط "إضافة قناة جديدة".</div>`;
}
function renderGeneral() {
  $("paused").checked = cfg.paused;
  $("adminChatId").value = cfg.adminChatId || "";
}
function renderStatus() {
  const s = status;
  let sys;
  if (s.paused) sys = `<b>⏸ النشر متوقف مؤقتاً</b> (من تبويب عام)`;
  else if (s.lastTickAt && Date.now() - s.lastTickAt < 150000) sys = `<b class="okc">✅ الجدولة شغالة</b> · آخر دورة ${ago(s.lastTickAt)}`;
  else sys = `<b>🟡 الجدولة تعمل بالكرون كل دقيقة</b> · الحالة تتحدث عند أول دورة بعد فتح اللوحة`;
  const b = s.binance || {};
  let bl = "";
  if (b.lastOkAt && (!b.lastFailAt || b.lastOkAt >= b.lastFailAt)) {
    bl = `<div class="muted" dir="ltr" style="text-align:left">Binance ✅ ${ago(b.lastOkAt)} · ${esc(b.lastOkBase)}</div>`;
  } else if (b.lastFailAt) {
    bl = `<div class="err" dir="ltr" style="text-align:left">Binance ❌ ${ago(b.lastFailAt)} · ${esc(b.lastFail)}</div>` +
         `<div class="muted">افحص الروابط من تبويب «الاتصال»</div>`;
  }
  $("sysline").innerHTML = sys + bl;

  $("statusChannels").innerHTML = s.channels.map(c => `
    <div class="panel"><h2>${esc(c.name)} <span class="badge ${c.enabled ? "ok" : "off"}">${c.enabled ? "فعّالة" : "معطلة"}</span></h2>
      ${c.jobs.filter(j => j.enabled).map(j => `
        <div class="row"><span class="grow">${JOB_LABEL[j.job]}</span>
          <span class="muted">${j.last ? `آخر نشر ${ago(j.last.t)} (#${j.last.id})` : "لسه ما نشر"}</span>
          <span class="muted">· القادم ${inn(j.next)}</span></div>`).join("") || `<p class="muted">كل المهام معطلة.</p>`}
    </div>`).join("");

  $("logs").innerHTML = logs.slice(0, 30).map(l => `
    <div class="row"><span>${l.ok ? "✅" : "❌"}</span>
      <span class="grow">${esc(l.name)} · ${JOB_LABEL[l.job] || l.job}${l.manual ? " (يدوي)" : ""}
        ${l.ok ? `<span class="muted"> #${l.id}</span>` : `<div class="err" dir="ltr" style="text-align:left">${esc(l.err)}${l.n > 1 ? ` ×${l.n}` : ""}</div><div class="muted">${esc(hint(l.err))}</div>`}</span>
      <span class="muted">${ago(l.t)}</span></div>`).join("") || `<p class="muted">لسه ما أكو عمليات.</p>`;
}
function renderConnection() {
  const eps = cfg.settings.endpoints;
  $("endpoints").innerHTML = eps.map((e, i) => `
    <div class="ep">
      <input type="checkbox" data-ep="toggle" data-i="${i}" ${e.enabled ? "checked" : ""}>
      <span class="url ${e.enabled ? "" : "off"}">${esc(e.url)}</span>
      <button class="secondary" data-ep="up" data-i="${i}" ${i === 0 ? "disabled" : ""}>↑</button>
      <button class="secondary" data-ep="down" data-i="${i}" ${i === eps.length - 1 ? "disabled" : ""}>↓</button>
      <button class="danger" data-ep="del" data-i="${i}">✕</button>
    </div>`).join("");
  $("timeoutMs").value = cfg.settings.timeoutMs;

  const t = secrets || { source: "none" };
  $("tokenState").innerHTML = t.source === "dashboard"
    ? `التوكن الحالي: <b dir="ltr">${esc(t.masked)}</b> (محفوظ من اللوحة)`
    : t.source === "env" ? "يُستعمل التوكن من Cloudflare Secrets." : `<span class="err">ما أكو توكن مضبوط.</span>`;
}
function renderProviders() {
  const st = cfg.settings, names = Object.fromEntries(PROV);
  const order = st.providerOrder || PROV.map(p => p[0]);
  $("providers").innerHTML = order.map((id, i) => `
    <div class="ep" data-pid="${id}">
      <input type="checkbox" data-pv="enabled" ${st.providers[id]?.enabled !== false ? "checked" : ""}>
      <b style="min-width:62px">${names[id] || id}</b>
      ${id === "binance" ? `<span class="url muted">الروابط بالأعلى</span>` :
        `<input class="url" data-pv="base" dir="ltr" value="${esc(st.providers[id]?.base || "")}" style="flex:1;min-width:0">`}
      <button class="secondary" data-pv="up" ${i === 0 ? "disabled" : ""}>↑</button>
      <button class="secondary" data-pv="down" ${i === order.length - 1 ? "disabled" : ""}>↓</button>
      <button class="secondary" data-pv="test">اختبار</button>
    </div>
    <div class="muted" id="pt_${id}" dir="ltr" style="text-align:left;font-size:12px"></div>`).join("");
  $("failover").checked = st.failover !== false;
}
$("providers").addEventListener("click", async e => {
  const b = e.target.closest("button[data-pv]"); if (!b) return;
  const id = b.closest("[data-pid]").dataset.pid, st = cfg.settings, o = st.providerOrder, i = o.indexOf(id);
  if (b.dataset.pv === "up" && i > 0) [o[i - 1], o[i]] = [o[i], o[i - 1]];
  else if (b.dataset.pv === "down" && i < o.length - 1) [o[i + 1], o[i]] = [o[i], o[i + 1]];
  else if (b.dataset.pv === "test") {
    const out = $("pt_" + id); out.textContent = "..."; b.disabled = true;
    try {
      if (dirty && !(await saveConfig())) return;
      const r = await api("/api/ptest", "POST", { id });
      out.innerHTML = r.ok ? `<span class="okc">✅ ${r.ms}ms</span> ` + r.sample.map(x => `${x.symbol} ${esc(x.price)} (${x.pct}%)`).join(" · ")
        : `<span class="err">❌ ${esc(r.error)}</span>`;
    } catch (er) { out.innerHTML = `<span class="err">❌ ${esc(er.message)}</span>`; }
    finally { b.disabled = false; }
    return;
  } else return;
  markDirty(); renderProviders();
});
$("providers").addEventListener("change", e => {
  const el = e.target.closest("[data-pv]"); if (!el) return;
  const id = el.closest("[data-pid]").dataset.pid, p = cfg.settings.providers[id] ||= {};
  if (el.dataset.pv === "enabled") p.enabled = el.checked;
  else if (el.dataset.pv === "base") p.base = el.value.trim();
  markDirty();
});
$("failover").addEventListener("change", () => { cfg.settings.failover = $("failover").checked; markDirty(); });

// محرر أزرار مشترك (للشبكة وللنشر الحر)
function makeBtnEditor(el, getList, onChange) {
  const render = () => {
    const list = getList();
    el.innerHTML = list.map((b, i) => `
      <div class="bcard">
        <select data-be="pick" data-i="${i}">
          <option value="">رابط مخصص</option>
          ${cfg.channels.map(c => `<option value="${c.id}" ${b.ch === c.id ? "selected" : ""}>قناة: ${esc(c.name)}</option>`).join("")}
        </select>
        <input data-be="text" data-i="${i}" value="${esc(b.text)}" placeholder="نص الزر">
        <input data-be="url" data-i="${i}" dir="ltr" value="${esc(b.url)}" placeholder="https://t.me/...">
        <div class="acts">
          <button class="secondary small" data-be="up" data-i="${i}" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="secondary small" data-be="down" data-i="${i}" ${i === list.length - 1 ? "disabled" : ""}>↓</button>
          <button class="danger small" data-be="del" data-i="${i}">✕</button>
        </div>
      </div>`).join("");
  };
  el.addEventListener("input", e => {
    const t = e.target.closest("input[data-be]"); if (!t) return;
    const b = getList()[Number(t.dataset.i)]; b[t.dataset.be] = t.value; delete b.ch; onChange();
  });
  el.addEventListener("change", e => {
    const t = e.target.closest("select[data-be=pick]"); if (!t) return;
    const b = getList()[Number(t.dataset.i)], c = cfg.channels.find(x => x.id === t.value);
    if (c) {
      b.ch = c.id; b.text = c.name; b.url = c.channelUrl || "https://t.me/";
      if (!c.channelUrl) notice("هذي القناة ما إلها «رابط القناة» ببطاقتها، اكتبه بالرابط.", "err");
    } else delete b.ch;
    onChange(); render();
  });
  el.addEventListener("click", e => {
    const t = e.target.closest("button[data-be]"); if (!t) return;
    const l = getList(), i = Number(t.dataset.i);
    if (t.dataset.be === "del") l.splice(i, 1);
    else if (t.dataset.be === "up" && i > 0) [l[i - 1], l[i]] = [l[i], l[i - 1]];
    else if (t.dataset.be === "down" && i < l.length - 1) [l[i + 1], l[i]] = [l[i], l[i + 1]];
    else return;
    onChange(); render();
  });
  return {
    render,
    addChannel() { const c = cfg.channels[0]; getList().push({ ch: c?.id, text: c?.name || "", url: c?.channelUrl || "https://t.me/" }); onChange(); render(); },
    addUrl() { getList().push({ text: "", url: "https://" }); onChange(); render(); },
    fillAll() {
      const l = getList(), have = new Set(l.map(b => b.ch));
      for (const c of cfg.channels) if (!have.has(c.id)) l.push({ ch: c.id, text: c.name, url: c.channelUrl || "https://t.me/" });
      onChange(); render();
    }
  };
}
const results = (r) => `<div class="diag">` + r.map(x => `
  <div class="row"><span>${x.ok ? (x.warn ? "⚠️" : "✅") : "❌"}</span><span class="u">${esc(x.name)}</span>
  <span class="${x.ok && !x.warn ? "okc" : "err"}">${esc(x.action || x.error)}</span></div>`).join("") + `</div>`;

// ---- تبويب الشبكة (منشور مثبت قابل للتعديل) ----
function net() { return cfg.network ||= { text: "", buttons: [], perRow: 2, channelIds: [] }; }
const netEd = makeBtnEditor($("netButtons"), () => net().buttons, () => markDirty());
function renderNetwork() {
  const n = net();
  $("netText").value = n.text;
  $("netPerRow").value = String(n.perRow || 2);
  netEd.render();
  $("netChannels").innerHTML = cfg.channels.map(c => `
    <label class="check"><input type="checkbox" data-nc="${c.id}" ${n.channelIds.includes(c.id) ? "checked" : ""}> ${esc(c.name)}</label>`).join("");
}
$("netText").addEventListener("input", () => { net().text = $("netText").value; markDirty(); });
$("netPerRow").addEventListener("change", () => { net().perRow = Number($("netPerRow").value); markDirty(); });
$("netChannels").addEventListener("change", e => {
  const el = e.target.closest("[data-nc]"); if (!el) return;
  const n = net(), id = el.dataset.nc;
  n.channelIds = n.channelIds.filter(x => x !== id);
  if (el.checked) n.channelIds.push(id);
  markDirty();
});
$("netAddCh").addEventListener("click", () => netEd.addChannel());
$("netAddUrl").addEventListener("click", () => netEd.addUrl());
$("netFillBtn").addEventListener("click", () => netEd.fillAll());
$("netPublish").addEventListener("click", async () => {
  const b = $("netPublish"); b.disabled = true; b.textContent = "جاري النشر...";
  try {
    if (dirty && !(await saveConfig())) return;
    const d = await api("/api/network", "POST", {});
    $("netOut").innerHTML = results(d.results);
  } catch (e) { notice(e.message, "err"); }
  finally { b.disabled = false; b.textContent = "حفظ، نشر وتثبيت"; }
});

// ---- تبويب النشر الحر (لمرة وحدة) ----
const post = { text: "", buttons: [], perRow: 2, pin: false, silent: false, all: false, channelIds: [], extra: [] };
const extraList = () => $("pExtra").value.split(/[\n,\s]+/).map(x => x.trim()).filter(Boolean);
const postEd = makeBtnEditor($("pButtons"), () => post.buttons, () => {});
function renderPost() {
  postEd.render();
  $("pPerRow").value = String(post.perRow);
  $("pPin").checked = post.pin; $("pSilent").checked = post.silent; $("pAll").checked = post.all;
  $("pChannels").innerHTML = cfg.channels.map(c => `
    <label class="check"><input type="checkbox" data-pc="${c.id}" ${post.all || post.channelIds.includes(c.id) ? "checked" : ""} ${post.all ? "disabled" : ""}> ${esc(c.name)}</label>`).join("");
}
$("pText").addEventListener("input", () => { post.text = $("pText").value; });
$("pPerRow").addEventListener("change", () => { post.perRow = Number($("pPerRow").value); });
$("pPin").addEventListener("change", () => { post.pin = $("pPin").checked; });
$("pSilent").addEventListener("change", () => { post.silent = $("pSilent").checked; });
$("pAll").addEventListener("change", () => { post.all = $("pAll").checked; renderPost(); });
$("pChannels").addEventListener("change", e => {
  const el = e.target.closest("[data-pc]"); if (!el) return;
  post.channelIds = post.channelIds.filter(x => x !== el.dataset.pc);
  if (el.checked) post.channelIds.push(el.dataset.pc);
});
$("pAddCh").addEventListener("click", () => postEd.addChannel());
$("pAddUrl").addEventListener("click", () => postEd.addUrl());
$("pFill").addEventListener("click", () => postEd.fillAll());
$("pPublish").addEventListener("click", async () => {
  post.extra = extraList();
  const n = (post.all ? cfg.channels.length : post.channelIds.length) + post.extra.length;
  if (!post.text.trim()) return notice("اكتب نص المنشور أولاً.", "err");
  if (!n) return notice("اختر قناة واحدة على الأقل.", "err");
  if (!confirm(`نشر المنشور بـ ${n} قناة${post.pin ? " مع التثبيت" : ""}؟`)) return;
  const b = $("pPublish"); b.disabled = true; b.textContent = "جاري النشر...";
  try {
    if (dirty && !(await saveConfig())) return;
    const d = await api("/api/post", "POST", { ...post, buttons: post.buttons.map(({ text, url }) => ({ text, url })) });
    $("pOut").innerHTML = results(d.results);
  } catch (e) { notice(e.message, "err"); }
  finally { b.disabled = false; b.textContent = "نشر الآن"; }
});

function renderAll() { renderChannels(); renderPost(); renderNetwork(); renderConnection(); renderProviders(); renderGeneral(); renderStatus(); clean(); }

// ---------- أحداث ----------
function onField(e) {
  const el = e.target;
  const path = el.dataset.path;
  if (!path || !cfg) return;
  const t = el.dataset.type;
  let v;
  if (t === "bool") v = el.checked;
  else if (t === "num") v = Number(el.value);
  else if (t === "symbols") v = el.value.split(/[\n,،\s]+/).filter(Boolean);
  else v = el.value;
  setPath(cfg, path, v);
  markDirty();
  if (path.endsWith(".format")) renderChannels();
}
$("channels").addEventListener("input", onField);
$("channels").addEventListener("change", onField);
$("paused").addEventListener("change", () => { cfg.paused = $("paused").checked; markDirty(); });
$("adminChatId").addEventListener("input", () => { cfg.adminChatId = $("adminChatId").value.trim(); markDirty(); });

document.querySelector(".tabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  document.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("on", x === b));
  ["status", "channels", "post", "network", "connection", "general"].forEach(t => { $("tab-" + t).hidden = t !== b.dataset.tab; });
  if (b.dataset.tab === "status") refreshStatus();
});

$("channels").addEventListener("toggle", e => {
  const d = e.target;
  if (d.matches && d.matches("details.card")) d.open ? openIds.add(d.dataset.id) : openIds.delete(d.dataset.id);
}, true);

function previewHtml(text) {
  const dec = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return text.split(/(<\/?b>)/).map(p => /^<\/?b>$/.test(p) ? p : esc(dec(p))).join("");
}

async function saveConfig() {
  try {
    const d = await api("/api/config", "POST", { config: cfg });
    cfg = d.config;
    renderAll();
    const s = await api("/api/state"); status = s.status; logs = s.logs; secrets = s.secrets; renderStatus();
    notice("تم الحفظ. التغييرات تطبق من الدقيقة القادمة.");
    return true;
  } catch (e) { notice(e.message, "err"); return false; }
}

$("channels").addEventListener("click", async e => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const act = b.dataset.act, i = Number(b.dataset.i), ch = cfg.channels[i];

  if (act === "add-level") {
    const box = b.closest(".sec");
    const sym = box.querySelector('[data-nl="symbol"]').value.trim();
    const price = Number(box.querySelector('[data-nl="price"]').value);
    const dir = box.querySelector('[data-nl="dir"]').value;
    if (!sym || !(price > 0)) return notice("اكتب العملة والسعر.", "err");
    ch.alerts.levels.push({ id: "lv_" + Math.random().toString(36).slice(2, 8), symbol: sym, dir, price, triggered: false });
    openIds.add(ch.id); markDirty(); renderChannels(); return;
  }
  if (act === "del-level") { ch.alerts.levels.splice(Number(b.dataset.j), 1); markDirty(); renderChannels(); return; }
  if (act === "rearm") { ch.alerts.levels[Number(b.dataset.j)].triggered = false; markDirty(); renderChannels(); return; }
  if (act === "remove") {
    if (!confirm(`حذف القناة "${ch.name}"؟`)) return;
    cfg.channels.splice(i, 1); markDirty(); renderChannels(); return;
  }

  // أوامر تعمل على الإعدادات المحفوظة: نحفظ أولاً
  b.disabled = true;
  try {
    if (dirty && !(await saveConfig())) return;
    const id = cfg.channels[i].id;
    const job = b.closest(".sec").querySelector('[data-role="job"]')?.value;
    if (act === "publish") {
      const d = await api("/api/publish", "POST", { channelId: id, job });
      notice(`تم النشر (#${d.message_id}).`);
    } else if (act === "preview") {
      const d = await api("/api/preview", "POST", { channelId: id, job });
      $("modalBody").innerHTML = d.messages.map(previewHtml).join("\n\n— — —\n\n");
      $("modal").hidden = false;
    } else if (act === "test") {
      const d = await api("/api/test", "POST", { channelId: id });
      notice(`وصلت رسالة التجربة (#${d.message_id}). الربط سليم.`);
    }
  } catch (err) { notice(err.message + hint(err.message), "err"); }
  finally { b.disabled = false; }
});

$("addPriceChannel").addEventListener("click", () => {
  const id = "ch_" + Math.random().toString(36).slice(2, 8);
  cfg.channels.push({
    id, name: "BTC price", enabled: true, chatId: "", channelUrl: "", buttonText: "",
    title: "BTC", symbols: ["BTCUSDT"], tzOffset: 3, provider: "auto", format: "price_only", priceTemplate: DEF_TPL, priceGrouping: false,
    showHighLow: false, showVolume: false, technicals: false,
    jobs: { price: { enabled: true, everyMinutes: 3 }, hourly: { enabled: false }, four_hour: { enabled: false },
      daily: { enabled: false, hour: 0 }, weekly: { enabled: false, day: 5, hour: 0 } },
    alerts: { moves: { enabled: false, percent: 3, minutes: 15, cooldown: 60 }, levels: [] }
  });
  openIds.add(id); markDirty(); renderChannels();
  document.querySelector('[data-id="' + id + '"]').scrollIntoView({ behavior: "smooth" });
});

$("addChannel").addEventListener("click", () => {
  const id = "ch_" + Math.random().toString(36).slice(2, 8);
  cfg.channels.push({
    id, name: "قناة جديدة", enabled: true, chatId: "", channelUrl: "", buttonText: "",
    title: "CRYPTO MARKET", symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"], tzOffset: 3,
    provider: "auto", format: "full", priceTemplate: DEF_TPL,
    showHighLow: true, showVolume: true, technicals: false,
    jobs: { price: { enabled: true, everyMinutes: 5 }, hourly: { enabled: true }, four_hour: { enabled: true },
      daily: { enabled: false, hour: 0 }, weekly: { enabled: false, day: 5, hour: 0 } },
    alerts: { moves: { enabled: false, percent: 3, minutes: 15, cooldown: 60 }, levels: [] }
  });
  openIds.add(id); markDirty(); renderChannels();
  document.querySelector('[data-id="' + id + '"]').scrollIntoView({ behavior: "smooth" });
});

$("saveBtn").addEventListener("click", async () => { $("saveBtn").disabled = true; if (!(await saveConfig())) markDirty(); });
$("connectBtn").addEventListener("click", connect);
$("modalClose").addEventListener("click", () => { $("modal").hidden = true; });
window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

// ---------- الاتصال ----------
$("endpoints").addEventListener("click", e => {
  const b = e.target.closest("button[data-ep]");
  if (!b) return;
  const i = Number(b.dataset.i), eps = cfg.settings.endpoints;
  if (b.dataset.ep === "del") eps.splice(i, 1);
  else if (b.dataset.ep === "up" && i > 0) [eps[i - 1], eps[i]] = [eps[i], eps[i - 1]];
  else if (b.dataset.ep === "down" && i < eps.length - 1) [eps[i + 1], eps[i]] = [eps[i], eps[i + 1]];
  markDirty(); renderConnection();
});
$("endpoints").addEventListener("change", e => {
  const el = e.target.closest("input[data-ep=toggle]");
  if (!el) return;
  cfg.settings.endpoints[Number(el.dataset.i)].enabled = el.checked;
  markDirty(); renderConnection();
});
$("addEndpoint").addEventListener("click", () => {
  const v = $("newEndpoint").value.trim().replace(/\/+$/, "");
  if (!/^https:\/\/\S+$/.test(v)) return notice("الرابط لازم يبدأ بـ https://", "err");
  if (cfg.settings.endpoints.some(x => x.url === v)) return notice("الرابط موجود.", "err");
  cfg.settings.endpoints.unshift({ url: v, enabled: true });
  $("newEndpoint").value = "";
  markDirty(); renderConnection();
});
$("timeoutMs").addEventListener("input", () => { cfg.settings.timeoutMs = Number($("timeoutMs").value); markDirty(); });
$("defaultsBtn").addEventListener("click", () => {
  if (!confirm("استرجاع قائمة الروابط الافتراضية؟")) return;
  cfg.settings.endpoints = ["https://data-api.binance.vision", "https://api.binance.com", "https://api-gcp.binance.com",
    "https://api1.binance.com", "https://api2.binance.com", "https://api3.binance.com", "https://api4.binance.com"]
    .map(url => ({ url, enabled: true }));
  markDirty(); renderConnection();
});
$("diagBtn").addEventListener("click", async () => {
  const b = $("diagBtn"); b.disabled = true; b.textContent = "جاري الفحص...";
  try {
    // الفحص على الروابط المحفوظة: نحفظ أول إذا في تغييرات
    if (dirty && !(await saveConfig())) return;
    const d = await api("/api/diagnose", "POST", {});
    const okAny = d.results.some(r => r.ok);
    const geo = d.results.some(r => r.status === 451 || r.status === 403);
    $("diagOut").innerHTML = `<div class="diag">` + d.results.map(r => `
      <div class="row"><span>${r.ok ? "✅" : "❌"}</span>
        <span class="u">${esc(r.url)}</span>
        <span class="${r.ok ? "okc" : "err"}" dir="ltr">${r.ok ? "OK" : esc(r.error || "HTTP " + r.status)}</span>
        <span class="muted">${r.ms}ms</span></div>`).join("") +
      (okAny ? `<p class="okc">فيه رابط شغال. البوت راح يستعمله تلقائياً.</p>`
        : geo ? `<p class="err">كل الروابط محجوبة (451/403): Binance تحجب منطقة سيرفر Cloudflare. أضف رابط وسيط (Proxy) بالأعلى.</p>`
        : `<p class="err">ما اتصل ولا رابط. جرب تعيد الفحص بعد دقائق أو زيد المهلة.</p>`) + `</div>`;
  } catch (e) { notice(e.message, "err"); }
  finally { b.disabled = false; b.textContent = "فحص كل الروابط"; }
});

$("tokenSave").addEventListener("click", async () => {
  const v = $("tokenInput").value.trim();
  if (!v) return notice("الصق التوكن أولاً.", "err");
  $("tokenSave").disabled = true;
  try {
    const d = await api("/api/secret", "POST", { telegramToken: v });
    secrets = d.secrets; $("tokenInput").value = ""; renderConnection();
    notice(`تم التحقق والحفظ${d.bot ? " (@" + d.bot + ")" : ""}.`);
  } catch (e) { notice(e.message, "err"); }
  finally { $("tokenSave").disabled = false; }
});
$("tokenClear").addEventListener("click", async () => {
  if (!confirm("حذف التوكن المحفوظ من اللوحة؟ (يرجع لتوكن Cloudflare إن وجد)")) return;
  try {
    const d = await api("/api/secret", "POST", { telegramToken: "" });
    secrets = d.secrets; renderConnection(); notice("تم الحذف.");
  } catch (e) { notice(e.message, "err"); }
});

loadCreds();
if ($("workerUrl").value && $("adminKey").value) connect();
