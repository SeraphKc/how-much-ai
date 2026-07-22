import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { readFileSync } from "node:fs";
import "./_resolve-ts.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/wham-usage.json", import.meta.url), "utf8"));
const { normalizeOpenAIUsage } = await import("./openai-usage.ts");
const { openaiProvider, openaiPlanLabel } = await import("./openai.ts");

function jwt(payload: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "RS256", typ: "JWT" })}.${b(payload)}.sig`;
}
const token = jwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acc-1", chatgpt_plan_type: "pro" },
  email: "person@example.com",
  exp: 9_999_999_999,
});
const tokens = { accessToken: token, refreshToken: "rt-0", expiresAt: 9_999_999_999_000 };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function stubFetch(handler: (url: string, init: any) => Response): { calls: Array<{ url: string; init: any }> } {
  const calls: Array<{ url: string; init: any }> = [];
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("normalizeOpenAIUsage maps the live /wham/usage fixture", () => {
  const usage = normalizeOpenAIUsage(fixture);
  // fixture primary window: used_percent 3, 604800s (weekly), reset_at 1784976109
  assert.equal(usage.seven_day?.utilization, 3);
  assert.equal(usage.seven_day?.resets_at, new Date(1_784_976_109_000).toISOString());
  const weekly = usage.limits?.find((l) => l.kind === "weekly_all");
  assert.equal(weekly?.percent, 3);
  assert.equal(weekly?.is_active, true);
  const scoped = usage.limits?.find((l) => l.scope?.model?.display_name === "GPT-5.3-Codex-Spark");
  assert.ok(scoped, "scoped model limit present");
  assert.equal(scoped?.kind, "weekly_scoped");
  assert.equal(scoped?.group, "codex_bengalfox");
});

test("normalizeOpenAIUsage maps a 5-hour session window", () => {
  const usage = normalizeOpenAIUsage({
    rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18_000, reset_at: 1_800_000_000 } },
  });
  assert.equal(usage.five_hour?.utilization, 40);
  assert.equal(usage.limits?.[0].kind, "session");
  assert.equal(usage.limits?.[0].severity, "normal");
});

test("normalizeOpenAIUsage escalates severity by percent", () => {
  const usage = normalizeOpenAIUsage({
    rate_limit: { primary_window: { used_percent: 95, limit_window_seconds: 604_800, reset_at: 1 } },
  });
  assert.equal(usage.limits?.[0].severity, "critical");
});

test("openaiPlanLabel maps plan slugs", () => {
  assert.equal(openaiPlanLabel("pro"), "ChatGPT Pro");
  assert.equal(openaiPlanLabel("prolite"), "ChatGPT Pro");
  assert.equal(openaiPlanLabel("plus"), "ChatGPT Plus");
  assert.equal(openaiPlanLabel(null), "ChatGPT");
});

test("refresh posts the codex client grant and rotates the refresh token", async () => {
  const { calls } = stubFetch(() => json({ access_token: jwt({ exp: 1_900_000_000 }), refresh_token: "rt-1" }));
  const rotated = await openaiProvider.refresh(tokens);
  assert.equal(calls[0].url, "https://auth.openai.com/oauth/token");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    grant_type: "refresh_token",
    refresh_token: "rt-0",
  });
  assert.equal(rotated.refreshToken, "rt-1");
  assert.equal(rotated.expiresAt, 1_900_000_000_000);
});

test("refresh maps a 401 to a ProviderError with status", async () => {
  stubFetch(() => json({ error: "invalid_grant" }, 401));
  await assert.rejects(
    () => openaiProvider.refresh(tokens),
    (err: any) => err.name === "ProviderError" && err.status === 401 && err.providerId === "openai",
  );
});

test("fetchUsage reads /wham/usage with a bearer header and normalizes", async () => {
  const { calls } = stubFetch(() => json(fixture));
  const usage = await openaiProvider.fetchUsage(tokens);
  assert.deepEqual(usage, normalizeOpenAIUsage(fixture));
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].init.headers["ChatGPT-Account-Id"], "acc-1");
});

test("fetchUsage turns a Cloudflare HTML block into a clean ProviderError", async () => {
  stubFetch(() => new Response("<html>blocked</html>", { status: 403, headers: { "content-type": "text/html" } }));
  await assert.rejects(
    () => openaiProvider.fetchUsage(tokens),
    (err: any) => err.name === "ProviderError" && err.status === 403,
  );
});

test("fetchUsage converts a network fault into a ProviderError 502 (not a raw error)", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("network down");
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => openaiProvider.fetchUsage(tokens),
    (err: any) => err.name === "ProviderError" && err.status === 502 && err.providerId === "openai",
  );
});

test("resolveIdentity propagates a network fault as a ProviderError 502", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("network down");
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => openaiProvider.resolveIdentity(tokens),
    (err: any) => err.name === "ProviderError" && err.status === 502,
  );
});

test("resolveIdentity returns a namespaced id, email, and plan label", async () => {
  stubFetch(() => json(fixture));
  const identity = await openaiProvider.resolveIdentity(tokens);
  assert.equal(identity.id, "openai-acc-1");
  assert.equal(identity.plan, "ChatGPT Pro");
  assert.equal(typeof identity.email, "string");
});

test("parseManualCredential parses a pasted auth.json", () => {
  const raw = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token, refresh_token: "rt-9" } });
  const parsed = openaiProvider.parseManualCredential?.(raw);
  assert.equal(parsed?.accessToken, token);
  assert.equal(parsed?.refreshToken, "rt-9");
});

test("readLocalCredential reads ~/.codex/auth.json via injected deps", async () => {
  const parsed = await openaiProvider.readLocalCredential?.({
    readFile: async (file: string) => {
      assert.match(file, /\.codex\/auth\.json$/);
      return JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token, refresh_token: "rt-local" } });
    },
    homedir: () => "/home/tester",
  });
  assert.equal(parsed?.accessToken, token);
  assert.equal(parsed?.refreshToken, "rt-local");
});

test("readLocalCredential maps a missing file to a 404 ProviderError", async () => {
  await assert.rejects(
    () =>
      openaiProvider.readLocalCredential?.({
        readFile: async () => {
          const err = new Error("not found") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        },
        homedir: () => "/home/tester",
      }) ?? Promise.reject(new Error("no readLocalCredential")),
    (err: any) => err.name === "ProviderError" && err.status === 404,
  );
});
