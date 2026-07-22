import type { VaultErrorCode } from "../lib/vault-client";

export interface DashboardVaultState {
  status: "loading" | "ready" | "error";
  error: string | null;
  errorCode: VaultErrorCode | null;
  recoveryConfirm: boolean;
  recoveryError: string | null;
}

export const initialDashboardVaultState: DashboardVaultState = {
  status: "loading",
  error: null,
  errorCode: null,
  recoveryConfirm: false,
  recoveryError: null,
};

export type DashboardVaultAction =
  | { type: "load_started" }
  | { type: "load_succeeded" }
  | { type: "load_failed"; error: string; errorCode: VaultErrorCode | null }
  | { type: "recovery_confirmation_opened" }
  | { type: "recovery_confirmation_closed" }
  | { type: "recovery_started" }
  | { type: "recovery_failed"; error: string };

export function dashboardVaultReducer(
  state: DashboardVaultState,
  action: DashboardVaultAction,
): DashboardVaultState {
  switch (action.type) {
    case "load_started":
      return {
        status: "loading",
        error: null,
        errorCode: null,
        recoveryConfirm: false,
        recoveryError: null,
      };
    case "load_succeeded":
      return {
        status: "ready",
        error: null,
        errorCode: null,
        recoveryConfirm: false,
        recoveryError: null,
      };
    case "load_failed":
      return {
        ...state,
        status: "error",
        error: action.error,
        errorCode: action.errorCode,
      };
    case "recovery_confirmation_opened":
      return { ...state, recoveryConfirm: true, recoveryError: null };
    case "recovery_confirmation_closed":
      return { ...state, recoveryConfirm: false };
    case "recovery_started":
      return { ...state, recoveryError: null };
    case "recovery_failed":
      return { ...state, recoveryError: action.error };
  }
}
