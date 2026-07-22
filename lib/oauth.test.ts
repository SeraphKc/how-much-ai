import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAuthorizeUrl, CLAUDE_OAUTH, createPkce, parsePastedCode } from "./oauth.ts";

test("app-owned OAuth uses a fresh PKCE verifier and least-privilege monitoring scopes", async () => {
  const bundle = await createPkce(1_900_000_000_000);
  assert.match(bundle.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(bundle.challenge, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(bundle.state, /^[A-Za-z0-9_-]{32,128}$/);
  assert.notEqual(bundle.verifier, bundle.challenge);
  assert.equal(bundle.createdAt, 1_900_000_000_000);

  const url = new URL(buildAuthorizeUrl(bundle));
  assert.equal(url.origin + url.pathname, CLAUDE_OAUTH.authorizeUrl);
  assert.equal(url.searchParams.get("client_id"), CLAUDE_OAUTH.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), CLAUDE_OAUTH.redirectUri);
  assert.equal(url.searchParams.get("scope"), CLAUDE_OAUTH.scopes);
  assert.equal(url.searchParams.get("code_challenge"), bundle.challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), bundle.state);
});

test("callback parsing accepts Claude's code#state text and a complete callback URL", () => {
  assert.deepEqual(parsePastedCode(" auth-code-1#state-1 "), {
    code: "auth-code-1",
    state: "state-1",
  });
  assert.deepEqual(
    parsePastedCode("https://platform.claude.com/oauth/code/callback?code=auth-code-2&state=state-2"),
    { code: "auth-code-2", state: "state-2" },
  );
  assert.deepEqual(
    parsePastedCode("https://platform.claude.com/oauth/code/callback?code=auth-code-3#state-3"),
    { code: "auth-code-3", state: "state-3" },
  );
  assert.deepEqual(parsePastedCode("bare-code"), { code: "bare-code" });
});
