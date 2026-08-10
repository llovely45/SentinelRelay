# Task 5 review-fix report

Status: DONE

## Regression and RED verification

The original Task 5 implementation consulted the isolate WeakMap after a D1
read.  If D1 contained an older, non-empty digest while the isolate cache held
the current digest, `ensureWebhook` incorrectly returned `{ skipped: true }`
and did not re-register Telegram's webhook.

Added regression: `a persisted webhook digest change overrides the isolate
cache`.  It performs one registration, changes the persisted value to a stale
digest, and requires a second `setWebhook` call.

```text
$ npm test -- tests/worker-router.test.js
✖ a persisted webhook digest change overrides the isolate cache
  Expected { registered: true, skipped: false }
  Received { registered: false, skipped: true }
```

## Fix

The WeakMap fast path now runs only when D1 returns a missing/empty value
(`null`, `undefined`, or an empty string).  A non-empty persisted digest that
does not equal the current digest always reaches `setWebhook` and updates D1.
The persisted equal-digest path remains a normal `{ skipped: true }` result.

## Verification

```text
$ npm test -- tests/worker-router.test.js
ℹ tests 5
ℹ pass 5
ℹ fail 0

$ npm test
ℹ tests 64
ℹ pass 64
ℹ fail 0

$ node --check worker/worker.js
$ node --check tests/worker-router.test.js
$ git diff --check
pass
```

## Files

- `worker/worker.js` — narrowed the non-persistent WeakMap fallback.
- `tests/worker-router.test.js` — persisted-digest-change regression.
