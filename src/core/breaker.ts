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
 *
 * Robustness rules (learned from review, 2026-11-26):
 * - The breaker check runs before auth on every request, so a KV read
 *   failure must never take the bridge down. KV errors fall back to the
 *   last known state, then to the in-isolate flag.
 * - KV reads are cached for a few seconds per isolate. Breaker flips
 *   already propagate through KV with up to ~60s of eventual
 *   consistency, so a 3s cache changes nothing operationally, but it
 *   keeps unauthenticated traffic from amplifying into KV reads.
 */
let isolateBreaker = false;
let kvCache: { value: boolean; at: number } | null = null;

const KV_KEY = "breaker:v1";
const CACHE_MS = 3_000;

export async function isBreakerOn(env: Env): Promise<boolean> {
  if ((env.BRIDGE_DISABLED ?? "").toLowerCase() === "true") return true;
  if (env.BRIDGE_KV) {
    const now = Date.now();
    if (kvCache && now - kvCache.at < CACHE_MS) return kvCache.value;
    try {
      const v = await env.BRIDGE_KV.get(KV_KEY);
      // Cache the absent key too: on a fresh namespace the flag has
      // never been written, and without caching that case every
      // unauthenticated request would still hit KV.
      kvCache = { value: v === "1", at: now };
      return kvCache.value;
    } catch {
      if (kvCache) return kvCache.value;
    }
  }
  return isolateBreaker;
}

export async function setBreaker(env: Env, on: boolean): Promise<{ durable: boolean }> {
  isolateBreaker = on;
  kvCache = { value: on, at: Date.now() };
  if (env.BRIDGE_KV) {
    try {
      await env.BRIDGE_KV.put(KV_KEY, on ? "1" : "0");
      return { durable: true };
    } catch {
      return { durable: false };
    }
  }
  return { durable: false };
}

/** Test hook. */
export function resetBreakerForTest(): void {
  isolateBreaker = false;
  kvCache = null;
}
