export const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function cors(response) {
  const h = new Headers(response.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET, POST, OPTIONS");
  h.set("access-control-allow-headers", "Content-Type, Authorization");
  return new Response(response.body, { status: response.status, headers: h });
}

// مقارنة ثابتة الزمن لمفتاح الإدارة
export function isAuthorized(request, env) {
  const supplied = request.headers.get("authorization") || "";
  const expected = env.ADMIN_KEY ? `Bearer ${env.ADMIN_KEY}` : "";
  if (!expected || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function uid(prefix = "ch") {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function fmt(value, digits = 8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  if (digits <= 0) return Math.round(n).toLocaleString("en-US");
  const safe = Math.max(1, Math.min(21, Math.floor(digits)));
  return n.toLocaleString("en-US", { maximumSignificantDigits: safe });
}

export function signed(value, suffix = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  return `${n > 0 ? "+" : ""}${fmt(n)}${suffix}`;
}

// الوقت المعروض في المنشور حسب فرق التوقيت الخاص بالقناة
export function formatTime(now, offsetHours = 0) {
  const d = new Date(now + offsetHours * 3600000);
  const base = d.toISOString().slice(0, 16).replace("T", " ");
  const label = offsetHours === 0
    ? "UTC"
    : `UTC${offsetHours > 0 ? "+" : ""}${offsetHours}`;
  return `${base} ${label}`;
}

// بداية الفترة الحالية بتوقيت القناة. anchor = إزاحة داخل الفترة (مثلاً ساعة التقرير اليومي)
export function slotStart(now, periodMs, anchorMs, tzMs) {
  const local = now + tzMs;
  const start = Math.floor((local - anchorMs) / periodMs) * periodMs + anchorMs;
  return start - tzMs;
}
