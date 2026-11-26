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
  let res: Response;
  try {
    res = await (ctx.fetchFn ?? fetch)(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
    });
  } catch {
    // A rejected fetch (network failure, DNS, ...) must not escape as an
    // unhandled exception: the runtime would answer a bare, non-JSON
    // 500 and the failure would be indistinguishable from a bridge bug.
    return errorJson(502, "vendor_unreachable", "Could not reach the SwitchBot API (network error)");
  }
  // SwitchBot also reports errors inside an HTTP 200 body, as
  // { statusCode: <not 100>, message: ... } (e.g. 161 = device offline).
  // Passing that through as success would hide failures from callers,
  // so surface it as a vendor error instead.
  if (res.status === 200) {
    try {
      const body = (await res.clone().json()) as { statusCode?: unknown; message?: unknown };
      if (typeof body?.statusCode === "number" && body.statusCode !== 100) {
        return errorJson(
          502,
          "vendor_error",
          `SwitchBot reported an error (statusCode ${body.statusCode}${typeof body.message === "string" ? `: ${body.message}` : ""})`,
        );
      }
    } catch {
      // Non-JSON body: passthrough below handles it.
    }
  }
  return passthrough(res);
}

/**
 * Write-surface allow-lists (default: deny everything).
 *
 * A write token must not become a universal remote: SwitchBot includes
 * locks and keypads, whose unlock commands would otherwise be one
 * leaked token away. Commands are allowed per (deviceId, command,
 * commandType) triple, scenes per scene id. Configure in wrangler.toml
 * [vars]:
 *   SWITCHBOT_ALLOWED_COMMANDS = "deviceId:turnOn,deviceId:turnOff"
 *   SWITCHBOT_ALLOWED_SCENES   = "sceneId1,sceneId2"
 * "*" matches any device / command on that side of the pair.
 *
 * The commandType segment matters: with commandType "customize", a
 * command name addresses a learned infrared custom button instead of
 * the device command of the same name. A two-segment entry therefore
 * allows commandType "command" only; "customize" must be written out
 * explicitly as a third segment:
 *   "deviceId:turnOn:customize"
 */
export function commandAllowed(
  raw: string | undefined,
  deviceId: string,
  command: string,
  commandType = "command",
): boolean {
  if (!raw) return false;
  for (const pair of raw.split(",")) {
    const parts = pair.split(":").map((s) => s.trim());
    if (parts.length < 2 || parts.length > 3) continue;
    const [device, cmd] = parts;
    const type = parts[2] ?? "command";
    if ((device === "*" || device === deviceId) && (cmd === "*" || cmd === command) && type === commandType) {
      return true;
    }
  }
  return false;
}

export function sceneAllowed(raw: string | undefined, sceneId: string): boolean {
  if (!raw) return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .some((s) => s === "*" || s === sceneId);
}

export const switchBotRoutes = {
  /** GET /switchbot/devices */
  listDevices: (ctx: AdapterContext) => call(ctx, "/v1.1/devices"),

  /** GET /switchbot/devices/:id/status */
  deviceStatus: (ctx: AdapterContext, deviceId: string) =>
    call(ctx, `/v1.1/devices/${encodeURIComponent(deviceId)}/status`),

  /** POST /switchbot/devices/:id/commands  body: {command, parameter?, commandType?} */
  async deviceCommand(ctx: AdapterContext, deviceId: string, request: Request): Promise<Response> {
    const { env } = ctx;
    if (!env.SWITCHBOT_TOKEN || !env.SWITCHBOT_SECRET) {
      return errorJson(501, "adapter_not_configured", "SwitchBot credentials are not configured on the bridge");
    }
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
    const rawType = (body as { commandType?: unknown }).commandType;
    if (rawType !== undefined && typeof rawType !== "string") {
      return errorJson(400, "invalid_command", "Field commandType must be a string when present");
    }
    const commandType = typeof rawType === "string" && rawType.length > 0 ? rawType : "command";
    if (!commandAllowed(env.SWITCHBOT_ALLOWED_COMMANDS, deviceId, rec.command, commandType)) {
      return errorJson(
        403,
        "command_not_allowed",
        `Command "${rec.command}" (${commandType}) for this device is not on the bridge allow-list (SWITCHBOT_ALLOWED_COMMANDS)`,
      );
    }
    // Deliberately an allow-listed shape, not a raw proxy: the bridge only
    // forwards the documented command envelope.
    const payload = {
      command: rec.command,
      parameter: (body as { parameter?: unknown }).parameter ?? "default",
      commandType,
    };
    return call(ctx, `/v1.1/devices/${encodeURIComponent(deviceId)}/commands`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  /** GET /switchbot/scenes */
  listScenes: (ctx: AdapterContext) => call(ctx, "/v1.1/scenes"),

  /** POST /switchbot/scenes/:id/execute */
  async executeScene(ctx: AdapterContext, sceneId: string): Promise<Response> {
    const { env } = ctx;
    if (!env.SWITCHBOT_TOKEN || !env.SWITCHBOT_SECRET) {
      return errorJson(501, "adapter_not_configured", "SwitchBot credentials are not configured on the bridge");
    }
    if (!sceneAllowed(env.SWITCHBOT_ALLOWED_SCENES, sceneId)) {
      return errorJson(
        403,
        "scene_not_allowed",
        "This scene is not on the bridge allow-list (SWITCHBOT_ALLOWED_SCENES)",
      );
    }
    return call(ctx, `/v1.1/scenes/${encodeURIComponent(sceneId)}/execute`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
};
