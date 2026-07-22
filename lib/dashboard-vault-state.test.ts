import test from "node:test";
import assert from "node:assert/strict";
import {
  dashboardVaultReducer,
  initialDashboardVaultState,
} from "../components/dashboard-vault-state.ts";

test("a successful focus resync recovers an initially unreadable vault", () => {
  let state = dashboardVaultReducer(initialDashboardVaultState, {
    type: "load_failed",
    error: "Couldn't read saved accounts. Reference: err_0123456789ab.",
    errorCode: "VAULT_UNREADABLE",
  });
  state = dashboardVaultReducer(state, { type: "recovery_confirmation_opened" });
  state = dashboardVaultReducer(state, {
    type: "recovery_failed",
    error: "The remote vault must be recovered by restoring its key.",
  });

  state = dashboardVaultReducer(state, { type: "load_succeeded" });

  assert.deepEqual(state, {
    status: "ready",
    error: null,
    errorCode: null,
    recoveryConfirm: false,
    recoveryError: null,
  });
});
