import { describe, expect, it } from "vitest";
import { authenticate, constantTimeEqual, loadTokens } from "../src/core/auth";
import { isBreakerOn, resetBreakerForTest, setBreaker } from "../src/core/breaker";
import { RateLimiter, parseRateLimit } from "../src/core/ratelimit";
import type { Env } from "../src/env";

const env: Env = {
  BRIDGE_TOKEN_READ: "read-token-aaa",
  BRIDGE_TOKEN_WRITE: "write-token-bbb",
  BRIDGE_TOKEN_ADMIN: "admin-token-ccc",
};

function req(token?: string): Request {
  return new Request("https://bridge.example/switchbot/devices", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("auth", () => {
  it("accepts each role token and reports its role", async () => {
    expect((await authenticate(req("read-token-aaa"), env))?.role).toBe("read");
    expect((await authenticate(req("write-token-bbb"), env))?.role).toBe("write");
    expect((await authenticate(req("admin-token-ccc"), env))?.role).toBe("admin");
  });

  it("rejects wrong, missing and malformed tokens", async () => {
    expect(await authenticate(req("read-token-aab"), env)).toBeNull();
    expect(await authenticate(req(), env)).toBeNull();
    expect(await authenticate(new Request("https://x/", { headers: { authorization: "Basic abc" } }), env)).toBeNull();
  });

  it("supports comma-separated rotation overlap and BRIDGE_TOKENS_JSON", () => {
    const tokens = loadTokens({
      BRIDGE_TOKEN_READ: "old,new",
      BRIDGE_TOKENS_JSON: JSON.stringify([{ token: "json-tok", role: "admin" }, { token: "bad", role: "root" }]),
    });
    expect(tokens).toContainEqual({ token: "old", role: "read" });
    expect(tokens).toContainEqual({ token: "new", role: "read" });
    expect(tokens).toContainEqual({ token: "json-tok", role: "admin" });
    expect(tokens.find((t) => t.token === "bad")).toBeUndefined();
  });

  it("constantTimeEqual compares by content", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  it("never exposes the token in the fingerprint", async () => {
    const result = await authenticate(req("read-token-aaa"), env);
    expect(result?.fingerprint).toBeTruthy();
    expect(result?.fingerprint).not.toContain("read-token");
  });
});

describe("rate limiter", () => {
  it("allows up to the limit per window, then refuses", () => {
    let now = 1_700_000_000_000;
    const limiter = new RateLimiter(3, () => now);
    expect(limiter.check("k")).toBe(true);
    expect(limiter.check("k")).toBe(true);
    expect(limiter.check("k")).toBe(true);
    expect(limiter.check("k")).toBe(false);
    expect(limiter.check("other")).toBe(true);
    now += 60_000;
    expect(limiter.check("k")).toBe(true);
  });

  it("parseRateLimit falls back on garbage", () => {
    expect(parseRateLimit("10")).toBe(10);
    expect(parseRateLimit("x")).toBe(60);
    expect(parseRateLimit(undefined)).toBe(60);
    expect(parseRateLimit("0")).toBe(0);
  });
});

describe("breaker KV robustness", () => {
  function kvStub(behavior: { get?: () => Promise<string | null>; put?: () => Promise<void> }): KVNamespace {
    return {
      get: behavior.get ?? (async () => null),
      put: behavior.put ?? (async () => undefined),
    } as unknown as KVNamespace;
  }

  it("a throwing KV read never takes the bridge down", async () => {
    resetBreakerForTest();
    const brokenEnv: Env = {
      BRIDGE_KV: kvStub({
        get: async () => {
          throw new Error("kv read limit exceeded");
        },
      }),
    };
    await expect(isBreakerOn(brokenEnv)).resolves.toBe(false);
  });

  it("reads the KV flag, and a throwing KV write reports not durable", async () => {
    resetBreakerForTest();
    const onEnv: Env = { BRIDGE_KV: kvStub({ get: async () => "1" }) };
    await expect(isBreakerOn(onEnv)).resolves.toBe(true);

    resetBreakerForTest();
    const putFails: Env = {
      BRIDGE_KV: kvStub({
        put: async () => {
          throw new Error("kv write failed");
        },
      }),
    };
    await expect(setBreaker(putFails, true)).resolves.toEqual({ durable: false });
    // The in-isolate state still flipped, so this isolate stops.
    await expect(isBreakerOn(putFails)).resolves.toBe(true);
    resetBreakerForTest();
  });

  it("caches the absent-key (null) case too, so fresh namespaces stop re-reading KV", async () => {
    resetBreakerForTest();
    let gets = 0;
    const freshEnv: Env = {
      BRIDGE_KV: kvStub({
        get: async () => {
          gets += 1;
          return null;
        },
      }),
    };
    await expect(isBreakerOn(freshEnv)).resolves.toBe(false);
    await expect(isBreakerOn(freshEnv)).resolves.toBe(false);
    expect(gets).toBe(1);
    resetBreakerForTest();
  });
});
