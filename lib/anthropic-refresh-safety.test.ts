import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  AnthropicError,
  fetchProfile,
  isProfilePermissionError,
  REFRESH_TOKEN_TIMEOUT_MS,
  refreshTokens,
} from "./anthropic.ts";

const originalFetch = globalThis.fetch;
const originalAbortSignalTimeout = AbortSignal.timeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalAbortSignalTimeout;
});

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("a single-use refresh POST is never replayed to a fallback host after an ambiguous 5xx", async () => {
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { grant_type: string; refresh_token: string };
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.refresh_token, "refresh-r0");

    if (calls === 1) {
      // A 5xx does not prove the server rejected the refresh before consuming R0. Retrying the same
      // one-time credential can turn an ambiguous transient fault into a definite invalid_grant.
      return json({ error: "upstream_response_lost" }, 500);
    }
    return json({ error: "invalid_grant", error_description: "R0 was already consumed" }, 400);
  };

  await assert.rejects(() => refreshTokens("refresh-r0"));
  assert.equal(calls, 1, "the non-idempotent refresh request was attempted only once");
});

test("a single-use refresh POST is never replayed after an ambiguous transport failure", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("connection reset after request body was sent");
    return json({ error: "invalid_grant", error_description: "the first host consumed the token" }, 400);
  };

  await assert.rejects(() => refreshTokens("refresh-r0"));
  assert.equal(calls, 1, "a transport exception cannot safely be treated as proof that R0 was unused");
});

test("single-use refresh gets a dedicated long deadline without adding a retry", async () => {
  const controller = new AbortController();
  let requestedTimeout = 0;
  let calls = 0;
  AbortSignal.timeout = ((milliseconds: number) => {
    requestedTimeout = milliseconds;
    return controller.signal;
  }) as typeof AbortSignal.timeout;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    assert.equal(init?.signal, controller.signal);
    return json({ error: "upstream_response_lost" }, 500);
  };

  await assert.rejects(() => refreshTokens("refresh-r0"));
  assert.equal(requestedTimeout, REFRESH_TOKEN_TIMEOUT_MS);
  assert.ok(REFRESH_TOKEN_TIMEOUT_MS >= 60_000, "renewal has materially longer than a short bearer-read deadline");
  assert.equal(calls, 1, "a longer deadline did not introduce a replay path");
});

test("a refresh response without the mandatory replacement token is rejected", async () => {
  globalThis.fetch = async () =>
    json(
      {
        access_token: "access-r1",
        // Reusing R0 as a fallback would be unsafe because refresh credentials rotate on use.
        expires_in: 28_800,
      },
      200,
    );

  await assert.rejects(
    () => refreshTokens("refresh-r0"),
    /without returning a replacement refresh token/i,
  );
});

test("structured bearer errors expose safe fields instead of raw JSON or credentials", async () => {
  const credential = "sk-ant-oat01-never-surface-this";
  globalThis.fetch = async () =>
    json(
      {
        type: "error",
        error: {
          type: "permission_error",
          message: `Bearer ${credential} lacks the user:profile permission`,
          permission: "user:profile",
        },
        request_id: "req_safe_fields_only",
      },
      403,
    );

  await assert.rejects(
    () => fetchProfile(credential),
    (error: unknown) => {
      assert.ok(error instanceof AnthropicError);
      assert.equal(error.status, 403);
      assert.equal(error.errorType, "permission_error");
      assert.equal(error.permission, "user:profile");
      assert.equal(error.structured, true);
      assert.equal(isProfilePermissionError(error), true);
      assert.doesNotMatch(error.message, /sk-ant|request_id|[{}]/i);
      assert.match(error.message, /Bearer \[redacted credential\].*user:profile/i);
      return true;
    },
  );
});

test("the live setup-token profile-scope response is recognized without a permission field", async () => {
  globalThis.fetch = async () =>
    json(
      {
        type: "error",
        error: {
          type: "permission_error",
          message: "OAuth token does not meet scope requirement user:profile",
          details: { error_visibility: "user_facing" },
        },
        request_id: "req_not_exposed",
      },
      403,
    );

  await assert.rejects(
    () => fetchProfile("sk-ant-oat01-live-shape"),
    (error: unknown) => {
      assert.ok(error instanceof AnthropicError);
      assert.equal(error.errorType, "permission_error");
      assert.equal(error.permission, undefined);
      assert.equal(error.message, "OAuth token does not meet scope requirement user:profile");
      assert.equal(isProfilePermissionError(error), true);
      return true;
    },
  );
});

test("unstructured bearer failures never echo their response body", async () => {
  globalThis.fetch = async () =>
    new Response("permission_error: missing user:profile for sk-ant-oat01-secret", { status: 403 });

  await assert.rejects(
    () => fetchProfile("sk-ant-oat01-secret"),
    (error: unknown) => {
      assert.ok(error instanceof AnthropicError);
      assert.equal(error.message, "Anthropic returned 403");
      assert.equal(error.structured, false);
      assert.equal(isProfilePermissionError(error), false);
      return true;
    },
  );
});
