# SentinelRelay 哨兵中继

SentinelRelay 是一个基于 Cloudflare Workers 的 Telegram 安全双向私信中继项目。
它把 Telegram 用户、验证流程和管理群组连接起来，让私信能够在独立话题中进行隔离、审查与双向转发。

## 核心能力

- 通过 Telegram Bot 接收和处理用户私信。
- 为每个用户建立独立的 Forum 话题，隔离不同会话。
- 支持用户验证、会话过期、黑名单和重复请求防护。
- 使用 Cloudflare D1 持久化用户、验证会话、话题和运行状态。
- 通过 Telegram Webhook 在用户与管理群组之间双向转发消息。
- 支持设备指纹记录与标签化风控管理。
- 提供浏览器部署向导，生成可直接部署的单文件 Worker。

## 运行架构

```text
Telegram 用户
      │
      ▼
Cloudflare Worker ─── Cloudflare D1
      │
      ▼
Telegram 管理群组（Forum 话题）
```

Worker 负责 Webhook、验证、消息路由和权限处理；D1 负责保存运行所需的持久化状态；管理群组中的每个 Forum 话题对应一个用户会话。

## 项目目录

- `deploy/index.html`：静态部署向导页面。
- `deploy/worker.js`：Cloudflare Worker 单文件模板和运行逻辑。
- `deploy/generator.js`：在浏览器中替换 Worker 配置占位符并生成代码。
- `deploy/gate.js`：部署向导的本地验证流程。
- `deploy/README.md`：Cloudflare Pages、Workers 和 D1 的部署教程。

## 技术栈

- Cloudflare Workers
- Cloudflare D1
- Telegram Bot API
- Cloudflare Turnstile
- 原生 JavaScript，无运行时依赖
