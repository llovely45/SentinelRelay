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
