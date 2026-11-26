/** Environment bindings for the Worker. Secrets arrive via `wrangler secret put`. */
export interface Env {
  // Bridge tokens (secrets). One per role; comma-separate to allow rotation overlap.
  BRIDGE_TOKEN_READ?: string;
  BRIDGE_TOKEN_WRITE?: string;
  BRIDGE_TOKEN_ADMIN?: string;
  /** Alternative / override: JSON array of { "token": "...", "role": "read" } */
  BRIDGE_TOKENS_JSON?: string;

  // Common core (vars)
  BRIDGE_DISABLED?: string;
  RATE_LIMIT_PER_MINUTE?: string;

  // SwitchBot adapter (secrets)
  SWITCHBOT_TOKEN?: string;
  SWITCHBOT_SECRET?: string;
  SWITCHBOT_API_BASE?: string;

  // Qingping adapter (secrets + var)
  QINGPING_APP_KEY?: string;
  QINGPING_APP_SECRET?: string;
  QINGPING_SCOPE?: string;
  QINGPING_OAUTH_BASE?: string;
  QINGPING_API_BASE?: string;

  // Optional durable state (breaker flag, Qingping token cache)
  BRIDGE_KV?: KVNamespace;
}

export type Role = "read" | "write" | "admin";

/** Role ordering: admin can do everything, write includes read. */
export const ROLE_RANK: Record<Role, number> = { read: 1, write: 2, admin: 3 };

export function roleSatisfies(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
