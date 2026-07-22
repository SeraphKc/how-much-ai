# Security policy

How Much AI stores renewable provider credentials and should be treated like a password manager for the connected accounts. Security reports are welcome and should be handled privately.

## Supported version

Security fixes are made on the latest revision of the default branch. Older commits, forks, and modified deployments are not supported unless the issue also reproduces on the current default branch.

| Version | Supported |
| --- | --- |
| Latest default branch | Yes |
| Older revisions | No |

## Report a vulnerability privately

Use GitHub's private vulnerability reporting flow for [SeraphKc/how-much-ai](https://github.com/SeraphKc/how-much-ai/security/advisories/new). Do not open a public issue, discussion, or pull request containing exploit details, credentials, vault ciphertext, environment files, or provider responses.

If private vulnerability reporting is unavailable, contact the repository owner through their GitHub profile and ask for a private reporting channel. Share only a high-level description until that channel is established.

Include:

- the affected commit;
- deployment topology (local file, Convex, or Redis);
- the smallest reproducible sequence;
- expected and observed behavior;
- security impact;
- whether provider credentials or deployment secrets may have been exposed;
- a proposed fix, if you have one.

Redact access tokens, refresh tokens, cookies, passwords, Convex and Redis credentials, webhook secrets, VAPID private keys, and complete encrypted vault payloads. A maintainer will ask for additional evidence privately if it is necessary.

## High-priority issues

Examples include:

- a way to read or replace another saved credential;
- authentication or same-origin bypasses;
- credential leakage into browser responses, logs, build output, Git history, or third parties;
- vault decryption, key-confusion, rollback, or destructive-recovery flaws;
- refresh-token races that can invalidate the authoritative credential;
- command injection or unsafe target selection in device pairing;
- unbounded public endpoints, server-side request forgery, or notification destination confusion;
- exposure of `.data`, `.env*`, or deployment secrets.

Upstream vulnerabilities in Anthropic, OpenAI, Convex, Redis providers, browsers, or hosting platforms should also be reported to the affected upstream project.

## Deployment security requirements

- An install with no `APP_PASSWORD` is intentionally open. Never expose that mode to an untrusted network.
- Use HTTPS for every remote deployment.
- Keep the vault and all environment values on private, persistent storage.
- Use independent random values for `APP_PASSWORD`, `AUTH_SECRET`, `VAULT_ENCRYPTION_SECRET`, `VAULT_ACCESS_SECRET`, and `CRON_SECRET`.
- Leave `TRUST_PROXY_IP_HEADERS=0` unless a trusted reverse proxy overwrites forwarding headers.
- Restrict outbound traffic where practical; Web Push and configured webhooks make server-side network requests.
- Back up the complete local `.data` directory together. An encrypted vault without its matching key is not recoverable.

## If a secret may be compromised

Stop the affected deployment or remove its network access first. Preserve logs and an offline copy of the encrypted vault for investigation, but do not publish them.

Then rotate the affected session/password, database, scheduler, notification, and provider credentials. Revoke and reconnect provider accounts whose tokens might have been disclosed. Vault encryption and Convex access-secret rotation require a deliberate migration; do not delete an old decryption source until the existing vault has been read and verified with the replacement configuration.
