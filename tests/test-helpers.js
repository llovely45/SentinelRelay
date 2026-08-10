export function createMemoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    get length() {
      return entries.size;
    },
    key(index) {
      return [...entries.keys()][index] ?? null;
    },
    getItem(key) {
      const value = entries.get(String(key));
      return value === undefined ? null : value;
    },
    setItem(key, value) {
      entries.set(String(key), String(value));
    },
    removeItem(key) {
      entries.delete(String(key));
    },
    clear() {
      entries.clear();
    }
  };
}

export function fakeTelegram(responses = {}) {
  const calls = [];
  const record = (method, defaultResult = {}) => async (...args) => {
    calls.push({ method, args, payload: args.length === 1 ? args[0] : undefined });
    return responses[method] === undefined ? defaultResult : responses[method];
  };

  return {
    calls,
    async call(method, payload) {
      calls.push({ method, args: [payload], payload });
      return responses[method] === undefined ? true : responses[method];
    },
    getMe: record("getMe", { id: 1, is_bot: true, first_name: "SentinelRelay" }),
    getChat: record("getChat", { id: -100123, type: "supergroup", title: "SentinelRelay" }),
    getChatMember: record("getChatMember", { status: "administrator" }),
    setWebhook: record("setWebhook", true),
    sendMessage: record("sendMessage", { message_id: 1 }),
    copyMessage: record("copyMessage", { message_id: 1 }),
    createForumTopic: record("createForumTopic", { message_thread_id: 1, name: "Verification" }),
    answerCallbackQuery: record("answerCallbackQuery", true),
    editMessageText: record("editMessageText", { message_id: 1 }),
    deleteMessage: record("deleteMessage", true)
  };
}

export function fakeStoreWithExpiredSession() {
  const expiredSession = {
    session_id: "expired",
    user_id: 1,
    status: "pending",
    expires_at: "2000-01-01T00:00:00.000Z"
  };
  return {
    expiredSession,
    async getSession(sessionId) {
      return sessionId === expiredSession.session_id ? { ...expiredSession } : null;
    }
  };
}

export function createTestEnv(overrides = {}) {
  const telegramCalls = [];
  const db = {
    async exec() {
      return { success: true };
    },
    prepare() {
      const statement = {
        bind() {
          return statement;
        },
        async run() {
          return { success: true, meta: { changes: 0 } };
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        }
      };
      return statement;
    },
    async batch(statements) {
      return statements.map(() => ({ success: true, meta: { changes: 0 } }));
    }
  };
  const telegram = fakeTelegram();
  const wrappedTelegram = new Proxy(telegram, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || property === "calls") return value;
      return async (...args) => {
        telegramCalls.push({ method: property, args });
        return value(...args);
      };
    }
  });

  return {
    DB: db,
    TG_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyzABCDE",
    TG_GROUP_ID: "-100123",
    APP_BASE_URL: "https://worker.example",
    TURNSTILE_SITE_KEY: "site-key",
    TURNSTILE_SECRET_KEY: "secret-key",
    TG_WEBHOOK_SECRET: "a-webhook-secret-long-enough",
    VERIFICATION_TTL_MINUTES: "30",
    STUN_SERVER_URL: "stun:stun.example:3478",
    telegram: wrappedTelegram,
    telegramCalls,
    ...overrides
  };
}

export function fakeExecutionContext() {
  const promises = [];
  return {
    promises,
    waitUntil(promise) {
      promises.push(promise);
    },
    passThroughOnException() {}
  };
}
