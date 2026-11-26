import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { resetBreakerForTest } from "../src/core/breaker";
import type { Env } from "../src/env";

const env: Env = {
  BRIDGE_TOKEN_READ: "read-tok",
  BRIDGE_TOKEN_WRITE: "write-tok",
  BRIDGE_TOKEN_ADMIN: "admin-tok",
  RATE_LIMIT_PER_MINUTE: "60",
  // No vendor credentials: adapter routes answer 501, which still proves
  // the request passed auth + role checks and reached the adapter.
};

function call(path: string, token?: string, method = "GET"): Promise<Response> {
  return worker.fetch(
    new Request(`https://bridge.example${path}`, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    env,
  );
}

describe("worker pipeline", () => {
  beforeEach(() => resetBreakerForTest());

  it("health is public", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
  });

  it("rejects missing token with 401", async () => {
    expect((await call("/switchbot/devices")).status).toBe(401);
  });

  it("read token reaches a read route (501 = adapter, not auth)", async () => {
    expect((await call("/switchbot/devices", "read-tok")).status).toBe(501);
  });

  it("read token cannot use a write route", async () => {
    const res = await call("/switchbot/devices/x/commands", "read-tok", "POST");
    expect(res.status).toBe(403);
  });

  it("write token can use a write route", async () => {
    const req = new Request("https://bridge.example/switchbot/devices/x/commands", {
      method: "POST",
      headers: { authorization: "Bearer write-tok", "content-type": "application/json" },
      body: JSON.stringify({ command: "turnOn" }),
    });
    expect((await worker.fetch(req, env)).status).toBe(501);
  });

  it("unknown routes are 404 after auth", async () => {
    expect((await call("/nope", "read-tok")).status).toBe(404);
    expect((await call("/nope")).status).toBe(401);
  });

  it("breaker stops everything, admin can flip it", async () => {
    const on = await call("/admin/breaker/on", "admin-tok", "POST");
    expect(on.status).toBe(200);
    expect((await call("/switchbot/devices", "read-tok")).status).toBe(503);
    expect((await call("/health")).status).toBe(503);
    const off = await call("/admin/breaker/off", "admin-tok", "POST");
    expect(off.status).toBe(200);
    expect((await call("/switchbot/devices", "read-tok")).status).toBe(501);
  });

  it("breaker cannot be flipped by a read token", async () => {
    expect((await call("/admin/breaker/on", "read-tok", "POST")).status).toBe(403);
  });

  it("static BRIDGE_DISABLED refuses even valid tokens", async () => {
    const disabledEnv: Env = { ...env, BRIDGE_DISABLED: "true" };
    const res = await worker.fetch(
      new Request("https://bridge.example/switchbot/devices", {
        headers: { authorization: "Bearer read-tok" },
      }),
      disabledEnv,
    );
    expect(res.status).toBe(503);
  });

  it("malformed percent-encoding in a path parameter is a 400, not a crash", async () => {
    const res = await call("/switchbot/devices/%E0%A4%A/status", "read-tok");
    expect(res.status).toBe(400);
  });
});
