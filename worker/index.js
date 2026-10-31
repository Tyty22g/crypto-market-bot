import { json, cors, isAuthorized } from "./util.js";

export { Scheduler } from "./scheduler.js";

function scheduler(env) {
  return env.SCHEDULER.get(env.SCHEDULER.idFromName("main"));
}

async function call(env, path, body = {}) {
  const response = await scheduler(env).fetch(`https://scheduler/${path}`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
}

const ROUTES = {
  "GET /api/state": "state",
  "POST /api/config": "config",
  "POST /api/publish": "publish",
  "POST /api/preview": "preview",
  "POST /api/test": "test",
  "POST /api/tick": "tick"
};

async function handle(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (!url.pathname.startsWith("/api/")) {
    return json({ ok: true, service: "CRYPTO MARKET BOT", message: "Worker is running" });
  }

  if (!env.SCHEDULER) {
    return json({ ok: false, error: "Durable Object binding SCHEDULER غير موجود. تأكد من wrangler.toml" }, 500);
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

  // الكرون هنا "حارس": يتأكد أن المنبّه شغال وينفّذ أي موعد فائت. المواعيد نفسها تعمل بالمنبّه.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      call(env, "ensure").catch(e => console.error("ENSURE_FAILED:", e.message))
    );
  }
};
