import type { Env } from "../env";
import { errorJson, passthrough } from "../core/http";

/**
 * Qingping (ClearGrass) developer API adapter.
 *
 * Vendor auth (again, inexpressible in Muse's single-value model):
 *   1. POST https://oauth.cleargrass.com/oauth2/token
 *        Authorization: Basic Base64(appKey:appSecret)
 *        body: grant_type=client_credentials&scope=<scope>
 *   2. GET  https://apis.cleargrass.com/v1/apis/... with
 *        Authorization: Bearer <access_token>, plus a `timestamp` (seconds)
 *        query parameter the vendor requires on API calls.
 * Access tokens live ~2 hours; we cache in KV when bound, else in-isolate,
 * and refresh a little early.
 * Ref: https://developer.qingping.co (personal developer API)
 */

const DEFAULT_OAUTH_BASE = "https://oauth.cleargrass.com";
const DEFAULT_API_BASE = "https://apis.cleargrass.com";
const KV_TOKEN_KEY = "qingping:access_token:v1";
const EXPIRY_SKEW_MS = 60_000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let isolateToken: CachedToken | null = null;

function base64(text: string): string {
  return btoa(text);
}

export interface AdapterContext {
  env: Env;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/**
 * Token acquisition failures are classified at the source, because the
 * runbook prescribes a different remedy for each kind and lumping them
 * together as "auth failed" sends the operator to reissue keys during
 * what is actually a vendor outage or a network failure:
 *   unreachable   — the fetch itself failed (network, DNS)
 *   auth          — the vendor refused the credentials (401/403)
 *   rate_limited  — the token endpoint answered 429
 *   client        — any other 4xx from the token endpoint
 *   server        — the vendor's token endpoint is failing (5xx, or a
 *                   response without a token)
 * The token cache is deliberately NOT in this list: caching is an
 * optimisation, so cache failures degrade to "no cache" / "not stored"
 * and never fail a request that could otherwise proceed.
 */
export type TokenFailureKind = "unreachable" | "auth" | "rate_limited" | "client" | "server" | "not_configured";

export class TokenFailure extends Error {
  readonly kind: TokenFailureKind;
  constructor(kind: TokenFailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

async function readCached(env: Env): Promise<CachedToken | null> {
  if (env.BRIDGE_KV) {
    let raw: string | null;
    try {
      raw = await env.BRIDGE_KV.get(KV_TOKEN_KEY);
    } catch {
      // Best-effort: a failed cache read is just a cache miss; a fresh
      // token can still be fetched.
      console.warn("qingping token cache read failed; treating as a miss");
      return null;
    }
    if (raw) {
      try {
        return JSON.parse(raw) as CachedToken;
      } catch {
        return null;
      }
    }
    return null;
  }
  return isolateToken;
}

async function writeCached(env: Env, token: CachedToken): Promise<void> {
  isolateToken = token;
  if (env.BRIDGE_KV) {
    const ttl = Math.max(60, Math.floor((token.expiresAt - Date.now()) / 1000));
    try {
      await env.BRIDGE_KV.put(KV_TOKEN_KEY, JSON.stringify(token), { expirationTtl: ttl });
    } catch {
      // Best-effort: the token itself is already in hand and usable;
      // failing to store it only costs a refetch next time.
      console.warn("qingping token cache write failed; continuing without caching");
    }
  }
}

export async function getQingpingAccessToken(ctx: AdapterContext, forceRefresh = false): Promise<string> {
  const { env } = ctx;
  const now = (ctx.now ?? Date.now)();
  if (!forceRefresh) {
    const cached = await readCached(env);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > now) return cached.accessToken;
  }
  if (!env.QINGPING_APP_KEY || !env.QINGPING_APP_SECRET) {
    throw new TokenFailure("not_configured", "adapter_not_configured");
  }
  const oauthBase = (env.QINGPING_OAUTH_BASE ?? DEFAULT_OAUTH_BASE).replace(/\/$/, "");
  const scope = env.QINGPING_SCOPE ?? "device";
  let res: Response;
  try {
    res = await (ctx.fetchFn ?? fetch)(`${oauthBase}/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${base64(`${env.QINGPING_APP_KEY}:${env.QINGPING_APP_SECRET}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope }).toString(),
    });
  } catch {
    throw new TokenFailure("unreachable", "token endpoint network error");
  }
  if (!res.ok) {
    if (res.status >= 500) throw new TokenFailure("server", `token_request_failed:${res.status}`);
    if (res.status === 429) throw new TokenFailure("rate_limited", "token_request_failed:429");
    if (res.status === 401 || res.status === 403) throw new TokenFailure("auth", `token_request_failed:${res.status}`);
    throw new TokenFailure("client", `token_request_failed:${res.status}`);
  }
  let data: { access_token?: string; expires_in?: number };
  try {
    data = (await res.json()) as { access_token?: string; expires_in?: number };
  } catch {
    throw new TokenFailure("server", "token response was not JSON");
  }
  if (!data.access_token) throw new TokenFailure("server", "token_missing_in_response");
  const expiresInSec = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 7200;
  const token: CachedToken = { accessToken: data.access_token, expiresAt: now + expiresInSec * 1000 };
  await writeCached(env, token);
  return token.accessToken;
}

/** Test hook. */
export function resetQingpingCacheForTest(): void {
  isolateToken = null;
}

async function call(ctx: AdapterContext, path: string, params: Record<string, string> = {}): Promise<Response> {
  const { env } = ctx;
  if (!env.QINGPING_APP_KEY || !env.QINGPING_APP_SECRET) {
    return errorJson(501, "adapter_not_configured", "Qingping credentials are not configured on the bridge");
  }
  const apiBase = (env.QINGPING_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, "");
  const doFetch = async (token: string): Promise<Response> => {
    const url = new URL(`${apiBase}${path}`);
    url.searchParams.set("timestamp", String(Math.floor((ctx.now ?? Date.now)() / 1000)));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return (ctx.fetchFn ?? fetch)(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
  };
  // Token acquisition and the data call fail differently, and the
  // runbook sends the operator to different remedies for each, so their
  // catches stay separate: a network failure on the data call is
  // vendor_unreachable, never "could not obtain a token".
  const authFailure = (err: unknown): Response => {
    if (err instanceof TokenFailure) {
      switch (err.kind) {
        case "not_configured":
          return errorJson(501, "adapter_not_configured", "Qingping credentials are not configured on the bridge");
        case "unreachable":
          return errorJson(502, "vendor_unreachable", "Could not reach the Qingping token endpoint (network error)");
        case "server":
          return errorJson(502, "vendor_server_error", `Qingping token endpoint is failing (${err.message})`);
        case "rate_limited":
          return errorJson(502, "vendor_rate_limited", "Qingping token endpoint is rate limiting the bridge (vendor status 429)");
        case "client":
          return errorJson(502, "vendor_client_error", `Qingping token endpoint rejected the request (${err.message})`);
        case "auth":
          return errorJson(502, "vendor_auth_failed", `Could not obtain a Qingping access token (${err.message})`);
      }
    }
    const message = err instanceof Error ? err.message : "unknown";
    return errorJson(502, "vendor_auth_failed", `Could not obtain a Qingping access token (${message})`);
  };
  const attempt = async (token: string): Promise<Response | null> => {
    try {
      return await doFetch(token);
    } catch {
      return null;
    }
  };

  let token: string;
  try {
    token = await getQingpingAccessToken(ctx);
  } catch (err) {
    return authFailure(err);
  }
  let res = await attempt(token);
  if (res === null) {
    return errorJson(502, "vendor_unreachable", "Could not reach the Qingping API (network error)");
  }
  if (res.status === 401) {
    // One retry with a fresh token; a second 401 is the vendor's answer.
    try {
      token = await getQingpingAccessToken(ctx, true);
    } catch (err) {
      return authFailure(err);
    }
    res = await attempt(token);
    if (res === null) {
      return errorJson(502, "vendor_unreachable", "Could not reach the Qingping API (network error)");
    }
  }
  return passthrough(res);
}

export const qingpingRoutes = {
  /** GET /qingping/devices */
  listDevices: (ctx: AdapterContext) => call(ctx, "/v1/apis/devices"),

  /**
   * GET /qingping/history?mac=...&start_time=...&end_time=...
   * Times are unix seconds, as the vendor API expects.
   */
  history: (ctx: AdapterContext, request: Request) => {
    const q = new URL(request.url).searchParams;
    const mac = q.get("mac");
    const start = q.get("start_time");
    const end = q.get("end_time");
    if (!mac || !start || !end) {
      return Promise.resolve(
        errorJson(400, "invalid_params", "Query parameters mac, start_time and end_time (unix seconds) are required"),
      );
    }
    const params: Record<string, string> = { mac, start_time: start, end_time: end };
    const offset = q.get("offset");
    const limit = q.get("limit");
    if (offset) params.offset = offset;
    if (limit) params.limit = limit;
    return call(ctx, "/v1/apis/history/data", params);
  },
};
