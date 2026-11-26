import { beforeEach, describe, expect, it } from "vitest";
import { getQingpingAccessToken, qingpingRoutes, resetQingpingCacheForTest } from "../src/adapters/qingping";
import type { Env } from "../src/env";

const env: Env = { QINGPING_APP_KEY: "key123", QINGPING_APP_SECRET: "secret456" };

function mockFetch(calls: Array<{ url: string; init?: RequestInit }>, tokenResponses = 1) {
  let tokenCount = 0;
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("oauth.cleargrass.com")) {
      tokenCount += 1;
      if (tokenCount > tokenResponses && tokenResponses >= 0) {
        // still answer; tests assert on call counts instead
      }
      return new Response(JSON.stringify({ access_token: `at-${tokenCount}`, expires_in: 7200 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ code: 200, data: { devices: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("qingping adapter", () => {
  beforeEach(() => resetQingpingCacheForTest());

  it("requests a token with Basic auth and client_credentials grant", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const token = await getQingpingAccessToken({ env, fetchFn: mockFetch(calls) });
    expect(token).toBe("at-1");
    const authCall = calls[0]!;
    expect(authCall.url).toBe("https://oauth.cleargrass.com/oauth2/token");
    const headers = new Headers(authCall.init?.headers as Record<string, string>);
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("key123:secret456").toString("base64")}`);
    expect(String(authCall.init?.body)).toContain("grant_type=client_credentials");
  });

  it("caches the token across calls", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = mockFetch(calls);
    await getQingpingAccessToken({ env, fetchFn });
    await getQingpingAccessToken({ env, fetchFn });
    expect(calls.filter((c) => c.url.includes("oauth")).length).toBe(1);
  });

  it("calls the devices endpoint with Bearer token and timestamp", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const res = await qingpingRoutes.listDevices({ env, fetchFn: mockFetch(calls) });
    expect(res.status).toBe(200);
    const apiCall = calls.find((c) => c.url.includes("apis.cleargrass.com"))!;
    expect(apiCall.url).toContain("/v1/apis/devices");
    expect(apiCall.url).toMatch(/timestamp=\d{10}/);
    const headers = new Headers(apiCall.init?.headers as Record<string, string>);
    expect(headers.get("authorization")).toBe("Bearer at-1");
  });

  it("validates history parameters", async () => {
    const request = new Request("https://bridge.example/qingping/history?mac=AA");
    const res = await qingpingRoutes.history({ env, fetchFn: mockFetch([]) }, request);
    expect(res.status).toBe(400);
  });

  it("returns 501 when credentials are not configured", async () => {
    const res = await qingpingRoutes.listDevices({ env: {} });
    expect(res.status).toBe(501);
  });
});
