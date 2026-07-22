import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNotifyConfig } from "./notify-config.ts";

test("notification config defaults, rounds and clamps valid thresholds", () => {
  assert.deepEqual(parseNotifyConfig({}), {
    ok: true,
    config: { recovery: true, warning: true, everyReset: false, warnThreshold: 90, recoveryThreshold: 80 },
  });
  assert.deepEqual(
    parseNotifyConfig({ recovery: false, warning: false, everyReset: true, warnThreshold: 101, recoveryThreshold: 79.6 }),
    {
      ok: true,
      config: { recovery: false, warning: false, everyReset: true, warnThreshold: 100, recoveryThreshold: 80 },
    },
  );
});

test("notification config rejects equal or reversed recovery/warning thresholds", () => {
  for (const body of [
    { warnThreshold: 80, recoveryThreshold: 80 },
    { warnThreshold: 70, recoveryThreshold: 80 },
    { warnThreshold: 0, recoveryThreshold: 2 }, // clamps to 1/2 before validation
  ]) {
    const result = parseNotifyConfig(body);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /lower than warning/i);
  }
});

test("notification config ignores wrong primitive types rather than coercing them", () => {
  assert.deepEqual(parseNotifyConfig({ recovery: "false", warnThreshold: "95", recoveryThreshold: null }), {
    ok: true,
    config: { recovery: true, warning: true, everyReset: false, warnThreshold: 90, recoveryThreshold: 80 },
  });
});
