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

export const CONFIG_ERRORS = Object.freeze({
  TG_BOT_TOKEN: "TG_BOT_TOKEN 格式或长度无效",
  TG_GROUP_ID: "TG_GROUP_ID 必须是数字",
  APP_BASE_URL: "APP_BASE_URL 必须使用自定义 HTTPS 域名，不能使用 workers.dev 或末尾斜杠",
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
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (hostname === "workers.dev" || hostname.endsWith(".workers.dev")) return false;
    return url.protocol === "https:"
      && Boolean(hostname)
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

function isNumericGroupId(value) {
  return typeof value === "number"
    ? Number.isSafeInteger(value)
    : typeof value === "string" && /^-?\d+$/.test(value);
}

/** Validate one visible configuration field and return its user-facing error. */
export function validateDeployField(name, value) {
  switch (name) {
    case "TG_BOT_TOKEN":
      return isTelegramToken(value) ? "" : CONFIG_ERRORS.TG_BOT_TOKEN;
    case "TG_GROUP_ID":
      return isNumericGroupId(value) ? "" : CONFIG_ERRORS.TG_GROUP_ID;
    case "APP_BASE_URL":
      return isHttpsUrlWithoutTrailingSlash(value) ? "" : CONFIG_ERRORS.APP_BASE_URL;
    case "TURNSTILE_SITE_KEY":
      return isNonEmptyString(value) ? "" : CONFIG_ERRORS.TURNSTILE_SITE_KEY;
    case "TURNSTILE_SECRET_KEY":
      return isNonEmptyString(value) ? "" : CONFIG_ERRORS.TURNSTILE_SECRET_KEY;
    case "TG_WEBHOOK_SECRET":
      return typeof value === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(value)
        ? ""
        : CONFIG_ERRORS.TG_WEBHOOK_SECRET;
    case "VERIFICATION_TTL_MINUTES":
      return isIntegerInRange(value, 5, 1440) ? "" : CONFIG_ERRORS.VERIFICATION_TTL_MINUTES;
    case "STUN_SERVER_URL":
      return typeof value === "string" && value.startsWith("stun:")
        ? ""
        : CONFIG_ERRORS.STUN_SERVER_URL;
    default:
      return "";
  }
}

/**
 * Validate values collected by the static deployment page.
 *
 * The error ordering is part of the UI contract: callers can render the
 * returned array directly and tests can rely on stable, deterministic output.
 */
export function validateDeployConfig(values = {}) {
  const input = values && typeof values === "object" ? values : {};
  const errors = DEPLOY_MARKERS
    .map((name) => validateDeployField(name, input[name]))
    .filter(Boolean);

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
