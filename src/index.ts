import type { Env, Role } from "./env";
import { roleSatisfies } from "./env";
import { authenticate } from "./core/auth";
import { isBreakerOn, setBreaker } from "./core/breaker";
import { RateLimiter, parseRateLimit } from "./core/ratelimit";
import { errorJson, json } from "./core/http";
import { switchBotRoutes } from "./adapters/switchbot";
import { qingpingRoutes } from "./adapters/qingping";

/**
 * Muse Auth Bridge — entry point.
 *
 * Pipeline for every non-public request:
 *   breaker check -> Bearer auth (role) -> rate limit -> adapter route
 * Routes are an allow-list, never an open proxy: the set of vendor calls a
 * stolen token can reach is exactly the set written here.
 */

const limiterCache = new Map<number, RateLimiter>();
function limiterFor(env: Env): RateLimiter {
  const limit = parseRateLimit(env.RATE_LIMIT_PER_MINUTE);
  let limiter = limiterCache.get(limit);
  if (!limiter) {
    limiter = new RateLimiter(limit);
    limiterCache.set(limit, limiter);
  }
  return limiter;
}

interface Route {
  method: string;
  pattern: RegExp;
  requiredRole: Role;
  handler: (ctx: { env: Env; request: Request }, params: string[]) => Promise<Response>;
}

const ROUTES: Route[] = [
  // SwitchBot (read)
  { method: "GET", pattern: /^\/switchbot\/devices$/, requiredRole: "read",
    handler: (ctx) => switchBotRoutes.listDevices(ctx) },
  { method: "GET", pattern: /^\/switchbot\/devices\/([^/]+)\/status$/, requiredRole: "read",
    handler: (ctx, [id]) => switchBotRoutes.deviceStatus(ctx, id!) },
  { method: "GET", pattern: /^\/switchbot\/scenes$/, requiredRole: "read",
    handler: (ctx) => switchBotRoutes.listScenes(ctx) },
  // SwitchBot (write)
  { method: "POST", pattern: /^\/switchbot\/devices\/([^/]+)\/commands$/, requiredRole: "write",
    handler: (ctx, [id]) => switchBotRoutes.deviceCommand(ctx, id!, ctx.request) },
  { method: "POST", pattern: /^\/switchbot\/scenes\/([^/]+)\/execute$/, requiredRole: "write",
    handler: (ctx, [id]) => switchBotRoutes.executeScene(ctx, id!) },
  // Qingping (read only in v1)
  { method: "GET", pattern: /^\/qingping\/devices$/, requiredRole: "read",
    handler: (ctx) => qingpingRoutes.listDevices(ctx) },
  { method: "GET", pattern: /^\/qingping\/history$/, requiredRole: "read",
    handler: (ctx) => qingpingRoutes.history(ctx, ctx.request) },
  // Admin
  { method: "GET", pattern: /^\/admin\/status$/, requiredRole: "admin",
    handler: async (ctx) => json({ breakerOn: await isBreakerOn(ctx.env), service: "muse-auth-bridge" }) },
  { method: "POST", pattern: /^\/admin\/breaker\/(on|off)$/, requiredRole: "admin",
    handler: async (ctx, [mode]) => {
      const on = mode === "on";
      const { durable } = await setBreaker(ctx.env, on);
      return json({ breakerOn: on, durable });
    } },
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Public surface: exactly two routes, no data behind them.
    if (request.method === "GET" && path === "/health") {
      const on = await isBreakerOn(env);
      return json({ ok: !on, service: "muse-auth-bridge", breakerOn: on }, on ? 503 : 200);
    }
    if (request.method === "GET" && path === "/") {
      return json({
        service: "muse-auth-bridge",
        description: "Auth translation layer: one Bearer token in, signed vendor requests out.",
        routes: [
          "GET  /health",
          "GET  /switchbot/devices            (read)",
          "GET  /switchbot/devices/:id/status (read)",
          "POST /switchbot/devices/:id/commands (write)",
          "GET  /switchbot/scenes             (read)",
          "POST /switchbot/scenes/:id/execute (write)",
          "GET  /qingping/devices             (read)",
          "GET  /qingping/history?mac=&start_time=&end_time= (read)",
          "GET  /admin/status                 (admin)",
          "POST /admin/breaker/on|off         (admin)",
        ],
      });
    }

    // 1. Breaker — before auth, so a flipped switch stops even valid tokens.
    //    One deliberate exception: the admin breaker routes themselves.
    //    A switch you cannot release is a trap, not a brake; those routes
    //    still require the admin token below.
    const isBreakerRoute = path.startsWith("/admin/breaker/");
    if (!isBreakerRoute && (await isBreakerOn(env))) {
      return errorJson(503, "breaker_on", "The bridge is stopped by its circuit breaker");
    }

    // 2. Auth
    const auth = await authenticate(request, env);
    if (!auth) return errorJson(401, "unauthorized", "Missing or invalid Bearer token");

    // 3. Rate limit (per token fingerprint)
    if (!limiterFor(env).check(auth.fingerprint)) {
      return errorJson(429, "rate_limited", "Too many requests for this token");
    }

    // 4. Route (allow-list)
    for (const route of ROUTES) {
      if (route.method !== request.method) continue;
      const match = route.pattern.exec(path);
      if (!match) continue;
      if (!roleSatisfies(auth.role, route.requiredRole)) {
        return errorJson(403, "forbidden", `This route requires the ${route.requiredRole} role`);
      }
      return route.handler({ env, request }, match.slice(1).map((g) => decodeURIComponent(g ?? "")));
    }
    return errorJson(404, "not_found", "No such route on the bridge");
  },
};
