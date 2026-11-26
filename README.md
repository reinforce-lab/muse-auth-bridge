# Muse Auth Bridge

An authentication translation layer for personal AI agents.

Some vendor APIs cannot be used from an agent platform whose credential
model only supports **presenting one static value** (a single API key, or an
OAuth2 Bearer token). APIs that need a *pair* of secrets, or a *per-request
signature computed from a secret* — SwitchBot (token + HMAC secret),
Qingping (App Key + App Secret), and many others — fall off that model
entirely. Not because they are exotic, but because of where the line is
drawn:

> A credential system that hands a surrogate value to be substituted at
> send time can carry anything **presentable**. It cannot carry anything
> that must be **computed with** — a secret that is an input to a
> calculation never reaches the code that would calculate.

This bridge redraws the line. It runs on Cloudflare Workers as *your own*
thin layer:

```
Muse (custom connector)          this bridge                     vendor API
─────────────────────────        ──────────────────────          ─────────────
holds ONE Bearer token    ───►   common core + adapters    ───►   receives a properly
no vendor knowledge              signs / exchanges tokens         signed request
```

The vendor secrets live only in the Worker (as encrypted Worker secrets).
From the agent platform's point of view, the bridge is just "an API that
takes a Bearer token" — which its credential model handles natively.

## Design decisions worth arguing with

**Allow-list, not a proxy.** The bridge exposes a fixed set of routes
(see below). A leaked token can only ever reach those routes, with those
shapes. An open proxy would make the token a skeleton key; an allow-list
makes it a key to a few named doors.

**Roles, read-first.** Tokens are separated by role (`read` / `write` /
`admin`). Day-to-day agent work uses a read token. Write routes (e.g.
sending a device command) require the write token; the breaker requires
admin. Keep the powerful tokens out of the config you paste everywhere.

**A breaker instead of a lifecycle.** An OAuth facade around everything
was considered and rejected for personal use: revocation only helps if
you *notice* a leak, and a single operator usually cannot. What one
person can operate is one obvious switch. Every request passes a single
gate, so one flip — `POST /admin/breaker/on`, or the `BRIDGE_DISABLED`
variable — stops all services at once. Rotate keys afterwards, at leisure.

**Replay is accepted, and bounded.** With static presented values, a
captured value *is* the identity; no salt or nonce on our side can change
that, because the replay carries them along. Challenge–response would
need the secret inside the agent's code path, which the credential model
forbids by design. So the defence is placed on the other side: make a
leak *small* (roles, allow-list, rate limits) and *stoppable* (breaker,
key rotation as the emergency brake).

**Constant-time token comparison.** Presented tokens are SHA-256 hashed
and the fixed-length digests compared in constant time, so comparisons
leak neither length nor prefix.

## Routes

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/health` | public | `{ ok, breakerOn }`; 503 when the breaker is on |
| GET | `/` | public | Service description |
| GET | `/switchbot/devices` | read | Device + infrared remote list |
| GET | `/switchbot/devices/:id/status` | read | |
| POST | `/switchbot/devices/:id/commands` | write | Body: `{ command, parameter?, commandType? }` |
| GET | `/switchbot/scenes` | read | |
| POST | `/switchbot/scenes/:id/execute` | write | |
| GET | `/qingping/devices` | read | Latest readings for all devices |
| GET | `/qingping/history?mac=&start_time=&end_time=` | read | Unix seconds |
| GET | `/admin/status` | admin | |
| POST | `/admin/breaker/on` · `/off` | admin | The `off` route stays reachable while the breaker is on — a switch you cannot release is a trap |

Errors are JSON: `{ "error": { "code": "...", "message": "..." } }`
(401 unauthorized, 403 wrong role, 429 rate limited, 501 adapter not
configured, 503 breaker on).

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in tokens & vendor secrets for local dev
npm run dev                      # wrangler dev
npm test                         # vitest, no network needed
```

Try it:

```bash
curl -H "Authorization: Bearer <your-read-token>" http://localhost:8787/switchbot/devices
curl -H "Authorization: Bearer <your-read-token>" http://localhost:8787/qingping/devices
```

## Deploy (your own Cloudflare account)

```bash
npx wrangler login

# One long random value per role. Generate, e.g.: openssl rand -hex 32
npx wrangler secret put BRIDGE_TOKEN_READ
npx wrangler secret put BRIDGE_TOKEN_WRITE
npx wrangler secret put BRIDGE_TOKEN_ADMIN

# Only the adapters you use:
npx wrangler secret put SWITCHBOT_TOKEN
npx wrangler secret put SWITCHBOT_SECRET
npx wrangler secret put QINGPING_APP_KEY
npx wrangler secret put QINGPING_APP_SECRET

# Optional but recommended: durable breaker state
npx wrangler kv namespace create BRIDGE_KV   # then uncomment in wrangler.toml

npx wrangler deploy
```

Then register the deployed URL as a custom connector / API tool in your
agent platform, with the **read** token as its Bearer credential, and call
the routes above. See `examples/` for a connector sketch.

## Adapters

An adapter is a small module under `src/adapters/` that knows one vendor's
auth ritual and exposes named operations. The common core (auth, roles,
rate limit, breaker) never knows vendor details; adapters never see the
bridge token.

- **SwitchBot** — OpenAPI v1.1. `sign = Base64(HMAC-SHA256(secret, token + t + nonce))`,
  sent as headers alongside the token. The secret is the HMAC key only and
  never leaves the Worker.
- **Qingping (ClearGrass)** — OAuth2 client-credentials: Basic
  `appKey:appSecret` → short-lived access token (cached, refreshed early,
  one 401-retry), then Bearer calls to `apis.cleargrass.com` with the
  vendor-required `timestamp` parameter. Read-only in v1.

### Known unverified points

Honesty section — these are implemented from the vendors' published docs
and community clients, and unit-tested against mocks, but not yet verified
against a live account:

- Qingping's token `scope` value (default `device`, override with the
  `QINGPING_SCOPE` var) and the exact history endpoint shape.
- Live behaviour of both vendors under real credentials.

## Roadmap

- **v1.1 candidate — envelope tokens (JWE).** Instead of storing vendor
  secrets in the Worker, encrypt them to the Worker's public key and carry
  the ciphertext *inside* the presented token. The Worker then holds
  exactly one secret (its private key) and becomes a generic, distributable
  part. Same line-drawing as v1, pushed one step further.
- Hard global rate limiting (KV / Durable Object backed).
- More adapters (any API whose auth is "a pair" or "a signature").

## Repository status

Pre-release (v0.1). Licensed under the **MIT License** — see `LICENSE`.
The design notes that led here live in `DESIGN.md`.

## Security notes

- Never commit `.dev.vars` or put real secrets in `wrangler.toml`.
- Rotate a bridge token by setting the new value (comma-separated overlap
  is supported in the `BRIDGE_TOKEN_*` secrets), updating the connector,
  then removing the old value.
- If you suspect a leak: flip the breaker first, investigate second.
