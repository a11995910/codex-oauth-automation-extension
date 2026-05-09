# 内置 Codex JSON 来源说明

侧边栏“来源”中的 `内置 Codex JSON` 用于在不启动 CPA、SUB2API、Codex2API 或 Manager 服务的情况下完成 Codex OAuth。扩展负责生成授权链接、保存本轮 `state / code_verifier` 运行态、捕获 localhost 回调、向 OpenAI token endpoint 交换 token，并下载 CLIProxyAPI 兼容的认证 JSON。

## 授权链接

步骤 7 使用 Codex CLI OAuth 参数生成授权链接：

- `client_id`: `app_EMoamEEZ73f0CkXaXp7hrann`
- `redirect_uri`: `http://localhost:1455/auth/callback`
- `scope`: `openid email profile offline_access`
- `code_challenge_method`: `S256`
- `prompt`: `login`
- `id_token_add_organizations`: `true`
- `codex_cli_simplified_flow`: `true`

扩展会为每一轮生成新的随机 `state` 和 PKCE `code_verifier / code_challenge`。`code_verifier` 只保存在 `chrome.storage.session` 运行态中，用于步骤 10 交换 token。

## 回调交换

步骤 10 会先校验 localhost 回调必须包含 `code / state`，并且回调 `state` 必须等于当前步骤 7 生成的 `builtinCodexOAuthState`。校验通过后，扩展向：

```txt
https://auth.openai.com/oauth/token
```

发送 `application/x-www-form-urlencoded` 请求，字段为：

- `grant_type=authorization_code`
- `client_id=app_EMoamEEZ73f0CkXaXp7hrann`
- `code`
- `redirect_uri=http://localhost:1455/auth/callback`
- `code_verifier`

## JSON 输出

扩展会从 `id_token` JWT payload 读取邮箱、ChatGPT account ID 和 plan type，并生成 CLIProxyAPI 兼容 JSON：

```json
{
  "id_token": "...",
  "access_token": "...",
  "refresh_token": "...",
  "account_id": "...",
  "last_refresh": "2026-05-09T00:00:00.000Z",
  "email": "user@example.com",
  "type": "codex",
  "expired": "2026-05-09T01:00:00.000Z"
}
```

文件名遵循 CLIProxyAPI Codex 凭据命名规则：

- 无 plan：`codex-邮箱.json`
- 普通 plan：`codex-邮箱-plan.json`
- team plan：`codex-账号哈希前8位-邮箱-team.json`

扩展通过 `chrome.downloads.download` 下载 JSON，下载路径固定为浏览器 Downloads 下的 `Codex-OAuth-JSON/` 子文件夹，并使用 `uniquify` 处理重名文件。多次执行会继续落到同一个子文件夹中。

## 失败边界

- 缺少 `state`、`code` 或 `code_verifier` 时，当前步骤失败，需要重新执行 OAuth 登录步骤。
- 回调 `state` 不匹配时，当前步骤失败，避免把其它授权会话的 callback 错落成本轮 JSON。
- token endpoint 返回非 2xx、响应不是 JSON、或缺少 `id_token / access_token / refresh_token` 时，当前步骤失败。
- 扩展只下载 JSON，不会写入用户指定任意本地目录；文件固定落到浏览器 Downloads 的 `Codex-OAuth-JSON/` 子文件夹，重名策略由 Chrome 下载系统处理。
