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

## Skills travel with tools now — and a question behind that

MCP servers have started shipping skills next to their tools: the agent
fetches the current how-to from the server, at the moment it needs it,
instead of relying on a document someone saved earlier and quietly let
go stale. This bridge intends to follow that pattern — its own skill is
a roadmap item (see `DESIGN.md`) — because the mechanics of using a
bridge, such as which token belongs in which connector and when to flip
the breaker, are exactly the kind of thing that should travel with the
tool.

Spending a little time with that idea raises a quieter question: who
writes the skill that matters?

**The judgments came from practice, not from the vendor.** A shipped
skill describes the intended use of a tool. The decisions that shaped
this project were written the other way around, out of use itself: when
a tool has no reputation to lean on, read its source before trusting
it; when nothing guarantees that the distributed binary matches that
source, build it yourself; when a leak would most likely go unnoticed
anyway, keep one breaker you can actually flip instead of a lifecycle
you cannot operate. Chains of judgment like these are not something a
vendor ships. They are a different species of skill, grown on the
user's side, and this repository treats them as first-class material —
the runbook is where they live here.

**The centre of integration is a person, not a server.** A per-server
skill optimises one tool at a time. The layer this bridge works in is a
different one: several services gathered around a single person's life
— their home, their sensors, their work — where that person's own agent
holds the whole picture. A skill fetched per server cannot describe
that layer. The bridge is a small part that works inside it.

**Private data stays on the person's side of the line.** In that
picture, the complete private data lives inside the user's own agent.
The services, and this bridge, do a narrower job: translate
credentials, and hand service data across. Deciding where that boundary
sits is a design choice, made before any skill is written.

**Freshness is not the only virtue.** Keeping one canonical skill
always up to date is the right optimisation for a maintained product.
For personal software there is another one: build it, use it, tear it
down, rebuild it — as long as the underlying records stay in a form a
person can read, nothing precious is lost when a version is discarded.
This project leans toward the second. The canonical thing worth keeping
is the record of what was decided and why, not any single version of
the tooling.

None of this is an argument against shipping skills with tools; this
bridge plans to do exactly that. It is a note about which skills those
are — and which ones only practice can write.

## Routes

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/health` | public | `{ ok, breakerOn }`; 503 when the breaker is on |
| GET | `/` | public | Service description |
| GET | `/switchbot/devices` | read | Device + infrared remote list |
| GET | `/switchbot/devices/:id/status` | read | |
| POST | `/switchbot/devices/:id/commands` | write | Body: `{ command, parameter?, commandType? }`. **Allow-listed**: only (device, command) pairs in `SWITCHBOT_ALLOWED_COMMANDS` pass; unset = nothing passes |
| GET | `/switchbot/scenes` | read | |
| POST | `/switchbot/scenes/:id/execute` | write | **Allow-listed**: only scene ids in `SWITCHBOT_ALLOWED_SCENES` pass; unset = nothing passes |
| GET | `/qingping/devices` | read | Latest readings for all devices |
| GET | `/qingping/history?mac=&start_time=&end_time=` | read | Unix seconds |
| GET | `/admin/status` | admin | |
| POST | `/admin/breaker/on` · `/off` | admin | The `off` route stays reachable while the breaker is on — a switch you cannot release is a trap |

Errors are JSON: `{ "error": { "code": "...", "message": "..." } }`
(401 unauthorized — always the *bridge* token; 403 wrong role or not
allow-listed, 429 rate limited, 501 adapter not configured, 503 breaker
on). A vendor refusing the bridge's own credentials is reported as
**502 `vendor_auth_error`**, and a vendor rate limit as **502
`vendor_rate_limited`** — in general, vendor 4xx answers are mapped to
502 with a `vendor_*` code (vendor status and body preserved in the
payload), never returned as-is, so the two failure kinds stay
distinguishable. Vendor 5xx answers are likewise mapped to 502
`vendor_server_error`: after the mapping, triage is purely
status-based — 4xx and JSON 500 are the bridge, 502 is the vendor. SwitchBot errors reported inside an HTTP 200 body
(`statusCode != 100`) likewise surface as 502 `vendor_error`, and a
vendor that cannot be reached at all (network failure) as 502
`vendor_unreachable`. The bridge's own unexpected failures answer a
JSON 500 `internal_error` — so a bare, non-JSON 5xx can only come from
the runtime around the Worker, never from the bridge or a vendor.

Allow-list note: entries are colon-separated, so a device id or command
name that itself contains a ":" cannot be registered in
`SWITCHBOT_ALLOWED_COMMANDS` (such entries are ignored, failing closed).

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

## Operations

Day-2 operations live in [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
(Japanese): the deployment checklist, the leak response procedure built
around the breaker, and troubleshooting.

A smoke test that also performs the **breaker drill** (flip it on, watch
everything answer 503, flip it off, watch recovery) ships in
[`scripts/smoke-test.mjs`](scripts/smoke-test.mjs):

```bash
BRIDGE_URL=https://muse-auth-bridge.<your-subdomain>.workers.dev \
BRIDGE_TOKEN_READ=... BRIDGE_TOKEN_WRITE=... BRIDGE_TOKEN_ADMIN=... \
node scripts/smoke-test.mjs          # add --no-breaker to skip the drill
                                     # add --expect-configured once vendor
                                     # secrets are set (501 then fails)
```

Run it after every deploy and every secret rotation. It also works
against a local `wrangler dev` instance.

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

v0.2 — hardened after an external code review (write allow-lists,
breaker KV-failure tolerance, vendor error mapping). Licensed under the
**MIT License** — see `LICENSE`.
The design notes that led here live in `DESIGN.md`.

## Security notes

- Never commit `.dev.vars` or put real secrets in `wrangler.toml`.
- Rotate a bridge token by setting the new value (comma-separated overlap
  is supported in the `BRIDGE_TOKEN_*` secrets), updating the connector,
  then removing the old value.
- If you suspect a leak: flip the breaker first, investigate second.
