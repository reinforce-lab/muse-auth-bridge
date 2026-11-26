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

  it("reports a token-endpoint network failure as vendor_unreachable, not an auth failure", async () => {
    const throwingFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const res = await qingpingRoutes.listDevices({ env, fetchFn: throwingFetch });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("vendor_unreachable");
  });

  it("classifies token-endpoint statuses: 401 is auth, 503 is the vendor's server", async () => {
    const statusFetch = (status: number) =>
      (async () =>
        new Response(JSON.stringify({ message: "x" }), {
          status,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
    const authRes = await qingpingRoutes.listDevices({ env, fetchFn: statusFetch(401) });
    expect(authRes.status).toBe(502);
    expect(((await authRes.json()) as { error: { code: string } }).error.code).toBe("vendor_auth_failed");
    const serverRes = await qingpingRoutes.listDevices({ env, fetchFn: statusFetch(503) });
    expect(serverRes.status).toBe(502);
    expect(((await serverRes.json()) as { error: { code: string } }).error.code).toBe("vendor_server_error");
  });

  it("treats token cache (KV) failures as best-effort and still serves the request", async () => {
    const kvEnv: Env = {
      ...env,
      BRIDGE_KV: {
        get: async () => {
          throw new Error("kv down");
        },
        put: async () => {
          throw new Error("kv down");
        },
      } as unknown as KVNamespace,
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const res = await qingpingRoutes.listDevices({ env: kvEnv, fetchFn: mockFetch(calls) });
    expect(res.status).toBe(200);
    // The read failure was a miss, so a fresh token was fetched and used.
    expect(calls.some((c) => c.url.includes("oauth.cleargrass.com"))).toBe(true);
    expect(calls.some((c) => c.url.includes("apis.cleargrass.com"))).toBe(true);
  });

  it("classifies a token-endpoint 429 as vendor_rate_limited and other 4xx as vendor_client_error", async () => {
    const statusFetch = (status: number) =>
      (async () =>
        new Response(JSON.stringify({ message: "x" }), {
          status,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
    const limited = await qingpingRoutes.listDevices({ env, fetchFn: statusFetch(429) });
    expect(limited.status).toBe(502);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("vendor_rate_limited");
    const client = await qingpingRoutes.listDevices({ env, fetchFn: statusFetch(400) });
    expect(client.status).toBe(502);
    expect(((await client.json()) as { error: { code: string } }).error.code).toBe("vendor_client_error");
  });

  it("reports a data-endpoint network failure as vendor_unreachable, not an auth failure", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("oauth.cleargrass.com")) {
        return new Response(JSON.stringify({ access_token: "at-1", expires_in: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const res = await qingpingRoutes.listDevices({ env, fetchFn });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("vendor_unreachable");
  });

  it("returns 501 when credentials are not configured", async () => {
    const res = await qingpingRoutes.listDevices({ env: {} });
    expect(res.status).toBe(501);
  });
});
