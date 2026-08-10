# SentinelRelay 哨兵中继

SentinelRelay 是一个基于 Cloudflare Workers 的 Telegram 安全双向私信中继。仓库只保留部署向导、Worker 模板和运行所需的静态资源。

## 目录

- `deploy/index.html`：完全静态的浏览器配置与代码生成页。
- `deploy/worker.js`：部署向导同源读取的单文件 Worker 模板。模板中的配置占位符由部署页替换，D1 表结构会在第一次请求时自动建立。
- `deploy/generator.js`、`deploy/gate.js`：部署页使用的纯配置替换和本地 Star 提醒逻辑。
- `deploy/README.md`：部署向导的详细准备事项和安全说明。

## 连接 GitHub 部署到 Cloudflare Pages

Pages 只托管静态部署向导，不部署 Telegram Worker。Cloudflare 控制台中选择 **Workers & Pages → Create → Pages → Connect to Git**，授权并选择 [`llovely45/SentinelRelay`](https://github.com/llovely45/SentinelRelay)，然后使用以下设置：

- 生产分支：`main`
- Framework preset：`None`
- Root directory：`.`
- Build command：`mkdir -p .pages-dist && cp deploy/index.html deploy/generator.js deploy/gate.js deploy/worker.js .pages-dist/`
- Build output directory：`.pages-dist`
- Deploy command（如果控制台显示此字段）：`npx wrangler pages deploy .pages-dist --project-name sentinelrelay --branch main`

保存并部署后，Pages 根地址直接打开部署向导。部署向导会从同源 `./worker.js` 读取模板，配置验证和最终代码生成都在浏览器内完成。若 Pages 构建环境执行 Deploy command，请先在该项目配置具有 Pages 写权限的 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`；也可以只用上面的 Build command，由 Pages 自己发布 `.pages-dist`。

Pages 部署完成后仍需按照下面的 Worker 教程，把生成代码单独部署到 Cloudflare Workers，并绑定 D1 `DB`；Pages 不承载 Telegram Webhook，也不需要 Pages Functions。

## 浏览器生成与部署（复制粘贴流程）

1. 先在 Cloudflare Workers 创建一个默认 Worker 项目，创建 D1 数据库并绑定为 **`DB`**，部署默认代码后复制它的 HTTPS 地址。部署向导会先检查这个地址是否可达；生成代码后再把默认 Worker 代码替换为生成代码并重新部署。
2. 在仓库根目录启动一个静态 HTTP 服务（不要直接双击 HTML）：

   ```bash
   python3 -m http.server 8000
   ```

   打开 <http://127.0.0.1:8000/deploy/index.html>，填写表单并完成“API 验证”，再点击“生成代码”。
3. 将页面显示的完整只读代码复制到 Cloudflare Workers 编辑器，替换默认代码并重新部署。生成代码包含配置值，请勿提交到 Git。
4. 除 **`DB`** D1 绑定外，不需要额外的 Worker 环境变量；模板里的配置已嵌入生成代码。若自行维护环境变量，环境值会优先于嵌入值。
5. 部署后，用浏览器打开一次 `https://你的-worker-域名/health`。该请求会初始化 D1 表和索引，并按 Worker 地址及 Webhook Secret 注册 Telegram Webhook；以后也可用它检查健康状态。
6. Telegram 会向 `https://你的-worker-域名/telegram/webhook` 发送更新。Worker 要求请求包含与生成配置一致的 `X-Telegram-Bot-Api-Secret-Token`（即 `TG_WEBHOOK_SECRET`）；修改域名或 Secret 后再次打开 `/health` 以更新 Webhook。

这是当前 Worker 模板的最终 D1 表结构。若你曾部署过早期测试版（其中
`processed_telegram_updates` 只有 `update_id` 主键），请在切换到本模板前备份并删除该旧表，或创建一个新的 D1 数据库，再打开 `/health` 重新初始化；`CREATE TABLE IF NOT EXISTS` 不会自动把旧表升级为新的 `(bot_namespace, update_id)` 复合主键。

## 生成配置字段

部署页会在浏览器内校验并替换以下全部字段。字段值会持久化到当前浏览器的 `localStorage`，不会上传到本仓库服务器、URL 或下载文件；Telegram 的 `getMe`/`getChat` 与 Worker 可达性校验直接从浏览器发起。

| 字段 | 用途与要求 |
| --- | --- |
| `TG_BOT_TOKEN` | Telegram Bot Token；部署页会调用 `getMe` 验证。 |
| `TG_GROUP_ID` | 开启 Topics/Forum 的 Telegram 超级群 ID（通常为负数）；部署页会验证群类型和权限。 |
| `APP_BASE_URL` | Worker 的公开 HTTPS 基础地址，不带末尾 `/`；向导首先从浏览器请求根路径检查可达性，再用于验证链接和 Webhook 地址。 |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile 的公开 Site Key，显示在验证页。 |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile 服务端 Secret，用于验证提交结果。 |
| `TG_WEBHOOK_SECRET` | Telegram Webhook Header 密钥，至少 16 个字符；Worker 会拒绝缺失或不匹配的 Header。 |
| `VERIFICATION_TTL_MINUTES` | 验证会话有效期，必须是 5–1440 的整数。 |
| `STUN_SERVER_URL` | 浏览器 WebRTC ICE 探测地址，必须以 `stun:` 开头。 |

生成器只替换 `deploy/worker.js` 中的 quoted markers，并使用 JSON 转义；没有填写完整配置、Worker 地址不可达或 Telegram API 验证失败时不会生成代码。生成结果仍只保留在当前页面内存中。请在 Telegram/Cloudflare 控制台轮换已经出现在日志、截图或公共剪贴板中的 Token/Secret。

部署页的每个输入框都提供填写教程和独立验证按钮；Worker 地址会先检查可达性，Bot Token/群组 ID 会调用 Telegram API，其余字段执行格式或范围检查。所有验证按钮、API 验证和生成代码按钮共用同一套本地一次性流程；首次操作会打开仓库，第二次确认后后续操作不再打断。

## 验证、指纹与隐私

验证页会明确显示隐私提示：页面可能采集 Canvas、WebGL、Audio、操作系统、CPU、屏幕、字体和 WebRTC 公网地址信号，仅用于反滥用和指纹标签匹配；浏览器可以阻止任意信号，用户可以拒绝继续验证。指纹摘要和相关状态保存在 D1，用于中继的安全管理。

部署页的仓库跳转流程只是本地浏览器状态，不查询 GitHub，也不是权限控制或 GitHub 官方、权威的 Star 验证。连续点击页面标题五次会静默清理这组状态；表单配置不会因此删除。

## 安全提示

- 不要把 Telegram Bot Token、Turnstile Secret、Webhook Secret、代理账号密码或生成后的 Worker 代码提交到仓库。
- 生产部署前请限制可访问的 Telegram 用户，启用日志脱敏，并检查 Cloudflare Worker 的密钥配置。
- `.gitignore` 已忽略 `.env`、本地 D1/Wrangler 状态和 `worker.generated.js`；不要把生成后的 Worker 代码提交到 Git。

## 许可证

许可证将在项目功能稳定后补充。
