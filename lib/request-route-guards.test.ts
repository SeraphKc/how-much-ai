import { after, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) {
      const target = specifier.slice(2);
      return nextResolve(pathToFileURL(path.join(projectRoot, path.extname(target) ? target : `${target}.ts`)).href, context);
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith(pathToFileURL(projectRoot).href) &&
      !context.parentURL.includes("/node_modules/") &&
      path.extname(new URL(specifier, context.parentURL).pathname) === ""
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const originalEnv = { ...process.env };
delete process.env.APP_PASSWORD;
delete process.env.VERCEL;
process.env.CONVEX_URL = "https://request-guard-test.convex.cloud";
process.env.VAULT_ACCESS_SECRET = "request-guard-secret";

const { POST: manualPost } = await import("../app/api/connect/manual/route.ts");
const { POST: localPost } = await import("../app/api/connect/local/route.ts");
const { POST: oauthPost } = await import("../app/api/connect/oauth/route.ts");
const { POST: pairStartPost } = await import("../app/api/connect/pair/start/route.ts");
const { POST: pairCompletePost } = await import("../app/api/connect/pair/complete/route.ts");
const { POST: usagePost } = await import("../app/api/usage/route.ts");
const { PUT: vaultPut } = await import("../app/api/vault/route.ts");
const { POST: loginPost } = await import("../app/api/auth/login/route.ts");
const { POST: logoutPost } = await import("../app/api/auth/logout/route.ts");
const { PUT: notifyPut } = await import("../app/api/notify/route.ts");
const { POST: subscribePost, DELETE: subscribeDelete } = await import("../app/api/notify/subscribe/route.ts");
const { POST: recoverPost } = await import("../app/api/vault/recover/route.ts");
const { pairingBackendAvailable, pairingRateBucket, PAIRING_RATE_BUCKET_COUNT } =
  await import("./pairings-store.ts");

after(() => {
  process.env = originalEnv;
  moduleHooks.deregister();
});

function jsonPrimitive(pathname: string, body = "null"): Request {
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

test("JSON API routes return 400 for valid JSON null instead of throwing", async () => {
  const cases: Array<[string, (request: Request) => Promise<Response>]> = [
    ["/api/connect/manual", manualPost],
    ["/api/connect/local", localPost],
    ["/api/connect/pair/start", pairStartPost],
    ["/api/connect/pair/complete", pairCompletePost],
    ["/api/usage", usagePost],
  ];

  for (const [pathname, handler] of cases) {
    const response = await handler(jsonPrimitive(pathname));
    assert.equal(response.status, 400, pathname);
  }
});

test("JSON API routes reject array bodies as non-object input", async () => {
  for (const [pathname, handler] of [
    ["/api/connect/manual", manualPost],
    ["/api/usage", usagePost],
  ] as const) {
    const response = await handler(jsonPrimitive(pathname, "[]"));
    assert.equal(response.status, 400, pathname);
  }
});

test("browser state mutations reject cross-origin requests before route-specific work", async () => {
  const cases: Array<[string, string, (request: Request) => Promise<Response>]> = [
    ["/api/auth/login", "POST", loginPost],
    ["/api/auth/logout", "POST", logoutPost],
    ["/api/connect/local", "POST", localPost],
    ["/api/connect/manual", "POST", manualPost],
    ["/api/connect/oauth", "POST", oauthPost],
    ["/api/connect/pair/start", "POST", pairStartPost],
    ["/api/notify", "PUT", notifyPut],
    ["/api/notify/subscribe", "POST", subscribePost],
    ["/api/notify/subscribe", "DELETE", subscribeDelete],
    ["/api/usage", "POST", usagePost],
    ["/api/vault", "PUT", vaultPut],
    ["/api/vault/recover", "POST", recoverPost],
  ];

  for (const [pathname, method, handler] of cases) {
    const response = await handler(
      new Request(`http://localhost${pathname}`, {
        method,
        headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
        body: "{}",
      }),
    );
    assert.equal(response.status, 403, pathname);
  }
});

test("browser JSON mutations reject text/plain no-CORS bodies", async () => {
  for (const [pathname, method, handler] of [
    ["/api/connect/manual", "POST", manualPost],
    ["/api/notify", "PUT", notifyPut],
    ["/api/notify/subscribe", "POST", subscribePost],
    ["/api/usage", "POST", usagePost],
    ["/api/vault", "PUT", vaultPut],
    ["/api/vault/recover", "POST", recoverPost],
  ] as const) {
    const response = await handler(
      new Request(`http://localhost${pathname}`, {
        method,
        headers: { "Content-Type": "text/plain", "Sec-Fetch-Site": "same-origin" },
        body: "{}",
      }),
    );
    assert.equal(response.status, 415, pathname);
  }
});

test("pairing rate-limit keys are stable bounded HMAC buckets, never raw addresses", () => {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.20, 10.0.0.1" });
  const first = pairingRateBucket(headers);
  const second = pairingRateBucket(headers);
  assert.equal(first, second);
  assert.match(first, /^b\d+$/);
  assert.ok(Number(first.slice(1)) < PAIRING_RATE_BUCKET_COUNT);
  assert.equal(first.includes("203.0.113.20"), false);
});

test("pairing buckets ignore spoofed proxy IPs unless the deployment trusts its proxy", () => {
  const keys = ["VERCEL", "CF_PAGES", "FLY_APP_NAME", "TRUST_PROXY_IP_HEADERS"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const firstHeaders = new Headers({ "x-forwarded-for": "203.0.113.20" });
  const secondHeaders = new Headers({ "x-forwarded-for": "198.51.100.44" });
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(
      pairingRateBucket(firstHeaders),
      pairingRateBucket(secondHeaders),
      "direct callers share the fail-closed bucket instead of choosing one with a forged header",
    );

    process.env.VERCEL = "1";
    assert.notEqual(
      pairingRateBucket(firstHeaders),
      pairingRateBucket(secondHeaders),
      "a known proxy platform may bucket its overwritten client-address header",
    );
  } finally {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("pairing storage rejects a partial Convex configuration", () => {
  const secret = process.env.VAULT_ACCESS_SECRET;
  try {
    delete process.env.VAULT_ACCESS_SECRET;
    assert.throws(() => pairingBackendAvailable(), /partially configured/i);
  } finally {
    if (secret === undefined) delete process.env.VAULT_ACCESS_SECRET;
    else process.env.VAULT_ACCESS_SECRET = secret;
  }
});
