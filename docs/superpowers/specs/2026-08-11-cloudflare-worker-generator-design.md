# SentinelRelay Cloudflare Worker 生成器设计

## 目标

把 `/Users/lin8177/Documents/tg-bot` 中基于 Telegram Webhook、Turnstile、浏览器指纹和 SQLite 的双向中继功能迁移为一个原生 Cloudflare Worker，并提供一个完全静态的部署向导。用户在浏览器中填写配置、校验 Telegram 配置、复制生成后的 `worker.js`，粘贴到 Cloudflare Workers 后只需绑定一个名为 `DB` 的 D1 数据库即可运行。

## 范围与非目标

### 范围

- Telegram 私聊用户验证、Forum Topic 创建和私聊/群话题双向转发。
- Cloudflare Turnstile 服务端校验。
- 浏览器设备特征、WebRTC 公网地址采集、指纹哈希和相似度匹配。
- 管理员在群话题中通过按钮执行通过验证、取消验证、拉黑、解除拉黑、查看用户名、添加/删除/屏蔽指纹标签。
- D1 自动初始化表结构，不要求用户手动执行 SQL。
- 静态配置页在浏览器内完成字段校验、Telegram API 校验、占位符替换和完整代码复制。
- 首次执行 API 校验或生成代码前的 Star 提示门禁。

### 非目标

- 不实现 GitHub OAuth，也不向 GitHub 查询真实 Star 状态。Star 门禁只记录浏览器是否点击过跳转按钮，是一个可绕过的提示流程。
- 不把 Token、生成后的 Worker 代码或其他配置上传到部署向导服务器。
- 不继续依赖 Telegraf、Express、`better-sqlite3`、Node DNS 或 Node 文件系统。
- 不提供多租户配置管理、在线保存配置或远程部署 Worker。

## 目录结构

```text
SentinelRelay/
├── worker/
│   └── worker.js          # 可直接部署的单文件 Worker 模板，含配置占位符
├── deploy/
│   ├── index.html         # 静态配置、门禁、Telegram 校验和代码复制页面
│   └── README.md          # Cloudflare、D1、Turnstile、Telegram 配置教程
├── docs/
│   └── superpowers/
│       ├── specs/
│       │   └── 2026-08-11-cloudflare-worker-generator-design.md
│       └── plans/
├── README.md              # 项目入口和运行时说明
├── .gitignore
└── snippets_vless_demo.js # 现有 VLESS 示例，和新 Worker 运行时互不依赖
```

现有仓库中的 VLESS 示例可继续保留；Go 模块文件不是 Worker 运行时依赖，若已被清理则不需要恢复。

生成后的含密钥 `worker.js` 只存在于部署页内存和用户剪贴板中，不写入 `localStorage`、下载文件或 Git 仓库。

## 配置与生成

模板只在配置对象中使用以下占位符，每个值由生成器通过 `JSON.stringify` 转义后替换，避免引号、换行或反斜杠破坏 JavaScript：

| 字段 | 用途 | 校验 |
| --- | --- | --- |
| `TG_BOT_TOKEN` | Telegram Bot API Token | 浏览器调用 `getMe` 成功 |
| `TG_GROUP_ID` | 开启 Topics 的目标超级群 ID | 浏览器调用 `getChat` 成功且为 `supergroup` |
| `APP_BASE_URL` | Worker 对外 HTTPS 地址 | 必须是 `https://` 且不带末尾 `/` |
| `TURNSTILE_SITE_KEY` | 验证页公开 Site Key | 非空 |
| `TURNSTILE_SECRET_KEY` | Worker 服务端校验 Secret | 非空 |
| `TG_WEBHOOK_SECRET` | Telegram Webhook Header 密钥 | 至少 16 个字符 |
| `VERIFICATION_TTL_MINUTES` | 验证会话有效期 | 5–1440 的整数 |
| `STUN_SERVER_URL` | WebRTC ICE 探测地址 | `stun:` 开头；默认 `stun:stun.miwifi.com:3478` |

配置页的 Telegram 校验请求直接发送到 `https://api.telegram.org`，使用 POST JSON，不经过部署向导站点。校验只在点击“API 验证”并完成门禁后执行；验证失败时显示 Telegram 返回的安全错误摘要，不显示或记录完整 Token。

生成后的页面展示只读代码框和“复制完整代码”按钮。优先使用 `navigator.clipboard.writeText`，不可用时退化为选中只读文本框并提示用户使用系统复制。复制成功只显示短暂状态，不持久化代码。

## Star 提示门禁

门禁只存在于 `deploy/index.html`，不进入 Worker 运行时。

1. 用户首次点击“API 验证”或“生成代码”时，阻止原动作并打开模态框。
2. 模态框显示转圈和“需要先给 SentinelRelay 仓库点击 Star，才能进行 API 验证”的提示。
3. 约 1 秒后显示“立即跳转仓库”按钮。
4. 点击按钮前先写入 `localStorage` 键 `sentinelrelay_star_redirected_v1`，值为时间戳和仓库 URL，再用新标签打开 `https://github.com/llovely45/SentinelRelay`。
5. 用户第二次打开页面并触发任一受保护动作时，仍显示转圈；检测到该键后约 1 秒显示“我已验证”。
6. 点击“我已验证”只解除本次页面动作的门禁，然后继续之前的 API 校验或代码生成。
7. 页面明确说明该流程不是 GitHub 官方 Star 状态验证，清理浏览器数据即可重新触发。

门禁状态只记录跳转标记，不记录 Token、配置内容或生成代码。未完成门禁时，Telegram API 校验和代码生成函数都不能被调用。

## Worker 运行时

`worker/worker.js` 使用模块 Worker 入口 `export default { fetch }`，不依赖 npm 包。运行时分为以下内部区域：

- `CONFIG`：生成器填充的常量配置。
- `telegramCall(method, payload)`：统一封装 Bot API POST 请求、响应解析和错误归一化。
- `ensureSchema(db)`：通过 D1 `exec` 或等价批处理创建表和索引。
- `store`：集中封装 D1 查询、插入、状态更新、分页和事务式批处理。
- `fingerprint`：规范化指纹对象、稳定序列化、哈希、相似度和标签匹配。
- `pages`：验证页、Mini App 页、结果页和健康响应的 HTML/JSON 渲染。
- `router`：按 URL、方法和 Telegram update 类型分发请求。

### 路由

| 路由 | 行为 |
| --- | --- |
| `GET /` | 返回简短部署/运行状态说明 |
| `GET /health` | 建表、尝试注册 Webhook，返回 JSON 健康状态 |
| `POST /telegram/webhook` | 校验 Telegram Secret Header 并处理 update |
| `GET /verify/:sessionId` | 普通浏览器验证页 |
| `GET /miniapp` | Telegram Mini App 验证页 |
| `POST /api/verify/:sessionId` | 普通验证页提交 Turnstile、指纹和 WebRTC 数据 |
| `POST /api/verify` | Mini App 提交验证，会话 ID 来自表单/启动参数 |

首次访问 `/health` 时，Worker 创建 D1 表并计算当前 Webhook 配置摘要；只有摘要变化或尚未注册时才调用 `setWebhook`。这样用户部署后访问一次 `/health` 即可完成初始化，无需额外运行命令。

### Telegram update 流程

- 私聊 `/start` 或普通消息：写入/更新用户；黑名单用户拒绝；未验证用户生成或复用验证会话并回复验证入口；已验证用户通过 `copyMessage` 复制到对应 Forum Topic。
- 首次验证成功：创建 Forum Topic，写入用户信息，记录指纹，标记用户和会话为已验证，并把验证信息发到话题。
- 群话题普通消息：依据 `message_thread_id` 找到用户，跳过机器人和管理命令后通过 `copyMessage` 回传私聊。
- 群话题 `/admin` 和 callback：实时调用 `getChatMember` 检查管理员权限；按钮动作更新 D1 并刷新消息。
- 指纹标记输入：使用 D1 的待处理管理员动作记录，不依赖 Worker 内存，从而兼容无状态实例和重试。

## D1 数据模型

首次建表直接使用最终字段，避免 SQLite 迁移逻辑：

- `users`：Telegram 用户资料、验证/黑名单状态、话题线程 ID、验证提示消息、最新指纹。
- `verification_sessions`：随机会话 ID、用户、状态、失败原因、创建/过期/消费时间。
- `fingerprint_labels`：标签名、备注、指纹 ID/JSON、来源用户、创建者、屏蔽状态和时间。
- `pending_admin_actions`：管理员、话题、用户、动作类型和过期时间，用于等待“标签|备注”输入。
- `runtime_settings`：Webhook 配置摘要与初始化时间。

所有查询通过绑定参数执行；分页使用固定正整数页码和页大小；需要同时更新用户与验证会话的操作使用 D1 `batch` 保持一致。

## 验证页面与隐私

验证页保留原项目的 Turnstile、Canvas、WebGL、Audio、系统、CPU、屏幕、字体和 WebRTC 采集逻辑，并将 JSON 作为表单字段提交。页面应增加可见说明：这些信号用于反滥用和指纹标签匹配，用户可拒绝继续验证。

Worker 取得客户端 IP 时优先使用 `CF-Connecting-IP`，并结合 `request.cf` 的 ASN/组织信息；对 WebRTC 地址只保留公网地址。对于缺少 Cloudflare 元数据的地址，使用 Worker `fetch` 请求公共 IP 元数据服务；请求失败时保存 IP/设备数据，不让外部查询失败阻断验证。

Turnstile Secret 只在 Worker 服务端请求 `siteverify` 使用。所有错误响应不包含 Token、Secret 或完整 Telegram API 错误 URL；页面输出的用户资料和 IP 均经过 HTML 转义。

## 测试与验收

实现前先为以下行为写失败测试，再实现最小代码：

- 生成器能安全替换所有占位符，输出不再包含占位符且 Token 中的引号/反斜杠保持原样。
- 首次触发受保护动作会阻止 Telegram API 和代码生成调用，并在一秒后显示跳转按钮。
- 跳转前写入门禁标记；第二次触发显示“我已验证”，确认后只放行当前动作。
- 复制按钮使用 Clipboard API，失败时有可操作的回退提示。
- 配置校验能识别无效 Token、非 HTTPS 地址、非法群 ID、过短 Webhook Secret 和超范围 TTL。
- D1 建表 SQL 可重复执行；会话过期、一次性消费、黑名单和管理员权限边界正确。
- Worker 路由能拒绝错误 Webhook Secret，并正确处理健康检查和验证页。
- Telegram API 错误、Turnstile 失败、D1 失败时返回用户可理解的状态且不泄漏密钥。

验收标准是：在静态服务器中打开 `deploy/index.html`，完成门禁后可校验一组测试配置并在页面复制完整 Worker；将代码粘贴到 Cloudflare Worker 并绑定 `DB` 后访问 `/health`，D1 自动建表、Webhook 注册成功，Telegram 私聊验证和双向转发主流程可运行。

## 主要风险与处理

- **Star 门禁可绕过**：文档和页面明确说明它只是提示；若后续需要强校验，新增 GitHub OAuth 作为独立设计，不把 OAuth Secret 放入静态页面。
- **生成代码含密钥**：仅在浏览器内生成和复制，不提交、不下载、不写日志，并提供“清空结果”按钮。
- **D1 首次请求延迟**：建表与 Webhook 注册在 `/health` 完成，业务 Webhook 处理只在初始化成功后继续。
- **Telegram/外部 IP 服务波动**：统一超时和错误归一化；IP 元数据失败不影响验证，Telegram API 失败返回可重试错误。
- **Cloudflare Workers 无持久内存**：所有跨请求状态写入 D1，管理员待输入动作不使用 `Map`。
