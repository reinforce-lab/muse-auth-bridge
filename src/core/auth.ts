import type { Env, Role } from "../env";

/**
 * Bearer authentication with role-separated tokens.
 *
 * Why hashing first: comparing raw secrets with a hand-rolled loop leaks
 * length and early-exit timing. We SHA-256 both sides and compare the
 * fixed-length digests in constant time, so the comparison itself reveals
 * nothing about the configured tokens.
 */

async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // crypto.subtle.timingSafeEqual exists in Workers; fall back to a
  // non-short-circuiting loop in plain Node (tests).
  const subtle = crypto.subtle as unknown as {
    timingSafeEqual?: (x: Uint8Array, y: Uint8Array) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export interface TokenEntry {
  token: string;
  role: Role;
}

const VALID_ROLES: Role[] = ["read", "write", "admin"];

export function loadTokens(env: Env): TokenEntry[] {
  const entries: TokenEntry[] = [];
  if (env.BRIDGE_TOKENS_JSON) {
    try {
      const parsed = JSON.parse(env.BRIDGE_TOKENS_JSON) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const rec = item as { token?: unknown; role?: unknown };
          if (typeof rec.token === "string" && rec.token.length > 0 && VALID_ROLES.includes(rec.role as Role)) {
            entries.push({ token: rec.token, role: rec.role as Role });
          }
        }
      }
    } catch {
      // A malformed JSON secret must not silently widen access; ignore it.
    }
  }
  const singles: Array<[string | undefined, Role]> = [
    [env.BRIDGE_TOKEN_READ, "read"],
    [env.BRIDGE_TOKEN_WRITE, "write"],
    [env.BRIDGE_TOKEN_ADMIN, "admin"],
  ];
  for (const [value, role] of singles) {
    if (!value) continue;
    for (const token of value.split(",").map((s) => s.trim()).filter(Boolean)) {
      entries.push({ token, role });
    }
  }
  return entries;
}

export interface AuthResult {
  role: Role;
  /** Short fingerprint for rate-limit keys and logs. Never the token itself. */
  fingerprint: string;
}

export async function authenticate(request: Request, env: Env): Promise<AuthResult | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return null;
  const presented = match[1].trim();
  const presentedDigest = await sha256(presented);

  let found: AuthResult | null = null;
  for (const entry of loadTokens(env)) {
    const digest = await sha256(entry.token);
    if (constantTimeEqual(presentedDigest, digest)) {
      // Do not break: keep loop shape independent of which entry matched.
      found = { role: entry.role, fingerprint: await fingerprintOf(presentedDigest) };
    }
  }
  return found;
}

async function fingerprintOf(digest: Uint8Array): Promise<string> {
  return Array.from(digest.slice(0, 4)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
