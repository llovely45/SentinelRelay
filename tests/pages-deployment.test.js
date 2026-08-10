import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rootEntry = () => readFileSync(new URL("../index.html", import.meta.url), "utf8");
const headersFile = () => readFileSync(new URL("../_headers", import.meta.url), "utf8");

test("Pages root entry points visitors to the deployment wizard", () => {
  const html = rootEntry();
  assert.match(html, /url\s*=\s*["']?\/deploy\/index\.html/i);
  assert.match(html, /href=["']\/deploy\/index\.html["']/i);
  assert.doesNotMatch(html, /<script\b[^>]+src=/i);
});

test("Pages headers protect and keep generated-template resources fresh", () => {
  const headers = headersFile();
  assert.match(headers, /X-Content-Type-Options:\s*nosniff/i);
  assert.match(headers, /X-Frame-Options:\s*DENY/i);
  assert.match(headers, /Referrer-Policy:\s*no-referrer/i);
  assert.match(headers, /Content-Security-Policy:/i);
  assert.match(headers, /\/deploy\/index\.html[\s\S]*Cache-Control:\s*no-cache/i);
  assert.match(headers, /\/worker\/worker\.js[\s\S]*Cache-Control:\s*no-cache/i);
});
