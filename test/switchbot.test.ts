import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSwitchBotHeaders, switchBotRoutes } from "../src/adapters/switchbot";
import type { Env } from "../src/env";

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
});
