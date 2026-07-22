import { test } from "node:test";
import assert from "node:assert/strict";
import { scopedKey } from "./app-config.ts";

test("scopedKey keeps default un-namespaced, namespaces everyone else", () => {
  assert.equal(scopedKey("accounts", "default"), "accounts");
  assert.equal(scopedKey("accounts", "user_123"), "accounts::user_123");
  assert.equal(scopedKey("usage:vault:v1", "user_2xYz::weird"), "usage:vault:v1::user_2xYz::weird");
});
