# Cloudflare Pages 部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the GitHub repository directly deployable as a Cloudflare Pages static site that opens the browser deployment wizard while keeping the D1-backed Telegram Worker as a separate deployment.

**Architecture:** Cloudflare Pages serves the repository root as static output. A root `index.html` redirects to `deploy/index.html`, and the wizard fetches the same-origin `worker/worker.js` template. `_headers` provides static security/cache headers; no secrets or build-time substitution are added.

**Tech Stack:** HTML, Cloudflare Pages static Git integration, `_headers`, existing Node test suite.

## Global Constraints

- Pages build command is empty because the site is static.
- Pages output directory is `.`.
- Telegram Worker remains separately deployed with D1 binding `DB`.
- Secrets stay in browser memory and are never committed or sent to Pages.
- Preserve the user’s existing unstaged deletion of `go.mod`.

---

### Task 1: Add the Pages static entry and headers

**Files:**
- Create: `index.html`
- Create: `_headers`
- Test: `tests/pages-deployment.test.js`

**Interfaces:**
- `index.html` redirects `/` to `/deploy/index.html` without third-party code.
- `_headers` declares CSP, frame, referrer, MIME-sniffing, and cache behavior for static Pages responses.

- [ ] **Step 1: Write the failing test**

  Add tests that read the root entry and `_headers`, assert the deploy redirect target, reject external scripts in the root entry, and assert the required Pages header declarations.

- [ ] **Step 2: Run the focused test to verify it fails**

  Run: `npm test -- tests/pages-deployment.test.js`

  Expected: FAIL because `index.html`, `_headers`, and the test file do not yet exist.

- [ ] **Step 3: Write the minimal static files**

  Create an HTML redirect with a visible fallback link to `/deploy/index.html`. Create `_headers` with a default CSP allowing only same-origin resources plus the existing Turnstile and Telegram script origins, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-cache` for `/`, `/deploy/index.html`, and `/worker/worker.js`.

- [ ] **Step 4: Run the focused test to verify it passes**

  Run: `npm test -- tests/pages-deployment.test.js`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add index.html _headers tests/pages-deployment.test.js
  git commit -m "feat: prepare static Cloudflare Pages entry"
  ```

### Task 2: Document GitHub-to-Pages deployment

**Files:**
- Modify: `README.md`
- Modify: `deploy/README.md`

**Interfaces:**
- Documentation names the GitHub repository connection settings exactly: production branch `main`, build command empty, output directory `.`.
- Documentation explains that Pages hosts only the wizard and the generated Worker still needs independent Workers + D1 deployment.

- [ ] **Step 1: Update the deployment documentation**

  Add a Pages section with Dashboard steps: Workers & Pages → Create → Pages → Connect to Git → select `llovely45/SentinelRelay` → production branch `main` → no build command → output directory `.` → Save and Deploy. Include the resulting `/deploy/index.html` path and the root redirect behavior.

- [ ] **Step 2: Run documentation and full regression checks**

  Run: `npm test && node --check deploy/generator.js && node --check deploy/gate.js && node --check worker/worker.js && git diff --check`

  Expected: all tests pass and all checks exit successfully.

- [ ] **Step 3: Commit**

  ```bash
  git add README.md deploy/README.md
  git commit -m "docs: add Cloudflare Pages GitHub deployment"
  ```

### Task 3: Verify static HTTP behavior and push

**Files:**
- No additional files.

**Interfaces:**
- The repository’s static output serves `/`, `/deploy/index.html`, and `/worker/worker.js`.

- [ ] **Step 1: Run the static HTTP smoke test**

  Start `python3 -m http.server` from the repository root and request all three paths with `curl`; expect HTTP 200 for each and verify the root page references `/deploy/index.html`.

- [ ] **Step 2: Push `main`**

  Run: `git push origin main`

- [ ] **Step 3: Confirm the remote ref**

  Run: `git ls-remote --heads origin main`

  Expected: the returned commit matches local `main`.
