import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramClient } from "../worker/worker.js";

test("Telegram client sends POST JSON and returns Telegram result", async () => {
  const calls = [];
  const telegram = createTelegramClient({
    token: "123:token",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, result: { id: 7 } }), { status: 200 });
    }
  });

  assert.deepEqual(await telegram.getMe(), { id: 7 });
  assert.equal(calls[0].url, "https://api.telegram.org/bot123:token/getMe");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(JSON.parse(calls[0].init.body).chat_id, undefined);
});

test("Telegram client maps convenience methods to Bot API payloads", async () => {
  const calls = [];
  const telegram = createTelegramClient({
    token: "123:token",
    fetchImpl: async (url, init) => {
      calls.push({ method: url.split("/").pop(), payload: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
  });

  await telegram.getChat("-100");
  await telegram.getChatMember("-100", 42);
  await telegram.setWebhook("https://example.test/hook", "secret");
  await telegram.sendMessage("-100", "hello", { message_thread_id: 8 });
  await telegram.copyMessage("-100", 42, 9, { message_thread_id: 8 });
  await telegram.createForumTopic("-100", "Alice");
  await telegram.answerCallbackQuery("cb", "done", { show_alert: true });
  await telegram.editMessageText("-100", 11, "edited", { reply_markup: { inline_keyboard: [] } });
  await telegram.deleteMessage("-100", 11);

  assert.deepEqual(calls, [
    { method: "getChat", payload: { chat_id: "-100" } },
    { method: "getChatMember", payload: { chat_id: "-100", user_id: 42 } },
    { method: "setWebhook", payload: { url: "https://example.test/hook", secret_token: "secret" } },
    { method: "sendMessage", payload: { chat_id: "-100", text: "hello", message_thread_id: 8 } },
    { method: "copyMessage", payload: { chat_id: "-100", from_chat_id: 42, message_id: 9, message_thread_id: 8 } },
    { method: "createForumTopic", payload: { chat_id: "-100", name: "Alice" } },
    { method: "answerCallbackQuery", payload: { callback_query_id: "cb", text: "done", show_alert: true } },
    { method: "editMessageText", payload: { chat_id: "-100", message_id: 11, text: "edited", reply_markup: { inline_keyboard: [] } } },
    { method: "deleteMessage", payload: { chat_id: "-100", message_id: 11 } }
  ]);
});

test("Telegram client normalizes HTTP and Telegram errors without leaking token", async () => {
  const token = "123:super-secret-token";
  const responses = [
    { ok: true, status: 500, json: async () => ({ ok: true, result: { accepted: true } }) },
    new Response("gateway failed", { status: 502 }),
    new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: invalid" }), { status: 200 })
  ];
  const telegram = createTelegramClient({
    token,
    fetchImpl: async () => responses.shift()
  });

  await assert.rejects(() => telegram.getMe(), (error) => {
    assert.match(error.message, /Telegram API request failed/);
    assert.equal(error.status, 500);
    return true;
  });
  await assert.rejects(() => telegram.getMe(), (error) => {
    assert.match(error.message, /Telegram API request failed/);
    assert.doesNotMatch(error.message, new RegExp(token));
    assert.equal(error.status, 502);
    return true;
  });
  await assert.rejects(() => telegram.getMe(), (error) => {
    assert.match(error.message, /Bad Request: invalid/);
    assert.equal(error.code, 400);
    assert.doesNotMatch(JSON.stringify(error.response), new RegExp(token));
    assert.doesNotMatch(error.message, new RegExp(token));
    return true;
  });
});
