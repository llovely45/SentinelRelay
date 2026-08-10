# Final security fix report

Status: complete on `codex/sentinelrelay-worker`.

Commits: `fa3fc28` (`fix: harden Worker validation and Telegram retries`) and `19a8b74` (`fix: namespace and prune Telegram update claims`). The preceding Task 7 documentation/marker commit remains `4a2afd5`.

Implemented:

- `APP_BASE_URL` now accepts only an HTTPS root origin with no path, query, or fragment; Telegram Webhook secrets require 16–256 characters from `[A-Za-z0-9_-]`.
- Webhook registration digests include a SHA-256 Bot Token digest, so token rotation re-registers without persisting the raw token.
- Verification input is bounded before Turnstile: WebRTC text, valid IP count (8), fingerprint JSON (64 KiB), recursive field/depth/object limits, and Turnstile token length. Oversized data returns 413; malformed fingerprint data returns 400.
- Added D1-backed `processed_telegram_updates` leases with atomic claim, stale-lease takeover, completion, and failure release. Telegram update processing now suppresses completed retries while allowing failed retries.
- Added deterministic fake-D1 support and regression tests for all of the above.

Residual hardening:

- Namespaced processed-update claims by a SHA-256 Bot-token digest, so one `update_id` from different Bots is independent without persisting raw credentials. The D1 key now uses `(bot_namespace, update_id)` with the update ID stored as text.
- Completed processed-update rows are pruned opportunistically at claim time with a minimum seven-day retention window.
- Added a 128 KiB `Content-Length` preflight for verification POSTs; requests without a trustworthy declaration still receive field-level bounds during parsing.
- Success-path Telegram notifications are now best-effort after the D1 verification commit, so a transient notification failure cannot report a false 500 or undo a completed verification.
- The deployment URL validator rejects userinfo, and README/deploy documentation calls out the required recreation or migration step for pre-namespaced processed-update tables.

Verification (one-line results):

- `npm test` — 84 passed, 0 failed.
- `node --check deploy/generator.js && node --check deploy/gate.js && node --check worker/worker.js` — passed.
- `git diff --check` — passed before commit.

Follow-up verification after the final review fixes:

- `npm test` — 85 passed, 0 failed.
- `node --check worker/worker.js && node --check deploy/generator.js && node --check deploy/gate.js` — passed.
- `git diff --check` — passed.

Concerns: form parsing still occurs before field-level limits when the request omits a trustworthy `Content-Length`; expensive Turnstile and metadata work are blocked before invocation. Existing D1 installations created before the namespaced schema should be migrated or recreated before deploying this follow-up.
