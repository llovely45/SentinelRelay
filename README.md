# SentinelRelay 哨兵中继

SentinelRelay 是一个基于 Cloudflare Workers 的 Telegram 安全双向私信中继 Worker。
它将 Telegram 用户、验证流程和管理群组连接起来，让每个用户在独立的 Forum 话题中进行隔离通信与双向转发。

## Worker 能力

- 接收 Telegram Bot Webhook，并校验请求密钥。
- 为通过验证的用户创建独立 Forum 话题。
- 在用户私信与管理群组话题之间双向转发消息。
- 使用 Cloudflare Turnstile 处理浏览器验证和验证会话。
- 处理验证会话过期、重复提交、黑名单和并发请求。
- 记录设备指纹并支持管理群组中的指纹标签与屏蔽操作。
- 通过 D1 保存用户、话题、验证会话、运行设置和 Telegram 更新处理状态。

## 请求入口

| 路径 | 作用 |
| --- | --- |
| `GET /` | Worker 运行状态响应。 |
| `GET /health` | 初始化 D1 表结构并检查 Webhook 状态。 |
| `POST /telegram/webhook` | 接收 Telegram 更新并执行消息路由。 |
| `GET /verify/:session` | 展示普通浏览器验证页。 |
| `GET /miniapp` | 展示 Telegram Mini App 验证页。 |
| `POST /api/verify/:session` | 提交普通验证结果。 |
| `POST /api/verify` | 提交 Mini App 验证结果。 |

## 运行流程

```text
Telegram 用户
      │
      ▼
Worker 验证与会话管理 ─── Cloudflare D1
      │
      ▼
Telegram 管理群组（每个用户一个 Forum 话题）
```

Worker 负责 Telegram API 调用、验证、消息转发和管理操作；D1 负责保存跨请求状态；Telegram Forum 话题负责承载管理侧的独立会话。

## 持久化数据

- `users`：Telegram 用户、验证状态、话题和最近指纹。
- `verification_sessions`：一次性验证会话及过期状态。
- `fingerprint_labels`：设备指纹标签和屏蔽规则。
- `pending_admin_actions`：管理群组中的待确认操作。
- `runtime_settings`：Webhook 等运行时设置。
- `processed_telegram_updates`：Telegram 更新去重与处理租约。

## 技术栈

- Cloudflare Workers
- Cloudflare D1
- Telegram Bot API
- Cloudflare Turnstile
- 原生 JavaScript，无运行时依赖
