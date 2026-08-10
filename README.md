# SentinelRelay 哨兵中继

基于 Cloudflare Workers 的 Telegram 安全双向私信中继。

## 当前状态

仓库目前保留了 Cloudflare Workers 的 VLESS WebSocket/TCP/UDP 中继示例：

- `snippets_vless_demo.js`：Worker 入口及连接、SOCKS5/HTTP 代理和 DNS over HTTPS 处理逻辑
- `go.mod`：后续服务端组件使用的 Go 模块占位配置

Telegram 双向私信中继功能将在此基础上继续实现。

## 安全提示

- 部署前请将 Worker 中的固定 UUID 替换为自己的 UUID，或通过环境变量/密钥管理注入。
- 不要把 Telegram Bot Token、代理账号密码或其他凭据提交到仓库。
- 生产部署前请限制可访问的 Telegram 用户、启用日志脱敏，并检查 Cloudflare Worker 的密钥配置。

## 许可证

许可证将在项目功能稳定后补充。
