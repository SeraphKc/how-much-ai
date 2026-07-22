import test from "node:test";
import assert from "node:assert/strict";
import { safeServerErrorId, serverErrorText } from "./error-reference.ts";

test("server error references surface only generated opaque ids", () => {
  assert.equal(safeServerErrorId("err_0123456789ab"), "err_0123456789ab");
  assert.equal(
    serverErrorText("The encrypted credential could not be saved.", "Connection failed", "err_0123456789ab"),
    "The encrypted credential could not be saved. Reference: err_0123456789ab.",
  );
});

test("server error references reject malformed or attacker-controlled values", () => {
  for (const value of [
    "ERR_0123456789AB",
    "err_0123456789ab\nsecret",
    "err_0123456789abc",
    "incident-0123456789ab",
    123,
    null,
  ]) {
    assert.equal(safeServerErrorId(value), undefined);
    assert.equal(serverErrorText("Connection failed", "Fallback", value), "Connection failed");
  }
});

test("server error text retains fallback behavior while formatting references consistently", () => {
  assert.equal(serverErrorText(undefined, "Connection failed", "err_abcdef012345"), "Connection failed. Reference: err_abcdef012345.");
  assert.equal(serverErrorText("  Try again  ", "Fallback"), "Try again");
});
