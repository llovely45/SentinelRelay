function readJson(storage, key) {
  try {
    if (!storage || typeof storage.getItem !== "function") return null;
    const raw = storage.getItem(key);
    if (typeof raw !== "string" || raw.length === 0) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(storage, key, value) {
  try {
    if (!storage || typeof storage.setItem !== "function") return;
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage can fail in private browsing mode, when quota is full, or
    // when a security policy blocks access. The reminder gate is best-effort.
  }
}

function isFiniteTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Return the best-effort local Star reminder state. */
export function getStarGateState(storage, key) {
  const record = readJson(storage, key);
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    !isFiniteTimestamp(record.redirectedAt) ||
    typeof record.repoUrl !== "string" ||
    record.repoUrl.length === 0
  ) {
    return "new";
  }
  return isFiniteTimestamp(record.verifiedAt) ? "verified" : "redirected";
}

/** Return the delayed modal action for each local gate state. */
export function getStarGatePrompt(state) {
  if (state === "new") return { button: "点击跳转", action: "redirect" };
  if (state === "redirected") return { button: "我已验证", action: "verify" };
  return { button: "", action: "pass" };
}

/** Persist only the redirect timestamp and repository URL under the Star key. */
export function markStarRedirect(storage, key, repoUrl, now = Date.now()) {
  const timestamp = now instanceof Date ? now.getTime() : now;
  writeJson(storage, key, { redirectedAt: timestamp, repoUrl: String(repoUrl) });
}

/** Persist the local confirmation that follows the second protected action. */
export function markStarVerified(storage, key, now = Date.now()) {
  const timestamp = now instanceof Date ? now.getTime() : now;
  const record = readJson(storage, key);
  const repoUrl = record && typeof record === "object" && typeof record.repoUrl === "string"
    ? record.repoUrl
    : "";
  writeJson(storage, key, {
    redirectedAt: isFiniteTimestamp(record?.redirectedAt) ? record.redirectedAt : timestamp,
    repoUrl,
    verifiedAt: timestamp
  });
}

/** Read the pending action value, returning null for malformed/unavailable data. */
export function getPendingAction(storage, key) {
  const record = readJson(storage, key);
  if (!record || typeof record !== "object" || Array.isArray(record) || !Object.hasOwn(record, "action")) {
    return null;
  }
  return record.action ?? null;
}

/** Persist only an action property under the pending-action key. */
export function setPendingAction(storage, key, action) {
  writeJson(storage, key, { action });
}
