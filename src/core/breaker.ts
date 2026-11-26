import type { Env } from "../env";

/**
 * The circuit breaker: one switch that refuses every request.
 *
 * This replaces the revocation machinery an OAuth facade would give us.
 * In a personal deployment you cannot reliably *notice* a leak, so a
 * lifecycle you cannot operate is theatre. What you can operate is one
 * obvious switch — flip it, then rotate keys at leisure.
 *
 * Sources, in order: static env (BRIDGE_DISABLED=true), KV flag (durable,
 * set via the admin API), in-isolate memory (admin API without KV).
 */
let isolateBreaker = false;

const KV_KEY = "breaker:v1";

export async function isBreakerOn(env: Env): Promise<boolean> {
  if ((env.BRIDGE_DISABLED ?? "").toLowerCase() === "true") return true;
  if (env.BRIDGE_KV) {
    const v = await env.BRIDGE_KV.get(KV_KEY);
    if (v !== null) return v === "1";
  }
  return isolateBreaker;
}

export async function setBreaker(env: Env, on: boolean): Promise<{ durable: boolean }> {
  isolateBreaker = on;
  if (env.BRIDGE_KV) {
    await env.BRIDGE_KV.put(KV_KEY, on ? "1" : "0");
    return { durable: true };
  }
  return { durable: false };
}

/** Test hook. */
export function resetBreakerForTest(): void {
  isolateBreaker = false;
}
