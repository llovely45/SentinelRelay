# Task 5 method-contract fix report

Status: DONE

## Regression and RED verification

The page routes `/verify/:sessionId` and `/miniapp` are GET pages.  Before this
fix, POST requests fell through to `handleVerificationRequest`, which could
read a verification form and enter the Turnstile flow instead of returning a
method error.

Added regression coverage for both POST routes.  The test also asserts that no
Turnstile fetch occurs and that page responses do not receive verification API
CORS headers.

```text
$ npm test -- tests/worker-router.test.js
✖ verification page routes reject POST without invoking validation
  Expected 405, received 404
```

## Fix

The router now rejects every non-GET method in the `/verify/:sessionId` and
`/miniapp` page branches with a 405 JSON response.  The response is returned
before session/form/Telegram/Turnstile handling and is not wrapped in CORS.
GET behavior remains unchanged: `/miniapp` without a session renders the Mini
App page, while session-bearing GET requests and `/verify/:sessionId` continue
through the existing page/session checks.

## Verification

```text
$ npm test -- tests/worker-router.test.js
ℹ tests 6
ℹ pass 6

$ npm test
ℹ tests 65
ℹ pass 65

$ node --check worker/worker.js
$ node --check tests/worker-router.test.js
$ git diff --check
pass
```

## Files

- `worker/worker.js` — page-route method guards.
- `tests/worker-router.test.js` — POST-method and no-validation regression.
