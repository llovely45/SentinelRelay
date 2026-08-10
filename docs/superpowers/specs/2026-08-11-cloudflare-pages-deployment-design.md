# Cloudflare Pages 部署设计

## 目标

让公开 GitHub 仓库可以直接连接到 Cloudflare Pages，托管 SentinelRelay 的静态部署向导；Telegram 中继 Worker 继续作为独立 Cloudflare Worker 部署，并通过 D1 绑定 `DB` 运行。

## 方案

- Pages 项目使用仓库根目录作为构建输出目录，构建命令为空（纯静态部署）。
- 根路径 `/` 提供入口页并跳转到 `/deploy/index.html`，因此 Pages 默认域名打开即进入部署向导。
- 部署向导继续从同源 `/worker/worker.js` 读取 Worker 模板；不在 Pages 构建过程中注入任何秘密。
- `deploy/` 页面只负责在浏览器中验证配置、生成可复制的 Worker 源码；真正的 Worker 仍需在 Workers 控制台部署并绑定 D1。
- 使用 `_headers` 限制静态资源的安全策略，并对入口页、脚本和 Worker 模板使用浏览器缓存策略，避免部署向导读取到陈旧模板。

## 访问流程

1. 用户打开 Pages 根域名。
2. 根入口跳转到 `/deploy/index.html`。
3. 页面通过相对路径读取 `/worker/worker.js`，在浏览器内完成 Telegram API 配置验证和代码生成。
4. 用户复制生成的代码到 Cloudflare Workers，并按现有教程绑定 D1 `DB`。

## 边界与安全

- Pages 不接收 Telegram Bot Token、Turnstile Secret 或生成后的 Worker 代码；所有敏感值仅存在当前浏览器内存。
- Pages 不承载 Telegram Webhook，也不替代需要 D1 的 Worker。
- 入口页不得引入第三方脚本；部署向导已有的 Turnstile/Telegram 脚本仍由页面按原用途加载。
- `_headers` 使用兼容静态 Pages 的声明式格式，不依赖构建工具或运行时。

## 验证标准

- 根入口、部署页和 Worker 模板在静态 HTTP 服务中均返回 200。
- 部署页仍能通过现有 Node 测试，且模板占位符检查不受影响。
- Pages 文档明确写出 GitHub 连接、生产分支、构建命令留空、输出目录 `.`，以及 Worker/D1 的独立部署关系。
