import type { Env } from "../env";
import { errorJson, passthrough } from "../core/http";

/**
 * SwitchBot OpenAPI v1.1 adapter.
 *
 * Vendor auth (the thing Muse's credential model cannot express):
 *   sign = Base64( HMAC-SHA256( secret, token + t + nonce ) )
 *   headers: Authorization: <token>, sign, t (ms epoch), nonce (uuid)
 * The secret is the HMAC key only — it never leaves the Worker.
 * Ref: https://github.com/OpenWonderLabs/SwitchBotAPI
 */

const DEFAULT_BASE = "https://api.switch-bot.com";

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function buildSwitchBotHeaders(
  token: string,
  secret: string,
  opts: { t?: number; nonce?: string } = {},
): Promise<Record<string, string>> {
  const t = opts.t ?? Date.now();
  const nonce = opts.nonce ?? crypto.randomUUID();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${token}${t}${nonce}`),
  );
  return {
    Authorization: token,
    sign: base64(new Uint8Array(sig)),
    t: String(t),
    nonce,
    "Content-Type": "application/json; charset=utf-8",
  };
}

export interface AdapterContext {
  env: Env;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

async function call(ctx: AdapterContext, path: string, init: RequestInit = {}): Promise<Response> {
  const { env } = ctx;
  if (!env.SWITCHBOT_TOKEN || !env.SWITCHBOT_SECRET) {
    return errorJson(501, "adapter_not_configured", "SwitchBot credentials are not configured on the bridge");
  }
  const headers = await buildSwitchBotHeaders(env.SWITCHBOT_TOKEN, env.SWITCHBOT_SECRET);
  const base = (env.SWITCHBOT_API_BASE ?? DEFAULT_BASE).replace(/\/$/, "");
  const res = await (ctx.fetchFn ?? fetch)(`${base}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  return passthrough(res);
}

export const switchBotRoutes = {
  /** GET /switchbot/devices */
  listDevices: (ctx: AdapterContext) => call(ctx, "/v1.1/devices"),

  /** GET /switchbot/devices/:id/status */
  deviceStatus: (ctx: AdapterContext, deviceId: string) =>
    call(ctx, `/v1.1/devices/${encodeURIComponent(deviceId)}/status`),

  /** POST /switchbot/devices/:id/commands  body: {command, parameter?, commandType?} */
  async deviceCommand(ctx: AdapterContext, deviceId: string, request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorJson(400, "invalid_json", "Request body must be JSON");
    }
    const rec = body as { command?: unknown };
    if (typeof rec?.command !== "string" || rec.command.length === 0) {
      return errorJson(400, "invalid_command", "Body must include a non-empty string field: command");
    }
    // Deliberately an allow-listed shape, not a raw proxy: the bridge only
    // forwards the documented command envelope.
    const payload = {
      command: rec.command,
      parameter: (body as { parameter?: unknown }).parameter ?? "default",
      commandType: (body as { commandType?: unknown }).commandType ?? "command",
    };
    return call(ctx, `/v1.1/devices/${encodeURIComponent(deviceId)}/commands`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  /** GET /switchbot/scenes */
  listScenes: (ctx: AdapterContext) => call(ctx, "/v1.1/scenes"),

  /** POST /switchbot/scenes/:id/execute */
  executeScene: (ctx: AdapterContext, sceneId: string) =>
    call(ctx, `/v1.1/scenes/${encodeURIComponent(sceneId)}/execute`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
};
