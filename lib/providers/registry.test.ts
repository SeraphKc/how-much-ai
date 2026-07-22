import assert from "node:assert/strict";
import { test } from "node:test";
import "./_resolve-ts.mjs";

const { getProvider, PROVIDERS, isProviderId, ProviderError, httpStatusOf } = await import("./index.ts");

test("getProvider dispatches by id and falls back to anthropic", () => {
  assert.equal(getProvider(undefined).id, "anthropic");
  assert.equal(getProvider(null).id, "anthropic");
  assert.equal(getProvider("bogus").id, "anthropic");
  assert.equal(getProvider("anthropic").id, "anthropic");
  assert.equal(getProvider("openai").id, "openai");
});

test("PROVIDERS lists anthropic then openai", () => {
  assert.deepEqual(
    PROVIDERS.map((p) => p.id),
    ["anthropic", "openai"],
  );
});

test("isProviderId guards known ids", () => {
  assert.equal(isProviderId("openai"), true);
  assert.equal(isProviderId("anthropic"), true);
  assert.equal(isProviderId("nope"), false);
  assert.equal(isProviderId(undefined), false);
});

test("httpStatusOf reads status off ProviderError and plain objects", () => {
  assert.equal(httpStatusOf(new ProviderError("x", 429, "openai")), 429);
  assert.equal(httpStatusOf({ status: 404 }), 404);
  assert.equal(httpStatusOf(new Error("x")), undefined);
  assert.equal(httpStatusOf(null), undefined);
});
