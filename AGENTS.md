# Repository instructions for AI agents

These instructions apply to the entire repository.

## Product boundary

This is the open-source, self-hosted, single-tenant edition of How Much AI.

It must retain:

- zero-configuration local use;
- optional password authentication;
- Claude and ChatGPT/Codex provider tracking;
- encrypted local-file, Convex, and Redis/KV REST vaults;
- local, Redis, and Convex refresh coordination;
- optional Convex-backed Web Push, Telegram, and webhook notifications;
- safe provider connection and credential-refresh flows.

It must not add hosted identity, payments, paid-account limits, marketing pages, analytics, production-domain assumptions, or a build-time provider lock. In particular, do not introduce Clerk, Stripe, `AUTH_MODE`, `BILLING`, `NEXT_PUBLIC_PREVIEW`, or `NEXT_PUBLIC_LOCK_PROVIDER` into this edition.

## Deterministic setup

Use Node.js 22.18.0 or newer. Run commands from the repository root.

```bash
npm ci
npm run dev
```

The default development URL is [http://localhost:3000](http://localhost:3000). With no environment file, the app is intentionally open and uses the encrypted local vault under `.data/`.

Copy `.env.example` to `.env.local` only when a task needs explicit configuration. Use placeholder/test values, never credentials from another project or a production service.

## Required validation

For a code or dependency change, run these commands in this order:

```bash
npm test
npm run typecheck
npm run build
```

`npm run build` includes the vault-trace assertion and is required even if TypeScript passes. If a change affects one backend, authentication, connection, or notifications, add or run focused tests for that boundary as well.

Documentation-only changes should at least be checked for correct paths, commands, links, environment names, and Markdown rendering. CI runs the complete command sequence.

## Security invariants

- Never print, log, return, snapshot, or commit provider access/refresh tokens.
- Never read or copy a developer's `.env*` or `.data/` contents unless the user explicitly requests a narrowly scoped recovery operation.
- Do not weaken same-origin request guards, password-session checks, CSP, public pairing-code controls, notification endpoint validation, or request-size limits.
- Browser-facing account data must remain credential-free.
- Treat refresh tokens as rotating, single-use state. Preserve the owner-fenced coordination, recovery journal, compare-and-set writes, and last-known-good vault behavior.
- Partial Convex or Redis configuration must fail closed.
- Local files are not durable on serverless platforms.
- `TRUST_PROXY_IP_HEADERS` stays opt-in; forwarded IP headers are untrusted unless an overwriting proxy is known.

Several legacy-looking strings are compatibility and cryptographic protocol identifiers. Do not rename them for branding cleanup. This includes the vault key-proof HMAC domain, dedicated-token account-id domain, Redis missing sentinel, existing storage keys, and cookie names. Changing them can make existing vaults unreadable or create duplicate accounts.

## Architecture map

- `app/api/` — authenticated HTTP boundaries, cron entrypoint, and connection routes.
- `components/` — credential-free browser UI.
- `lib/providers/` — provider registry and Anthropic/OpenAI adapters.
- `lib/vault.ts` — encrypted vault selection, validation, recovery, and atomic persistence.
- `lib/usage-service.ts` — cache, refresh coordination, token rotation, and provider dispatch.
- `lib/notify*.ts` — notification configuration, detection, leases, and delivery.
- `convex/` — optional vault, usage coordination, pairing, notification state, and scheduler.
- `public/sw.js` — browser push service worker.
- `scripts/assert-no-vault-traces.mjs` — production-build secret-material guard.

Keep server-only modules out of client components. The browser may submit a credential during an explicit connect action, but successful server persistence must return display metadata only.

## Editing and dependency rules

- Make the smallest change that satisfies the task and preserve unrelated user work.
- Use the existing provider interface instead of branching provider behavior throughout the UI.
- Keep environment behavior documented in both `.env.example` and `docs/SELF_HOSTING.md`.
- When changing dependencies, update `package.json` and `package-lock.json` together with npm.
- Do not commit generated `.next/`, `convex/_generated/`, local vaults, environment files, or inspection artifacts.
- Do not deploy Convex, publish the CLI package, push a branch, or change an external service unless the user explicitly asks.

## Done criteria

A task is complete only when the requested behavior is implemented, relevant tests cover it, the required validation passes, secrets remain absent from the diff, and user-facing setup instructions still describe the actual runtime.
