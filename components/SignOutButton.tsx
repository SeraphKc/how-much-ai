"use client";

import { useState } from "react";
import { logout } from "@/lib/vault-client";
import { SignOutIcon } from "./Icons";

interface Props {
  onError: (message: string) => void;
}

export function SignOutButton({ onError }: Props) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await logout();
    } catch (error) {
      setBusy(false);
      onError(error instanceof Error ? error.message : "Couldn't sign out. Try again.");
    }
  };

  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={busy}
      aria-label={busy ? "Signing out" : "Sign out"}
      aria-busy={busy}
      title="Sign out"
      className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-border text-faint transition-all enabled:hover:border-border-light enabled:hover:bg-surface-hover enabled:hover:text-ivory disabled:opacity-50 sm:w-auto sm:gap-2 sm:px-3"
    >
      <SignOutIcon className="h-4 w-4" />
      <span className="hidden sm:inline">{busy ? "Signing out…" : "Sign out"}</span>
    </button>
  );
}
