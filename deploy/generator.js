/**
 * Configuration markers understood by the static deployment generator.
 * Keeping this list in one place makes it possible to detect a leaked marker
 * before generated source is shown to a user.
 */
export const DEPLOY_MARKERS = Object.freeze([
  "TG_BOT_TOKEN",
  "TG_GROUP_ID",
  "APP_BASE_URL",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "TG_WEBHOOK_SECRET",
  "VERIFICATION_TTL_MINUTES",
  "STUN_SERVER_URL"
]);

const MARKER_SET = new Set(DEPLOY_MARKERS);
const QUOTED_MARKER_RE = /(["'])__(TG_BOT_TOKEN|TG_GROUP_ID|APP_BASE_URL|TURNSTILE_SITE_KEY|TURNSTILE_SECRET_KEY|TG_WEBHOOK_SECRET|VERIFICATION_TTL_MINUTES|STUN_SERVER_URL)__\1/g;

const CONFIG_ERRORS = Object.freeze({
  TG_BOT_TOKEN: "TG_BOT_TOKEN 格式或长度无效",
  TG_GROUP_ID: "TG_GROUP_ID 必须是数字",
  APP_BASE_URL: "APP_BASE_URL 必须使用 HTTPS 且不能带末尾斜杠",
  TURNSTILE_SITE_KEY: "TURNSTILE_SITE_KEY 不能为空",
  TURNSTILE_SECRET_KEY: "TURNSTILE_SECRET_KEY 不能为空",
  TG_WEBHOOK_SECRET: "TG_WEBHOOK_SECRET 至少需要 16 个字符",
  VERIFICATION_TTL_MINUTES: "VERIFICATION_TTL_MINUTES 必须是 5 到 1440 之间的整数",
  STUN_SERVER_URL: "STUN_SERVER_URL 必须以 stun: 开头"
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isTelegramToken(value) {
  // Telegram bot IDs are decimal digits followed by a colon and a long
  // base64url-like secret.  The lower bounds intentionally allow test/bot
  // IDs from older Telegram deployments while still rejecting placeholders.
  return typeof value === "string" && /^\d{3,12}:[A-Za-z0-9_-]{20,}$/.test(value);
}

function isHttpsUrlWithoutTrailingSlash(value) {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value) || value.endsWith("/")) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && url.pathname === "/"
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function isIntegerInRange(value, min, max) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= min && value <= max;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max;
}

/**
 * Validate values collected by the static deployment page.
 *
 * The error ordering is part of the UI contract: callers can render the
 * returned array directly and tests can rely on stable, deterministic output.
 */
export function validateDeployConfig(values = {}) {
  const input = values && typeof values === "object" ? values : {};
  const errors = [];

  if (!isTelegramToken(input.TG_BOT_TOKEN)) errors.push(CONFIG_ERRORS.TG_BOT_TOKEN);

  const groupId = input.TG_GROUP_ID;
  const isNumericGroup = typeof groupId === "number"
    ? Number.isSafeInteger(groupId)
    : typeof groupId === "string" && /^-?\d+$/.test(groupId);
  if (!isNumericGroup) errors.push(CONFIG_ERRORS.TG_GROUP_ID);

  if (!isHttpsUrlWithoutTrailingSlash(input.APP_BASE_URL)) {
    errors.push(CONFIG_ERRORS.APP_BASE_URL);
  }

  if (!isNonEmptyString(input.TURNSTILE_SITE_KEY)) {
    errors.push(CONFIG_ERRORS.TURNSTILE_SITE_KEY);
  }

  if (!isNonEmptyString(input.TURNSTILE_SECRET_KEY)) {
    errors.push(CONFIG_ERRORS.TURNSTILE_SECRET_KEY);
  }

  if (typeof input.TG_WEBHOOK_SECRET !== "string"
    || !/^[A-Za-z0-9_-]{16,256}$/.test(input.TG_WEBHOOK_SECRET)) {
    errors.push(CONFIG_ERRORS.TG_WEBHOOK_SECRET);
  }

  if (!isIntegerInRange(input.VERIFICATION_TTL_MINUTES, 5, 1440)) {
    errors.push(CONFIG_ERRORS.VERIFICATION_TTL_MINUTES);
  }

  if (typeof input.STUN_SERVER_URL !== "string" || !input.STUN_SERVER_URL.startsWith("stun:")) {
    errors.push(CONFIG_ERRORS.STUN_SERVER_URL);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Replace quoted deployment markers with JavaScript string/primitive literals.
 *
 * A marker is replaced only when it is the complete contents of a single- or
 * double-quoted string. This prevents accidental substitutions in comments or
 * larger user-facing strings. Any remaining uppercase marker is considered a
 * generation error so a secret can never be silently omitted.
 */
export function replaceWorkerPlaceholders(template, values = {}) {
  if (typeof template !== "string") {
    throw new TypeError("Worker template must be a string");
  }
  const input = values && typeof values === "object" ? values : {};
  const output = template.replace(QUOTED_MARKER_RE, (_match, _quote, marker) => {
    // QUOTED_MARKER_RE is built from DEPLOY_MARKERS, but keep this guard close
    // to the replacement so future edits cannot replace an unknown marker.
    if (!MARKER_SET.has(marker)) return _match;
    return JSON.stringify(String(input[marker]));
  });

  // Deliberately scan after replacement rather than only checking known
  // markers. A template containing a new `__UPPERCASE_MARKER__` must fail
  // closed until the generator explicitly supports it.
  const unresolved = output.match(/__[A-Z][A-Z0-9_]*__/g);
  if (unresolved) {
    throw new Error(`Unresolved worker placeholder: ${[...new Set(unresolved)].join(", ")}`);
  }
  return output;
}
