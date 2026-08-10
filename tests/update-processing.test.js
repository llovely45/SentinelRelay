import test from "node:test";
import assert from "node:assert/strict";
import { buildFingerprintMeta, createStore, processTelegramUpdate } from "../worker/worker.js";
import { createFakeD1 } from "./fake-d1.js";
import { fakeTelegram } from "./test-helpers.js";

const config = {
  groupId: -100123,
  appBaseUrl: "https://worker.example",
  verificationTtlMinutes: 30
};

async function makeStore() {
  const store = createStore(createFakeD1());
  await store.ensureSchema();
  return store;
}

test("private unverified messages create a session and replace the prior verification prompt", async () => {
  const store = await makeStore();
  const telegram = fakeTelegram();
  await processTelegramUpdate({
    message: {
      message_id: 1,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Alice" },
      text: "hello"
    }
  }, { config, store, telegram });
  await processTelegramUpdate({
    message: {
      message_id: 2,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Alice" },
      text: "again"
    }
  }, { config, store, telegram });

  const user = await store.getUser(42);
  assert.ok(user.verification_prompt_message_id);
  assert.equal(telegram.calls.filter((call) => call.method === "createVerificationSession").length, 0);
  assert.deepEqual(telegram.calls.filter((call) => call.method === "deleteMessage").map((call) => call.args), [[42, 1]]);
  const prompts = telegram.calls.filter((call) => call.method === "sendMessage");
  assert.equal(prompts.length, 2);
  assert.match(prompts[0].args[1], /完成验证/);
  assert.equal(prompts[0].args[2].reply_markup.inline_keyboard[0][0].web_app.url,
    "https://worker.example/miniapp?startapp=" + encodeURIComponent((await store.getLatestPendingSessionForUser(42)).session_id));
});

test("verified private messages copy to the user's forum topic", async () => {
  const store = await makeStore();
  const telegram = fakeTelegram();
  await store.upsertTelegramUser({ id: 7, first_name: "Alice" });
  await store.approveUser(7);
  await store.setTopicThreadId(7, 888);

  await processTelegramUpdate({
    message: {
      message_id: 9,
      chat: { id: 7, type: "private" },
      from: { id: 7, username: "alice", first_name: "Alice" },
      photo: [{ file_id: "photo" }]
    }
  }, { config, store, telegram });

  assert.deepEqual(telegram.calls.find((call) => call.method === "copyMessage").args,
    [config.groupId, 7, 9, { message_thread_id: 888 }]);
});

test("verified private messages create a forum topic before first relay", async () => {
  const store = await makeStore();
  const telegram = fakeTelegram({
    createForumTopic: { message_thread_id: 777, name: "Alice" }
  });
  await store.upsertTelegramUser({ id: 7, username: "alice", first_name: "Alice" });
  await store.approveUser(7);

  await processTelegramUpdate({
    message: {
      message_id: 10,
      chat: { id: 7, type: "private" },
      from: { id: 7, username: "alice", first_name: "Alice" },
      text: "first"
    }
  }, { config, store, telegram });

  assert.equal((await store.getUser(7)).topic_thread_id, 777);
  assert.deepEqual(telegram.calls.filter((call) => call.method === "createForumTopic")[0].args, [config.groupId, "Alice (@alice)"]);
  assert.deepEqual(telegram.calls.filter((call) => call.method === "copyMessage")[0].args,
    [config.groupId, 7, 10, { message_thread_id: 777 }]);
});

test("group topic messages copy back to the mapped private chat", async () => {
  const store = await makeStore();
  const telegram = fakeTelegram();
  await store.upsertTelegramUser({ id: 7, first_name: "Alice" });
  await store.approveUser(7);
  await store.setTopicThreadId(7, 888);

  await processTelegramUpdate({
    message: {
      message_id: 12,
      message_thread_id: 888,
      chat: { id: config.groupId, type: "supergroup" },
      from: { id: 99, is_bot: false },
      text: "reply"
    }
  }, { config, store, telegram });

  assert.deepEqual(telegram.calls.find((call) => call.method === "copyMessage").args,
    [7, config.groupId, 12]);
});

test("group topic messages do not relay for an unverified mapped user", async () => {
  const store = await makeStore();
  const telegram = fakeTelegram();
  await store.upsertTelegramUser({ id: 70, first_name: "Pending" });
  await store.setTopicThreadId(70, 890);

  await processTelegramUpdate({
    message: {
      message_id: 15,
      message_thread_id: 890,
      chat: { id: config.groupId, type: "supergroup" },
      from: { id: 99, is_bot: false },
      text: "must not relay"
    }
  }, { config, store, telegram });

  assert.equal(telegram.calls.some((call) => call.method === "copyMessage"), false);
});

test("/admin checks membership and renders callback keyboard for the mapped topic", async () => {
  const store = await makeStore();
  const telegram = fakeTelegram();
  await store.upsertTelegramUser({ id: 7, username: "alice", first_name: "Alice" });
  await store.approveUser(7);
  await store.setTopicThreadId(7, 888);

  await processTelegramUpdate({
    message: {
      message_id: 13,
      message_thread_id: 888,
      chat: { id: config.groupId, type: "supergroup" },
      from: { id: 99 },
      text: "/admin"
    }
  }, { config, store, telegram });

  const sent = telegram.calls.find((call) => call.method === "sendMessage");
  assert.equal(telegram.calls.find((call) => call.method === "getChatMember").args.join(","), `${config.groupId},99`);
  assert.match(sent.args[1], /用户管理/);
  assert.equal(sent.args[2].message_thread_id, 888);
  assert.ok(sent.args[2].reply_markup.inline_keyboard.some((row) => row.some((button) => button.callback_data === "topicadmin:cancel:7")));
});

test("mark fingerprint callback persists a D1 pending admin action and label input consumes it", async () => {
  const store = await makeStore();
  const telegram = fakeTelegram();
  const meta = await buildFingerprintMeta({ system: "Linux", fingerprint: { canvas: "same" } });
  await store.upsertTelegramUser({ id: 7, first_name: "Alice" });
  await store.approveUser(7);
  await store.setTopicThreadId(7, 888);
  await store.setLatestFingerprint(7, meta);

  await processTelegramUpdate({
    callback_query: {
      id: "cb-1",
      from: { id: 99 },
      message: { message_id: 14, message_thread_id: 888, chat: { id: config.groupId, type: "supergroup" } },
      data: "topicadmin:markfp:7"
    }
  }, { config, store, telegram });

  const pending = await store.getPendingAdminAction(888, 99);
  assert.equal(pending.user_id, 7);
  assert.deepEqual(pending.action, { type: "markfp", isBlocked: false });

  await processTelegramUpdate({
    message: {
      message_id: 15,
      message_thread_id: 888,
      chat: { id: config.groupId, type: "supergroup" },
      from: { id: 99 },
      text: "office|trusted"
    }
  }, { config, store, telegram });

  assert.equal(await store.getPendingAdminAction(888, 99), null);
  const labels = await store.getFingerprintLabelsByName("office");
  assert.equal(labels.length, 1);
  assert.equal(labels[0].note, "trusted");
  assert.match(telegram.calls.filter((call) => call.method === "sendMessage").at(-1).args[1], /指纹标记已保存/);
});

test("callback actions update state and refresh label pages", async () => {
  const store = await makeStore();
  const telegram = fakeTelegram();
  await store.upsertTelegramUser({ id: 7, first_name: "Alice" });
  await store.upsertTelegramUser({ id: 99, first_name: "Admin" });
  await store.setTopicThreadId(7, 888);
  await store.setLatestFingerprint(7, await buildFingerprintMeta({ fingerprint: { canvas: "x" } }));

  await processTelegramUpdate({
    callback_query: {
      id: "cb-approve",
      from: { id: 99 },
      message: { message_id: 20, message_thread_id: 888, chat: { id: config.groupId, type: "supergroup" } },
      data: "topicadmin:approve:7"
    }
  }, { config, store, telegram });
  assert.equal((await store.getUser(7)).is_verified, 1);
  assert.ok(telegram.calls.some((call) => call.method === "answerCallbackQuery" && call.args[1] === "已通过验证"));

  await store.createFingerprintLabel({
    labelName: "office", note: "x", fingerprintMeta: (await store.getUser(7)).latest_fingerprint_meta,
    sourceUserId: 7, createdByUserId: 99
  });
  await processTelegramUpdate({
    callback_query: {
      id: "cb-labels",
      from: { id: 99 },
      message: { message_id: 21, message_thread_id: 888, chat: { id: config.groupId, type: "supergroup" } },
      data: "topicadmin:labels:7:1"
    }
  }, { config, store, telegram });
  const edit = telegram.calls.find((call) => call.method === "editMessageText");
  assert.match(edit.args[2], /指纹标签/);
  assert.ok(edit.args[3].reply_markup.inline_keyboard.some((row) => row.some((button) => button.callback_data?.startsWith("topicadmin:dellabel:7:"))));
});

test("delete-label callback cannot delete a label belonging to another topic user", async () => {
  const store = await makeStore();
  const telegram = fakeTelegram();
  const meta = await buildFingerprintMeta({ fingerprint: { canvas: "other" } });
  await store.upsertTelegramUser({ id: 7, first_name: "Alice" });
  await store.upsertTelegramUser({ id: 8, first_name: "Bob" });
  await store.setTopicThreadId(7, 888);
  await store.setTopicThreadId(8, 889);
  const label = await store.createFingerprintLabel({
    labelName: "bob-label",
    fingerprintMeta: meta,
    sourceUserId: 8,
    createdByUserId: 99
  });

  await processTelegramUpdate({
    callback_query: {
      id: "cb-cross-user-delete",
      from: { id: 99 },
      message: { message_id: 30, message_thread_id: 888, chat: { id: config.groupId, type: "supergroup" } },
      data: `topicadmin:dellabel:7:${label.id}:1`
    }
  }, { config, store, telegram });

  assert.equal((await store.getFingerprintLabelById(label.id)).label_name, "bob-label");
  assert.equal(telegram.calls.some((call) => call.method === "editMessageText"), false);
});

test("pending fingerprint actions are consumed once", async () => {
  const store = await makeStore();
  await store.upsertPendingAdminAction({
    threadId: 888,
    adminId: 99,
    userId: 7,
    action: { type: "markfp", isBlocked: false },
    expiresAt: "2099-01-01T00:00:00.000Z"
  });

  const first = await store.consumePendingAdminAction(888, 99, "markfp");
  const second = await store.consumePendingAdminAction(888, 99, "markfp");
  assert.deepEqual(first.action, { type: "markfp", isBlocked: false });
  assert.equal(second, null);
});

test("a duplicate pending-label delivery that loses the claim is not relayed privately", async () => {
  const store = await makeStore();
  const telegram = fakeTelegram();
  await store.upsertTelegramUser({ id: 7, first_name: "Alice" });
  await store.approveUser(7);
  await store.setTopicThreadId(7, 888);
  store.consumePendingAdminAction = async () => ({ action: null, consumed: false });

  await processTelegramUpdate({
    message: {
      message_id: 31,
      message_thread_id: 888,
      chat: { id: config.groupId, type: "supergroup" },
      from: { id: 99 },
      text: "office|duplicate"
    }
  }, { config, store, telegram });

  assert.equal(telegram.calls.some((call) => call.method === "copyMessage"), false);
});

test("Telegram update claims suppress duplicates and recover stale leases", async () => {
  const db = createFakeD1();
  const store = createStore(db);
  await store.ensureSchema();

  const first = await store.claimTelegramUpdate(9001, 60_000);
  const duplicate = await store.claimTelegramUpdate(9001, 60_000);
  assert.equal(first.claimed, true);
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.completed, false);

  const row = db.state.processed_telegram_updates.get("default:9001");
  row.lease_expires_at = "2000-01-01T00:00:00.000Z";
  const takeover = await store.claimTelegramUpdate(9001, 60_000);
  assert.equal(takeover.claimed, true);
  assert.notEqual(takeover.leaseToken, first.leaseToken);

  assert.equal(await store.completeTelegramUpdate(9001, takeover.leaseToken), true);
  const completed = await store.claimTelegramUpdate(9001, 60_000);
  assert.equal(completed.claimed, false);
  assert.equal(completed.completed, true);
});

test("completed Telegram update rows are pruned after the bounded retention period", async () => {
  const db = createFakeD1();
  const store = createStore(db);
  await store.ensureSchema();
  const claim = await store.claimTelegramUpdate(9003, 60_000);
  assert.equal(await store.completeTelegramUpdate(9003, claim.leaseToken), true);
  db.state.processed_telegram_updates.get("default:9003").completed_at = "2000-01-01T00:00:00.000Z";

  await store.claimTelegramUpdate(9004, 60_000);
  assert.equal(db.state.processed_telegram_updates.has("default:9003"), false);
  assert.equal(db.state.processed_telegram_updates.has("default:9004"), true);
});

test("Telegram update claims are isolated by Bot namespace", async () => {
  const store = await makeStore();
  const first = await store.claimTelegramUpdate(9005, 60_000, "bot-a");
  const second = await store.claimTelegramUpdate(9005, 60_000, "bot-b");
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, true);
  assert.equal(await store.completeTelegramUpdate(9005, first.leaseToken, "bot-a"), true);
  assert.equal((await store.claimTelegramUpdate(9005, 60_000, "bot-a")).completed, true);
  assert.equal((await store.claimTelegramUpdate(9005, 60_000, "bot-b")).completed, false);
});

test("the process wrapper derives Bot namespace so a new Bot can process the same update ID", async () => {
  const store = await makeStore();
  await store.upsertTelegramUser({ id: 7, first_name: "Alice" });
  await store.approveUser(7);
  await store.setTopicThreadId(7, 888);
  const telegram = fakeTelegram();
  const update = {
    update_id: 9006,
    message: {
      message_id: 33,
      chat: { id: 7, type: "private" },
      from: { id: 7, first_name: "Alice" },
      text: "same update id, new bot"
    }
  };

  await processTelegramUpdate(update, {
    config: { ...config, TG_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyzABCDE" },
    store,
    telegram
  });
  await processTelegramUpdate(update, {
    config: { ...config, TG_BOT_TOKEN: "987654:zyxwvutsrqponmlkjihgfedcbaABCDE" },
    store,
    telegram
  });

  assert.equal(telegram.calls.filter((call) => call.method === "copyMessage").length, 2);
});

test("Telegram update processing is idempotent while failed updates are released for retry", async () => {
  const store = await makeStore();
  await store.upsertTelegramUser({ id: 7, first_name: "Alice" });
  await store.approveUser(7);
  await store.setTopicThreadId(7, 888);

  let copyAttempts = 0;
  const telegram = fakeTelegram();
  const originalCopy = telegram.copyMessage;
  telegram.copyMessage = async (...args) => {
    copyAttempts += 1;
    if (copyAttempts === 1) throw new Error("temporary Telegram failure");
    return originalCopy(...args);
  };
  const update = {
    update_id: 9002,
    message: {
      message_id: 32,
      chat: { id: 7, type: "private" },
      from: { id: 7, first_name: "Alice" },
      text: "retry me"
    }
  };

  await assert.rejects(() => processTelegramUpdate(update, { config, store, telegram }));
  const retry = await processTelegramUpdate(update, { config, store, telegram });
  const duplicate = await processTelegramUpdate(update, { config, store, telegram });

  assert.equal(retry, undefined);
  assert.equal(duplicate.skipped, true);
  assert.equal(copyAttempts, 2);
});
