"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { StarburstIcon } from "@/components/Icons";
import { safeInternalPath } from "@/lib/safe-navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || working) return;
    setWorking(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === "string" ? data.error : "Sign-in failed");
        setWorking(false);
        return;
      }
      router.replace(safeInternalPath(params.get("next")));
      router.refresh();
    } catch {
      setError("Network error — try again.");
      setWorking(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="animate-rise w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <StarburstIcon className="h-10 w-10 text-coral" />
          <h1 className="font-display mt-5 text-2xl text-ivory">How Much AI</h1>
          <p className="mt-1 text-sm text-muted">Enter the password to continue</p>
        </div>
        <form onSubmit={submit} className="mt-7 space-y-3">
          <label htmlFor="password" className="sr-only">
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Password"
            autoFocus
            autoComplete="current-password"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "password-error" : undefined}
            className="min-h-11 w-full rounded-lg border border-border bg-surface px-3.5 py-2.5 text-sm text-ivory placeholder:text-faint focus:border-coral/60 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!password || working}
            aria-busy={working}
            className="min-h-11 w-full rounded-lg bg-coral py-2.5 text-sm font-medium text-white transition-colors enabled:hover:bg-coral-pressed disabled:opacity-50"
          >
            {working ? "Signing in…" : "Sign in"}
          </button>
          {error && (
            <p
              id="password-error"
              role="alert"
              className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-center text-xs text-[#ff9c95]"
            >
              {error}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

export function PasswordLogin() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
