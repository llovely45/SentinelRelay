# SentinelRelay 部署向导

`deploy/index.html` 是一个完全静态的配置页。它在浏览器中校验 Telegram 配置、读取同目录的 `worker.js` 模板并替换配置占位符；不会把 Token、Secret、生成代码写入服务器、URL、下载文件或 `localStorage`。

## 连接 GitHub 部署到 Cloudflare Pages

本项目的 Pages 部署只托管这个静态向导，不部署 Telegram Worker。打开 Cloudflare 控制台，选择 **Workers & Pages → Create → Pages → Connect to Git**，授权 GitHub 后选择 [`llovely45/SentinelRelay`](https://github.com/llovely45/SentinelRelay)，配置：

- Production branch：`main`
- Framework preset：`None`
- Build command：留空
- Build output directory：`deploy`

部署完成后，访问 Pages 根地址即可直接打开部署向导。页面会从同源 `./worker.js` 读取模板。Pages 只负责展示向导和提供静态模板，不接收任何密钥，也不处理 Telegram Webhook。

生成代码后，仍需把代码单独粘贴到 Cloudflare Workers，并绑定名为 `DB` 的 D1 数据库；这一步不通过 Pages Functions 完成。

## 1. 用 HTTP 打开页面

不要直接双击 `index.html`。ES 模块和同源模板读取需要 HTTP 服务。请在仓库根目录运行：

```bash
python3 -m http.server 8000
```

然后打开 <http://127.0.0.1:8000/deploy/index.html>。首次点击“API 验证”或“生成代码”会出现 Star 提醒；它只记录本地跳转提示，不会查询 GitHub 的真实 Star 状态。

## 2. 准备配置

- 创建 Telegram Bot，并把 Bot Token 填入页面。
- 创建一个开启 **Topics/Forum** 的超级群，把 Bot 加入群组，并授予读取消息、发送消息、管理话题和删除消息等所需权限。填入群组 ID（通常是负数），页面会用 `getMe` 和 `getChat` 直接验证。
- 在 Cloudflare Turnstile 创建站点，添加 Worker 的 HTTPS 域名（本地调试可按 Turnstile 控制台允许的测试域名配置），填入 Site Key 和 Secret Key。
- 填写 Worker 的 HTTPS 基础地址（不要带末尾 `/`）、至少 16 个字符的 Telegram Webhook Secret、验证 TTL 和 `stun:` 地址。

页面不会保存表单。刷新或关闭标签页会丢失配置；生成的代码也只存在于当前页面内存和用户主动复制到的系统剪贴板中。

每个配置框下方都有“填写教程”和独立的“验证”按钮：Bot Token/群组 ID 会直接调用 Telegram API，其余字段会检查格式和范围。API 验证、生成代码以及所有字段验证按钮共用同一套 Star 提醒流程；首次操作会先显示跳转提示，返回后点击“我已验证”才会继续执行。

## 3. 部署生成的 Worker

1. 完成“API 验证”，再点击“生成代码”。把只读代码框中的完整内容复制到 Cloudflare Workers 编辑器。
2. 创建一个 D1 数据库，并把唯一的绑定命名为 **`DB`**。Worker 会在第一次请求时自动创建表和索引，不需要手动执行 SQL。
3. 部署 Worker 后，打开一次 `https://你的域名/health`。这会初始化 D1，并按当前地址和密钥注册 Telegram Webhook；以后可用该地址检查健康状态。
4. 将 Telegram Bot 的 Webhook 请求指向 Worker 自动注册的 `/telegram/webhook`。如果修改 Worker 地址或 Webhook Secret，请再次打开 `/health`。

升级提示：本模板使用 `processed_telegram_updates(bot_namespace, update_id)` 复合主键。若 D1 中已有早期测试版创建的同名旧表（只有 `update_id` 主键），请先备份并删除该表，或改用新的 D1 数据库，再访问 `/health`；D1 的 `CREATE TABLE IF NOT EXISTS` 不会自动迁移旧表结构。

## 4. 安全提醒

- 这是浏览器端生成器，不是远程部署服务；凭据不会发送到本仓库服务器。Telegram `getMe`/`getChat` 请求从浏览器直接发送到 `api.telegram.org`。
- 生成代码已经包含密钥。不要把代码提交到 Git；如果代码曾出现在日志、截图或公共剪贴板中，请在 Telegram/Cloudflare 控制台轮换相应密钥。
- “Star”只是部署前提醒，不是权限控制，也不是 GitHub 官方验证。清理该浏览器的站点数据后会再次出现提醒。
