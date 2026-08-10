import test from "node:test";
import assert from "node:assert/strict";
import {
  renderMiniAppVerificationPage,
  renderResultPage,
  renderVerificationPage
} from "../worker/worker.js";

test("verification page escapes site key and includes Turnstile and signal fields", () => {
  const html = renderVerificationPage({ siteKey: 'site"&', sessionId: "abc" });
  assert.match(html, /site&quot;&amp;/);
  assert.match(html, /cf-turnstile/);
  assert.match(html, /fingerprint_payload/);
  assert.match(html, /webrtc_ip/);
  assert.match(html, /反滥用/);
});

test("mini app page resolves its session start parameter and renders a privacy notice", () => {
  const html = renderMiniAppVerificationPage({ siteKey: "site-key" });
  assert.match(html, /telegram-web-app\.js/);
  assert.match(html, /tgWebAppStartParam/);
  assert.match(html, /指纹/);
});

test("result page escapes title and description", () => {
  const html = renderResultPage({ title: "<blocked>", description: 'x"&y' });
  assert.match(html, /&lt;blocked&gt;/);
  assert.match(html, /x&quot;&amp;y/);
  assert.doesNotMatch(html, /<blocked>/);
});
