import { json, cors, isAuthorized } from "./util.js";
import { engine } from "./engine.js";

function call(env, path, body = {}) {
  return engine.handle(env, path, body);
}

const ROUTES = {
  "GET /api/state": "state",
  "POST /api/config": "config",
  "POST /api/publish": "publish",
  "POST /api/preview": "preview",
  "POST /api/test": "test",
  "POST /api/diagnose": "diagnose",
  "POST /api/secret": "secret",
  "POST /api/ptest": "ptest",
  "POST /api/tick": "tick"
};

async function handle(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (!url.pathname.startsWith("/api/")) {
    return json({ ok: true, service: "CRYPTO MARKET BOT", message: "Worker is running" });
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";

  if ((await call(env, "authcheck", { ip })).data.blocked) {
    return json({ ok: false, error: "محاولات كثيرة خاطئة. انتظر 10 دقائق." }, 429);
  }

  if (!isAuthorized(request, env)) {
    await call(env, "authfail", { ip });
    return json({ ok: false, error: "مفتاح ADMIN_KEY غير صحيح" }, 401);
  }

  const route = ROUTES[`${request.method} ${url.pathname}`];
  if (!route) return json({ ok: false, error: "NOT_FOUND" }, 404);

  let body = {};
  if (request.method === "POST") {
    try { body = await request.json(); } catch { body = {}; }
  }

  const { status, data } = await call(env, route, body);
  return json(data, status);
}

export default {
  async fetch(request, env) {
    try {
      return cors(await handle(request, env));
    } catch (error) {
      console.error("WORKER_ERROR:", error.message);
      return cors(json({ ok: false, error: error.message || "Unknown error" }, 500));
    }
  },

  // كرون واحد كل دقيقة (نفس طريقة النسخة القديمة الشغالة): الكود يقرر شنو ينشر
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      call(env, "tick", { at: controller.scheduledTime || Date.now() })
        .then(r => { if (!r.data.ok) console.error("TICK_FAILED:", r.data.error); })
        .catch(e => console.error("TICK_FAILED:", e.message))
    );
  }
};
