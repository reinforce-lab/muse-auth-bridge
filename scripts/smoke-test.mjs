#!/usr/bin/env node
/**
 * Smoke test for a deployed Muse Auth Bridge.
 *
 * Verifies, against a live Worker (deployed or `wrangler dev`):
 *   1. /health answers and reports the breaker off
 *   2. requests without a token are refused (401)
 *   3. a read token passes auth on a read route (200, or 501 when the
 *      vendor adapter is not configured yet — both prove the pipeline)
 *   4. a read token cannot use a write route (403)
 *   5. BREAKER DRILL: admin flips the breaker on -> every route, health
 *      included, answers 503 -> admin flips it off again (this route
 *      stays reachable while the breaker is on, by design) -> health
 *      recovers to 200
 *
 * The drill always tries to leave the breaker OFF, even on failure.
 * Skip it with --no-breaker (e.g. when no admin token is available).
 *
 * Note on the KV-backed breaker: Cloudflare KV is eventually
 * consistent, so a breaker flip can take up to ~60s to be visible at
 * every edge location. The transition checks below therefore poll
 * until the expected status shows up (90s budget) instead of asserting
 * on the first response. When an instant, everywhere-at-once stop is
 * required, use the BRIDGE_DISABLED variable + redeploy instead.
 *
 * Usage:
 *   BRIDGE_URL=https://muse-auth-bridge.<subdomain>.workers.dev \
 *   BRIDGE_TOKEN_READ=... BRIDGE_TOKEN_WRITE=... BRIDGE_TOKEN_ADMIN=... \
 *   node scripts/smoke-test.mjs [--no-breaker] [--expect-configured]
 *
 * --expect-configured: use after vendor secrets have been set on the
 * Worker. The read-route check then requires a real 200, so a missing
 * secret (501) fails the test instead of passing silently.
 *
 * Exit code 0 when every executed check passes, 1 otherwise.
 * No dependencies; Node 18+ (global fetch).
 */

const base = (process.env.BRIDGE_URL ?? "http://localhost:8787").replace(/\/$/, "");
const tokens = {
  read: process.env.BRIDGE_TOKEN_READ ?? "",
  write: process.env.BRIDGE_TOKEN_WRITE ?? "",
  admin: process.env.BRIDGE_TOKEN_ADMIN ?? "",
};
const runBreaker = !process.argv.includes("--no-breaker") && Boolean(tokens.admin);
const expectConfigured = process.argv.includes("--expect-configured");

let failures = 0;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}
function skip(name, why) {
  console.log(`SKIP  ${name}  (${why})`);
}

async function call(method, path, token) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (method === "POST") headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify({ command: "turnOn" }) : undefined,
  });
  return res.status;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until the route answers `want` (breaker state may still be
 *  propagating through KV), or the budget runs out. Returns the last
 *  status seen. Transient fetch errors count as "not yet". */
async function pollStatus(method, path, token, want, budgetMs = 90000) {
  const deadline = Date.now() + budgetMs;
  let last = 0;
  for (;;) {
    try {
      last = await call(method, path, token);
    } catch {
      last = 0;
    }
    if (last === want || Date.now() >= deadline) return last;
    await sleep(3000);
  }
}

async function main() {
  console.log(`Target: ${base}\n`);

  // 1. Health (polled: a previous drill's breaker release may still
  // be propagating through KV)
  const health = await pollStatus("GET", "/health", "", 200, 30000);
  report("GET /health -> 200", health === 200, `got ${health}`);

  // 2. No token refused
  const noToken = await call("GET", "/switchbot/devices", "");
  report("GET /switchbot/devices without token -> 401", noToken === 401, `got ${noToken}`);

  // 3. Read token reaches an adapter route
  if (tokens.read) {
    const read = await call("GET", "/switchbot/devices", tokens.read);
    if (expectConfigured) {
      report(
        "GET /switchbot/devices with read token -> 200 (configured)",
        read === 200,
        `got ${read}${read === 501 ? ", adapter still not configured" : ""}`,
      );
    } else {
      report(
        "GET /switchbot/devices with read token -> 200 or 501",
        read === 200 || read === 501,
        `got ${read}${read === 501 ? ", adapter not configured yet" : ""}`,
      );
    }
    // 4. Read token cannot write
    const writeAttempt = await call("POST", "/switchbot/devices/smoke/commands", tokens.read);
    report("POST commands with read token -> 403", writeAttempt === 403, `got ${writeAttempt}`);
  } else {
    skip("read-token checks", "BRIDGE_TOKEN_READ not set");
  }

  // 5. Breaker drill
  if (runBreaker) {
    let breakerLeftOn = false;
    try {
      const on = await call("POST", "/admin/breaker/on", tokens.admin);
      report("POST /admin/breaker/on with admin token -> 200", on === 200, `got ${on}`);
      breakerLeftOn = on === 200;

      const healthOn = await pollStatus("GET", "/health", "", 503);
      report("breaker on: GET /health -> 503", healthOn === 503, `got ${healthOn}`);

      if (tokens.read) {
        const duringOn = await pollStatus("GET", "/switchbot/devices", tokens.read, 503);
        report("breaker on: valid read token still -> 503", duringOn === 503, `got ${duringOn}`);
      }

      const off = await call("POST", "/admin/breaker/off", tokens.admin);
      report("breaker on: POST /admin/breaker/off stays reachable -> 200", off === 200, `got ${off}`);
      breakerLeftOn = off !== 200;

      const healthAfter = await pollStatus("GET", "/health", "", 200);
      report("breaker off: GET /health recovers -> 200", healthAfter === 200, `got ${healthAfter}`);
    } finally {
      if (breakerLeftOn) {
        console.error("\nWARNING: breaker may still be ON. Trying once more to release it...");
        const retry = await call("POST", "/admin/breaker/off", tokens.admin);
        console.error(`release retry -> ${retry}`);
        if (retry === 200) failures = Math.max(0, failures - 0); // state noted in output
      }
    }
  } else {
    skip("breaker drill", tokens.admin ? "--no-breaker given" : "BRIDGE_TOKEN_ADMIN not set");
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`Smoke test could not run: ${err.message}`);
  process.exit(1);
});
