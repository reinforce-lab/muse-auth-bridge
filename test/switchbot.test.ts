import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSwitchBotHeaders, commandAllowed, sceneAllowed, switchBotRoutes } from "../src/adapters/switchbot";
import type { Env } from "../src/env";

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function commandRequest(command: string): Request {
  return new Request("https://bridge.example/", {
    method: "POST",
    body: JSON.stringify({ command }),
    headers: { "content-type": "application/json" },
  });
}

describe("switchbot signing", () => {
  it("matches the vendor algorithm: Base64(HMAC-SHA256(secret, token+t+nonce))", async () => {
    const token = "TOKEN123";
    const secret = "SECRET456";
    const t = 1661927531000;
    const nonce = "requestID";
    const headers = await buildSwitchBotHeaders(token, secret, { t, nonce });
    const expected = createHmac("sha256", secret).update(`${token}${t}${nonce}`, "utf-8").digest("base64");
    expect(headers.sign).toBe(expected);
    expect(headers.Authorization).toBe(token);
    expect(headers.t).toBe(String(t));
    expect(headers.nonce).toBe(nonce);
  });

  it("sends signed headers to the vendor devices endpoint", async () => {
    const env: Env = { SWITCHBOT_TOKEN: "tok", SWITCHBOT_SECRET: "sec" };
    let seenUrl = "";
    let seenHeaders: Headers | undefined;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenHeaders = new Headers(init?.headers as Record<string, string>);
      return new Response(JSON.stringify({ statusCode: 100, body: { deviceList: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await switchBotRoutes.listDevices({ env, fetchFn });
    expect(res.status).toBe(200);
    expect(seenUrl).toBe("https://api.switch-bot.com/v1.1/devices");
    expect(seenHeaders?.get("authorization")).toBe("tok");
    expect(seenHeaders?.get("sign")).toBeTruthy();
    expect(seenHeaders?.get("t")).toMatch(/^\d{13}$/);
  });

  it("returns 501 when credentials are not configured", async () => {
    const res = await switchBotRoutes.listDevices({ env: {} });
    expect(res.status).toBe(501);
  });

  it("rejects a command without a command field", async () => {
    const env: Env = { SWITCHBOT_TOKEN: "tok", SWITCHBOT_SECRET: "sec" };
    const request = new Request("https://bridge.example/", {
      method: "POST",
      body: JSON.stringify({ parameter: "x" }),
      headers: { "content-type": "application/json" },
    });
    const res = await switchBotRoutes.deviceCommand({ env }, "dev1", request);
    expect(res.status).toBe(400);
  });

  it("maps a vendor 401 to 502 vendor_auth_error, not the bridge's own 401", async () => {
    const env: Env = { SWITCHBOT_TOKEN: "tok", SWITCHBOT_SECRET: "sec" };
    const res = await switchBotRoutes.listDevices({ env, fetchFn: jsonFetch(401, { statusCode: 401, message: "Unauthorized" }) });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string }; vendorStatus: number };
    expect(body.error.code).toBe("vendor_auth_error");
    expect(body.vendorStatus).toBe(401);
  });

  it("surfaces an in-body vendor error (HTTP 200, statusCode != 100) as 502", async () => {
    const env: Env = { SWITCHBOT_TOKEN: "tok", SWITCHBOT_SECRET: "sec" };
    const res = await switchBotRoutes.listDevices({
      env,
      fetchFn: jsonFetch(200, { statusCode: 161, message: "device offline" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("vendor_error");
    expect(body.error.message).toContain("161");
  });
});

describe("switchbot write allow-lists", () => {
  it("commandAllowed parses pairs and wildcards, default deny", () => {
    expect(commandAllowed(undefined, "dev1", "turnOn")).toBe(false);
    expect(commandAllowed("", "dev1", "turnOn")).toBe(false);
    expect(commandAllowed("dev1:turnOn", "dev1", "turnOn")).toBe(true);
    expect(commandAllowed("dev1:turnOn", "dev1", "unlock")).toBe(false);
    expect(commandAllowed("dev1:turnOn", "dev2", "turnOn")).toBe(false);
    expect(commandAllowed("dev1:turnOn, dev1:turnOff", "dev1", "turnOff")).toBe(true);
    expect(commandAllowed("*:turnOn", "dev9", "turnOn")).toBe(true);
    expect(commandAllowed("dev1:*", "dev1", "unlock")).toBe(true);
  });

  it("sceneAllowed is default deny", () => {
    expect(sceneAllowed(undefined, "s1")).toBe(false);
    expect(sceneAllowed("s1,s2", "s2")).toBe(true);
    expect(sceneAllowed("s1,s2", "s3")).toBe(false);
    expect(sceneAllowed("*", "s3")).toBe(true);
  });

  it("deviceCommand refuses commands that are not allow-listed", async () => {
    const env: Env = { SWITCHBOT_TOKEN: "tok", SWITCHBOT_SECRET: "sec" };
    const fetchFn = jsonFetch(200, { statusCode: 100, body: {} });
    const denied = await switchBotRoutes.deviceCommand({ env, fetchFn }, "dev1", commandRequest("unlock"));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("command_not_allowed");
  });

  it("deviceCommand forwards allow-listed commands", async () => {
    const env: Env = {
      SWITCHBOT_TOKEN: "tok",
      SWITCHBOT_SECRET: "sec",
      SWITCHBOT_ALLOWED_COMMANDS: "dev1:turnOn",
    };
    const fetchFn = jsonFetch(200, { statusCode: 100, body: {} });
    const res = await switchBotRoutes.deviceCommand({ env, fetchFn }, "dev1", commandRequest("turnOn"));
    expect(res.status).toBe(200);
    const other = await switchBotRoutes.deviceCommand({ env, fetchFn }, "dev1", commandRequest("turnOff"));
    expect(other.status).toBe(403);
  });

  it("executeScene refuses scenes that are not allow-listed", async () => {
    const env: Env = { SWITCHBOT_TOKEN: "tok", SWITCHBOT_SECRET: "sec" };
    const res = await switchBotRoutes.executeScene({ env, fetchFn: jsonFetch(200, { statusCode: 100 }) }, "scene1");
    expect(res.status).toBe(403);
    const allowedEnv: Env = { ...env, SWITCHBOT_ALLOWED_SCENES: "scene1" };
    const ok = await switchBotRoutes.executeScene({ env: allowedEnv, fetchFn: jsonFetch(200, { statusCode: 100 }) }, "scene1");
    expect(ok.status).toBe(200);
  });

  it("maps a vendor 429 to 502 vendor_rate_limited, not the bridge's own 429", async () => {
    const env: Env = { SWITCHBOT_TOKEN: "tok", SWITCHBOT_SECRET: "sec" };
    const res = await switchBotRoutes.listDevices({ env, fetchFn: jsonFetch(429, { message: "rate limited" }) });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string }; vendorStatus: number };
    expect(body.error.code).toBe("vendor_rate_limited");
    expect(body.vendorStatus).toBe(429);
  });

  it("maps a vendor 500 to 502 vendor_server_error, keeping status-based triage clean", async () => {
    const env: Env = { SWITCHBOT_TOKEN: "tok", SWITCHBOT_SECRET: "sec" };
    const res = await switchBotRoutes.listDevices({ env, fetchFn: jsonFetch(500, { message: "boom" }) });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string }; vendorStatus: number };
    expect(body.error.code).toBe("vendor_server_error");
    expect(body.vendorStatus).toBe(500);
  });

  it("a rejected vendor fetch becomes 502 vendor_unreachable, not an unhandled exception", async () => {
    const env: Env = { SWITCHBOT_TOKEN: "tok", SWITCHBOT_SECRET: "sec" };
    const throwingFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const res = await switchBotRoutes.listDevices({ env, fetchFn: throwingFetch });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("vendor_unreachable");
  });

  it("commandType is part of the allow-list key: customize needs an explicit entry", async () => {
    expect(commandAllowed("dev1:turnOn", "dev1", "turnOn")).toBe(true);
    expect(commandAllowed("dev1:turnOn", "dev1", "turnOn", "customize")).toBe(false);
    expect(commandAllowed("dev1:turnOn:customize", "dev1", "turnOn", "customize")).toBe(true);
    expect(commandAllowed("dev1:turnOn:customize", "dev1", "turnOn")).toBe(false);

    const base: Env = {
      SWITCHBOT_TOKEN: "tok",
      SWITCHBOT_SECRET: "sec",
      SWITCHBOT_ALLOWED_COMMANDS: "dev1:turnOn",
    };
    const fetchFn = jsonFetch(200, { statusCode: 100, body: {} });
    const customizeReq = new Request("https://bridge.example/", {
      method: "POST",
      body: JSON.stringify({ command: "turnOn", commandType: "customize" }),
      headers: { "content-type": "application/json" },
    });
    expect((await switchBotRoutes.deviceCommand({ env: base, fetchFn }, "dev1", customizeReq)).status).toBe(403);

    const explicit: Env = { ...base, SWITCHBOT_ALLOWED_COMMANDS: "dev1:turnOn:customize" };
    const customizeReq2 = new Request("https://bridge.example/", {
      method: "POST",
      body: JSON.stringify({ command: "turnOn", commandType: "customize" }),
      headers: { "content-type": "application/json" },
    });
    expect((await switchBotRoutes.deviceCommand({ env: explicit, fetchFn }, "dev1", customizeReq2)).status).toBe(200);
  });
});
