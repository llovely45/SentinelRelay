/*
 * Deterministic in-memory subset of Cloudflare D1 used by the repository
 * tests.  It intentionally understands the SQL emitted by worker.js rather
 * than pretending to be a full SQLite implementation.  Every prepared
 * statement checks that all positional placeholders were bound, so a test
 * cannot accidentally bless an unsafe query.
 */

function normalizeSql(sql) {
  return String(sql).replace(/\/\*[^]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
}

function countPlaceholders(sql) {
  let count = 0;
  let quote = "";
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      if (character === quote && sql[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "?") {
      count += 1;
    }
  }
  return count;
}

function clone(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

function compareDesc(left, right) {
  return String(right ?? "").localeCompare(String(left ?? "")) || Number(right ?? 0) - Number(left ?? 0);
}

function rowsResult(rows) {
  return { success: true, results: rows.map(clone) };
}

function runResult(changes = 0, lastRowId = undefined) {
  const meta = { changes };
  if (lastRowId !== undefined) meta.last_row_id = lastRowId;
  return { success: true, meta };
}

function statementError(sql) {
  throw new Error(`Fake D1 does not support SQL: ${normalizeSql(sql)}`);
}

export function createFakeD1() {
  const users = new Map();
  const sessions = new Map();
  const labels = new Map();
  const pending = new Map();
  const runtime = new Map();
  let nextLabelId = 1;
  const state = {
    users,
    verification_sessions: sessions,
    fingerprint_labels: labels,
    pending_admin_actions: pending,
    runtime_settings: runtime,
    schemaExecutions: 0,
    queries: []
  };

  function findUserByThread(threadId) {
    return [...users.values()].find((row) => String(row.topic_thread_id) === String(threadId)) || null;
  }

  function execute(sql, params, mode) {
    const normalized = normalizeSql(sql);
    const lower = normalized.toLowerCase();
    state.queries.push({ sql: normalized, params: [...params] });

    if (/^(create|alter|drop)\s/i.test(lower)) return runResult(0);

    if (lower.startsWith("insert into users")) {
      const [userId, username, firstName, lastName, languageCode, createdAt, updatedAt] = params;
      const existing = users.get(String(userId));
      if (existing) {
        Object.assign(existing, {
          username,
          first_name: firstName,
          last_name: lastName,
          language_code: languageCode,
          updated_at: updatedAt
        });
        return runResult(1);
      }
      users.set(String(userId), {
        user_id: userId,
        username,
        first_name: firstName,
        last_name: lastName,
        language_code: languageCode,
        is_verified: 0,
        is_blacklisted: 0,
        topic_thread_id: null,
        verification_prompt_chat_id: null,
        verification_prompt_message_id: null,
        latest_fingerprint_id: null,
        latest_fingerprint_payload: null,
        latest_fingerprint_at: null,
        created_at: createdAt,
        updated_at: updatedAt
      });
      return runResult(1);
    }

    if (lower.startsWith("select * from users where user_id")) {
      const row = users.get(String(params[0]));
      return mode === "first" ? clone(row || null) : rowsResult(row ? [row] : []);
    }

    if (lower.startsWith("select * from users where topic_thread_id")) {
      const row = findUserByThread(params[0]);
      return mode === "first" ? clone(row || null) : rowsResult(row ? [row] : []);
    }

    if (lower.startsWith("update users set")) {
      let changed = 0;
      const userId = params[params.length - 1];
      const row = users.get(String(userId));
      if (!row) return runResult(0);
      if (lower.includes("is_verified = 1") && lower.includes("topic_thread_id = ?")) {
        row.is_verified = 1;
        row.is_blacklisted = 0;
        row.topic_thread_id = params[0];
        row.verification_prompt_chat_id = null;
        row.verification_prompt_message_id = null;
        row.updated_at = params[1];
        changed = 1;
      } else if (lower.includes("is_verified = 1")) {
        row.is_verified = 1;
        row.is_blacklisted = 0;
        row.verification_prompt_chat_id = null;
        row.verification_prompt_message_id = null;
        row.updated_at = params[0];
        changed = 1;
      } else if (lower.includes("verification_prompt_chat_id = ?, verification_prompt_message_id = ?")) {
        row.verification_prompt_chat_id = params[0];
        row.verification_prompt_message_id = params[1];
        row.updated_at = params[2];
        changed = 1;
      } else if (lower.includes("verification_prompt_chat_id = null")) {
        row.verification_prompt_chat_id = null;
        row.verification_prompt_message_id = null;
        row.updated_at = params[0];
        changed = 1;
      } else if (lower.includes("latest_fingerprint_id = ?")) {
        row.latest_fingerprint_id = params[0];
        row.latest_fingerprint_payload = params[1];
        row.latest_fingerprint_at = params[2];
        row.updated_at = params[3];
        changed = 1;
      } else if (lower.includes("is_verified = 0")) {
        row.is_verified = 0;
        row.updated_at = params[0];
        changed = 1;
      } else if (lower.includes("is_blacklisted = 1")) {
        row.is_blacklisted = 1;
        row.updated_at = params[0];
        changed = 1;
      } else if (lower.includes("is_blacklisted = 0")) {
        row.is_blacklisted = 0;
        row.updated_at = params[0];
        changed = 1;
      } else if (lower.includes("topic_thread_id = ?")) {
        row.topic_thread_id = params[0];
        row.updated_at = params[1];
        changed = 1;
      }
      return runResult(changed);
    }

    if (lower.startsWith("insert into verification_sessions")) {
      const [sessionId, userId, createdAt, expiresAt] = params;
      sessions.set(String(sessionId), {
        session_id: sessionId,
        user_id: userId,
        status: "pending",
        fail_reason: null,
        created_at: createdAt,
        expires_at: expiresAt,
        consumed_at: null
      });
      return runResult(1);
    }

    if (lower.includes("from verification_sessions vs join users")) {
      const session = sessions.get(String(params[0]));
      if (!session) return mode === "first" ? null : rowsResult([]);
      const user = users.get(String(session.user_id));
      if (!user) return mode === "first" ? null : rowsResult([]);
      const row = {
        ...session,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        language_code: user.language_code,
        is_verified: user.is_verified,
        is_blacklisted: user.is_blacklisted,
        topic_thread_id: user.topic_thread_id,
        latest_fingerprint_id: user.latest_fingerprint_id,
        latest_fingerprint_payload: user.latest_fingerprint_payload,
        verification_prompt_chat_id: user.verification_prompt_chat_id,
        verification_prompt_message_id: user.verification_prompt_message_id
      };
      return mode === "first" ? clone(row) : rowsResult([row]);
    }

    if (lower.startsWith("select * from verification_sessions")) {
      let found = [...sessions.values()].filter((row) => String(row.user_id) === String(params[0]) && row.status === "pending");
      found.sort((left, right) => compareDesc(left.created_at, right.created_at));
      found = found.slice(0, 1);
      return mode === "first" ? clone(found[0] || null) : rowsResult(found);
    }

    if (lower.startsWith("update verification_sessions set")) {
      const isFailed = lower.includes("status = 'failed'");
      const sessionId = isFailed ? params[2] : params[1];
      const userId = isFailed ? params[3] : params[2];
      const row = sessions.get(String(sessionId));
      if (!row || String(row.user_id) !== String(userId) || (lower.includes("status = 'pending'") && row.status !== "pending")) {
        return runResult(0);
      }
      if (isFailed) {
        row.status = "failed";
        row.fail_reason = params[0];
        row.consumed_at = params[1];
      } else {
        row.status = "passed";
        row.consumed_at = params[0];
      }
      return runResult(1);
    }

    if (lower.startsWith("insert into fingerprint_labels")) {
      const [labelName, note, fingerprintId, fingerprintPayload, sourceUserId, createdByUserId, isBlocked, createdAt] = params;
      const id = nextLabelId++;
      labels.set(String(id), {
        id,
        label_name: labelName,
        note,
        fingerprint_id: fingerprintId,
        fingerprint_payload: fingerprintPayload,
        source_user_id: sourceUserId,
        created_by_user_id: createdByUserId,
        is_blocked: isBlocked,
        created_at: createdAt
      });
      return runResult(1, id);
    }

    if (lower.startsWith("select count(*) as count from fingerprint_labels")) {
      const rows = [...labels.values()].filter((row) => String(row.source_user_id) === String(params[0]));
      const row = { count: rows.length };
      return mode === "first" ? row : rowsResult([row]);
    }

    if (lower.startsWith("select min(id) as id, label_name")) {
      const groups = new Map();
      for (const row of labels.values()) {
        const current = groups.get(row.label_name);
        if (!current) {
          groups.set(row.label_name, {
            id: row.id,
            label_name: row.label_name,
            first_created_at: row.created_at,
            total: 1,
            is_blocked: Number(row.is_blocked || 0)
          });
        } else {
          current.id = Math.min(current.id, row.id);
          current.first_created_at = String(current.first_created_at).localeCompare(String(row.created_at)) <= 0
            ? current.first_created_at : row.created_at;
          current.total += 1;
          current.is_blocked = Math.max(current.is_blocked, Number(row.is_blocked || 0));
        }
      }
      const rows = [...groups.values()].sort((left, right) => left.label_name.localeCompare(right.label_name, undefined, { sensitivity: "base" }));
      return mode === "first" ? clone(rows[0] || null) : rowsResult(rows);
    }

    if (lower.startsWith("select * from fingerprint_labels")) {
      let rows = [...labels.values()];
      if (lower.includes("where is_blocked = 1")) rows = rows.filter((row) => Number(row.is_blocked) === 1);
      if (lower.includes("where source_user_id = ?")) rows = rows.filter((row) => String(row.source_user_id) === String(params[0]));
      if (lower.includes("where label_name = ?")) rows = rows.filter((row) => String(row.label_name) === String(params[0]));
      if (lower.includes("where id = ?")) rows = rows.filter((row) => String(row.id) === String(params[0]));
      rows.sort((left, right) => compareDesc(left.created_at, right.created_at));
      if (lower.includes("limit ? offset ?")) {
        const limit = Number(params[params.length - 2]);
        const offset = Number(params[params.length - 1]);
        rows = rows.slice(offset, offset + limit);
      } else if (lower.includes("limit 1")) {
        rows = rows.slice(0, 1);
      }
      if (mode === "first") return clone(rows[0] || null);
      return rowsResult(rows);
    }

    if (lower.startsWith("delete from fingerprint_labels")) {
      const key = String(params[0]);
      const changed = labels.delete(key) ? 1 : 0;
      return runResult(changed);
    }

    if (lower.startsWith("update fingerprint_labels set is_blocked")) {
      let changed = 0;
      for (const row of labels.values()) {
        if (String(row.label_name) === String(params[1])) {
          row.is_blocked = params[0];
          changed += 1;
        }
      }
      return runResult(changed);
    }

    if (lower.startsWith("insert into pending_admin_actions")) {
      const [threadId, adminId, userId, action, expiresAt, createdAt] = params;
      pending.set(`${threadId}:${adminId}`, {
        thread_id: threadId,
        admin_id: adminId,
        user_id: userId,
        action,
        expires_at: expiresAt,
        created_at: createdAt
      });
      return runResult(1);
    }

    if (lower.startsWith("select * from pending_admin_actions")) {
      const row = pending.get(`${params[0]}:${params[1]}`);
      return mode === "first" ? clone(row || null) : rowsResult(row ? [row] : []);
    }

    if (lower.startsWith("delete from pending_admin_actions")) {
      const changed = pending.delete(`${params[0]}:${params[1]}`) ? 1 : 0;
      return runResult(changed);
    }

    if (lower.startsWith("insert into runtime_settings")) {
      const [key, value, updatedAt] = params;
      runtime.set(String(key), { key, value, updated_at: updatedAt });
      return runResult(1);
    }

    if (lower.startsWith("select value from runtime_settings")) {
      const row = runtime.get(String(params[0]));
      return mode === "first" ? clone(row || null) : rowsResult(row ? [row] : []);
    }

    return statementError(sql);
  }

  function prepare(sql) {
    let params = null;
    const statement = {
      bind(...values) {
        params = values;
        return statement;
      },
      async run() {
        if (params === null) params = [];
        const required = countPlaceholders(String(sql));
        if (params.length < required) throw new Error("Fake D1 statement has an unbound value");
        return execute(sql, params, "run");
      },
      async first(column) {
        if (params === null) params = [];
        const required = countPlaceholders(String(sql));
        if (params.length < required) throw new Error("Fake D1 statement has an unbound value");
        const row = execute(sql, params, "first");
        return column && row ? row[column] : row;
      },
      async all() {
        if (params === null) params = [];
        const required = countPlaceholders(String(sql));
        if (params.length < required) throw new Error("Fake D1 statement has an unbound value");
        const result = execute(sql, params, "all");
        return Array.isArray(result) ? rowsResult(result) : result;
      }
    };
    return statement;
  }

  return {
    state,
    get schemaExecutions() { return state.schemaExecutions; },
    get queries() { return state.queries; },
    async exec(sql) {
      state.schemaExecutions += 1;
      return execute(sql, [], "run");
    },
    prepare,
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }
  };
}
