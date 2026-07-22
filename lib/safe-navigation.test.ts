import { test } from "node:test";
import assert from "node:assert/strict";
import { safeInternalPath } from "./safe-navigation.ts";

test("safeInternalPath accepts and normalizes same-app paths", () => {
  assert.equal(safeInternalPath("/"), "/");
  assert.equal(safeInternalPath("/settings?tab=alerts#push"), "/settings?tab=alerts#push");
  assert.equal(safeInternalPath("/settings?return=%2Faccounts"), "/settings?return=%2Faccounts");
  assert.equal(safeInternalPath("/accounts/../settings"), "/settings");
  assert.equal(safeInternalPath("/https://example.com"), "/https://example.com");
});

test("safeInternalPath rejects absolute and protocol-relative destinations", () => {
  for (const value of [
    "https://example.com",
    "http://example.com",
    "//example.com/path",
    "///example.com/path",
    "/\\example.com/path",
    "\\\\example.com/path",
  ]) {
    assert.equal(safeInternalPath(value), "/", value);
  }
});

test("safeInternalPath rejects ambiguous, encoded, and malformed separators", () => {
  for (const value of [
    " /settings",
    "/settings ",
    "/%2f%2fevil.example",
    "/%5cevil.example",
    "/%2e%2e//evil.example",
    "/.//evil.example",
    "/..//evil.example",
    "/line\nbreak",
    "",
  ]) {
    assert.equal(safeInternalPath(value), "/", JSON.stringify(value));
  }
  assert.equal(safeInternalPath(null), "/");
  assert.equal(safeInternalPath(undefined), "/");
});
