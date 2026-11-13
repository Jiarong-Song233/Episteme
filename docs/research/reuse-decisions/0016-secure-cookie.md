# 复用决策记录 0016：HTTPS 部署的会话 Cookie 带 Secure

日期：2026-11-13。

## 要解决的问题

多人部署时，会话 Cookie 只有 `HttpOnly; SameSite=Strict`，没有 `Secure`。部署说明要求放在 TLS 反向代理后面，但浏览器仍可能在明文 HTTP 请求里带上这个 Cookie，比如有人直接访问服务器的明文地址，或者网络里有降级。

## 本仓已有能力

- 共享部署必须给出 `--public-origin`，也就是人实际访问的地址。服务已经用它做来源和主机名校验。
- 本机模式在 `http://127.0.0.1` 上运行，会话 Cookie 由服务页面直接下发。

## 参考

- [RFC 6265bis](https://datatracker.ietf.org/doc/draft-ietf-httpbis-rfc6265bis/) 的 `Secure` 属性：带这个属性的 Cookie 只在安全通道上发送。
- [MDN：Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie)：Chromium 和 Firefox 把 `http://localhost`、`127.0.0.1` 视为安全上下文，在那里也接受 `Secure` Cookie。
- 常见做法（如 Express 的 `cookie.secure` 选项）是“对外是 HTTPS 就设 Secure”。这里只有一行字符串拼接，不需要引入库。

## 决定

- `BrowserSessions` 接受 `secure` 选项。服务在 `--public-origin` 是 `https:` 时打开它。
- 本机模式和 `http:` 的对外地址都不变。
- 不改会话的存储、有效期和其他属性。

## 验证

- `tests/identity.test.ts`：本机模式的 Cookie 没有 `Secure`；共享模式（`https://` 对外地址）登录后的 Cookie 有 `Secure`。
- `tests/workbench-sharing-web.test.ts`：真实浏览器（Edge）经 `http://127.0.0.1` 访问 `https://` 对外地址的服务，登录、发布、引用照常。这说明浏览器在本机接受 `Secure` Cookie。

## 局限

- 没有在真实的 HTTPS 反向代理后面测过。
- 如果有人对外地址写 `https://`，却绕过代理、用明文 HTTP 直接访问服务器，浏览器不会带上 Cookie，会一直显示未登录。部署说明已写明要经代理访问。
