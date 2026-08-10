# SentinelRelay 哨兵中继

SentinelRelay 是一个基于 Cloudflare Workers 的 Telegram 安全双向私信中继。仓库中的 VLESS 示例仍可单独参考；新的 Telegram Worker 运行时和浏览器部署向导不依赖 Go 或 Node 运行时。

## 目录

- `worker/worker.js`：可直接粘贴到 Cloudflare Workers 的单文件模块 Worker 模板。模板中的配置占位符由部署页替换，D1 表结构会在第一次请求时自动建立。
- `deploy/index.html`：完全静态的浏览器配置与代码生成页。
- `deploy/generator.js`、`deploy/gate.js`：部署页使用的纯配置替换和本地 Star 提醒逻辑。
- `deploy/README.md`：部署向导的详细准备事项和安全说明。
- `snippets_vless_demo.js`：原有的 VLESS WebSocket/TCP/UDP 中继示例。

## 浏览器生成与部署（复制粘贴流程）

1. 在仓库根目录启动一个静态 HTTP 服务（不要直接双击 HTML）：

   ```bash
   python3 -m http.server 8000
   ```

   打开 <http://127.0.0.1:8000/deploy/index.html>，填写表单并完成“API 验证”，再点击“生成代码”。
2. 将页面显示的完整只读代码复制到 Cloudflare Workers 编辑器，或保存为本地 `worker.generated.js` 后粘贴部署。生成代码包含配置值，请勿提交到 Git。
3. 创建一个 Cloudflare D1 数据库，并将唯一绑定命名为 **`DB`**。除这个 D1 绑定外，不需要额外的 Worker 环境变量；模板里的配置已嵌入生成代码。若自行维护环境变量，环境值会优先于嵌入值。
4. 部署后，用浏览器打开一次 `https://你的-worker-域名/health`。该请求会初始化 D1 表和索引，并按 Worker 地址及 Webhook Secret 注册 Telegram Webhook；以后也可用它检查健康状态。
5. Telegram 会向 `https://你的-worker-域名/telegram/webhook` 发送更新。Worker 要求请求包含与生成配置一致的 `X-Telegram-Bot-Api-Secret-Token`（即 `TG_WEBHOOK_SECRET`）；修改域名或 Secret 后再次打开 `/health` 以更新 Webhook。

这是当前 Worker 模板的最终 D1 表结构。若你曾部署过早期测试版（其中
`processed_telegram_updates` 只有 `update_id` 主键），请在切换到本模板前备份并删除该旧表，或创建一个新的 D1 数据库，再打开 `/health` 重新初始化；`CREATE TABLE IF NOT EXISTS` 不会自动把旧表升级为新的 `(bot_namespace, update_id)` 复合主键。

## 生成配置字段

部署页会在浏览器内校验并替换以下全部字段。值不会上传到本仓库服务器、URL、`localStorage` 或下载文件；Telegram 的 `getMe`/`getChat` 校验直接从浏览器请求 Telegram API。

| 字段 | 用途与要求 |
| --- | --- |
| `TG_BOT_TOKEN` | Telegram Bot Token；部署页会调用 `getMe` 验证。 |
| `TG_GROUP_ID` | 开启 Topics/Forum 的 Telegram 超级群 ID（通常为负数）；部署页会验证群类型和权限。 |
| `APP_BASE_URL` | Worker 的公开 HTTPS 基础地址，不带末尾 `/`；用于验证链接和 Webhook 地址。 |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile 的公开 Site Key，显示在验证页。 |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile 服务端 Secret，用于验证提交结果。 |
| `TG_WEBHOOK_SECRET` | Telegram Webhook Header 密钥，至少 16 个字符；Worker 会拒绝缺失或不匹配的 Header。 |
| `VERIFICATION_TTL_MINUTES` | 验证会话有效期，必须是 5–1440 的整数。 |
| `STUN_SERVER_URL` | 浏览器 WebRTC ICE 探测地址，必须以 `stun:` 开头。 |

生成器只替换 `worker/worker.js` 中的 quoted markers，并使用 JSON 转义；没有填写完整配置时不会生成代码。请在 Telegram/Cloudflare 控制台轮换已经出现在日志、截图或公共剪贴板中的 Token/Secret。

## 验证、指纹与隐私

验证页会明确显示隐私提示：页面可能采集 Canvas、WebGL、Audio、操作系统、CPU、屏幕、字体和 WebRTC 公网地址信号，仅用于反滥用和指纹标签匹配；浏览器可以阻止任意信号，所有字段都可以为空，用户可以拒绝继续验证。指纹摘要和相关状态保存在 D1，用于中继的安全管理。

部署页的 Star 提示只是本地浏览器提醒：它只记录是否点击过仓库跳转，不查询 GitHub，也不是权限控制或 GitHub 官方、权威的 Star 验证。清理该浏览器的站点数据即可再次看到提示；该提示不会进入 Worker 运行时，也不影响 Worker 的真实鉴权。

## 现有 VLESS 示例

`snippets_vless_demo.js` 保留了原有的 VLESS WebSocket/TCP/UDP、SOCKS5/HTTP 代理和 DNS over HTTPS 示例逻辑。它与上面的 Telegram Worker 部署流程互不依赖。

## 安全提示

- 不要把 Telegram Bot Token、Turnstile Secret、Webhook Secret、代理账号密码或生成后的 Worker 代码提交到仓库。
- 生产部署前请限制可访问的 Telegram 用户，启用日志脱敏，并检查 Cloudflare Worker 的密钥配置。
- `.gitignore` 已忽略 `.env`、本地 D1/Wrangler 状态、测试输出和 `worker.generated.js`；不要因此忽略源模板或测试文件。

## 许可证

许可证将在项目功能稳定后补充。
