# SentinelRelay 部署向导

`deploy/index.html` 是一个完全静态的配置页。它先检查预部署 Worker 的地址，再在浏览器中校验 Telegram 配置、读取同目录的 `worker.js` 模板并替换配置占位符；Token 和 Secret 会保存在当前浏览器的 `localStorage`，不会上传到服务器、URL 或下载文件。

## 连接 GitHub 部署到 Cloudflare Pages

本项目的 Pages 部署只托管这个静态向导，不部署 Telegram Worker。打开 Cloudflare 控制台，选择 **Workers & Pages → Create → Pages → Connect to Git**，授权 GitHub 后选择 [`llovely45/SentinelRelay`](https://github.com/llovely45/SentinelRelay)，配置：

- Production branch：`main`
- Framework preset：`None`
- Root directory：`.`
- Build command：`mkdir -p .pages-dist && find .pages-dist -mindepth 1 -maxdepth 1 -delete && cp deploy/index.html deploy/generator.js deploy/gate.js deploy/worker.js .pages-dist/`
- Build output directory：`.pages-dist`
- Deploy command（如果控制台强制显示此字段）：`node -e "console.log('Cloudflare Pages 将自动发布 .pages-dist')"`

部署完成后，访问 Pages 根地址即可直接打开部署向导。页面会从同源 `./worker.js` 读取模板。Pages 只负责展示向导和提供静态模板，不接收任何密钥，也不处理 Telegram Webhook。Pages Git 集成会自动发布 `.pages-dist`，不要在同一次构建里再执行 Wrangler 发布；若改用命令行手动发布，使用 `npx wrangler pages deploy .pages-dist --project-name sentinelrelay --branch main` 并配置相应的 Cloudflare 凭据。

生成代码后，仍需把代码单独粘贴回 Cloudflare Workers 默认项目，并继续使用名为 `DB` 的 D1 绑定；这一步不通过 Pages Functions 完成。

## 1. 用 HTTP 打开页面

不要直接双击 `index.html`。ES 模块和同源模板读取需要 HTTP 服务。请在仓库根目录运行：

```bash
python3 -m http.server 8000
```

然后打开 <http://127.0.0.1:8000/deploy/index.html>。首次受保护操作会显示“请稍后 / 正在验证是否给项目打星。。。”，等待一秒后显示“点击跳转”；第二次显示相同文案并在一秒后显示“我已验证”，完成后不再打断后续操作。

## 2. 准备配置

- 在 Cloudflare Workers 创建默认项目，创建 D1 并绑定为 `DB`，为 Worker 绑定自定义 HTTPS 域名（禁止使用 `*.workers.dev` 默认域名），再把地址填在页面第一项并点击“检查可达”。生成代码后把默认代码替换掉并重新部署。
- 创建 Telegram Bot，并把 Bot Token 填入页面。
- 创建一个开启 **Topics/Forum** 的超级群，把 Bot 加入群组，并授予读取消息、发送消息、管理话题和删除消息等所需权限。填入群组 ID（通常是负数），页面会用 `getMe` 和 `getChat` 直接验证。
- 在 Cloudflare Turnstile 创建站点，添加 Worker 的 HTTPS 域名（本地调试可按 Turnstile 控制台允许的测试域名配置），填入 Site Key 和 Secret Key。
- 填写至少 16 个字符的 Telegram Webhook Secret、验证 TTL 和 `stun:` 地址。

页面会把所有填写值持久化到当前浏览器的 `localStorage`，刷新或重新打开页面会自动恢复；生成的代码仍只存在于当前页面内存和用户主动复制到的系统剪贴板中。公共设备使用后请清除本站点数据。

每个配置框下方都有“填写教程”和独立的“验证”按钮：Worker 地址会检查可达性，Bot Token/群组 ID 会直接调用 Telegram API，其余字段会检查格式和范围。API 验证、生成代码以及所有字段验证按钮共用同一套一次性流程。连续点击页面标题五次会静默清除这组验证状态，不会清除表单配置。

## 3. 部署生成的 Worker

1. 完成“API 验证”，再点击“生成代码”。把只读代码框中的完整内容复制到默认 Worker 项目，替换默认脚本。
2. 确认该项目的 D1 绑定名为 **`DB`**。Worker 会在第一次请求时自动创建表和索引，不需要手动执行 SQL。
3. 部署 Worker 后，打开一次 `https://你的域名/health`。这会初始化 D1，并按当前地址和密钥注册 Telegram Webhook；以后可用该地址检查健康状态。
4. 将 Telegram Bot 的 Webhook 请求指向 Worker 自动注册的 `/telegram/webhook`。如果修改 Worker 地址或 Webhook Secret，请再次打开 `/health`。

升级提示：本模板使用 `processed_telegram_updates(bot_namespace, update_id)` 复合主键。若 D1 中已有早期测试版创建的同名旧表（只有 `update_id` 主键），请先备份并删除该表，或改用新的 D1 数据库，再访问 `/health`；D1 的 `CREATE TABLE IF NOT EXISTS` 不会自动迁移旧表结构。

## 4. 安全提醒

- 这是浏览器端生成器，不是远程部署服务；凭据不会发送到本仓库服务器。Telegram `getMe`/`getChat` 请求从浏览器直接发送到 `api.telegram.org`。
- 生成代码已经包含密钥。不要把代码提交到 Git；如果代码曾出现在日志、截图或公共剪贴板中，请在 Telegram/Cloudflare 控制台轮换相应密钥。
- 仓库跳转流程只记录本地浏览器状态，不查询 GitHub，也不是权限控制或 GitHub 官方验证。
