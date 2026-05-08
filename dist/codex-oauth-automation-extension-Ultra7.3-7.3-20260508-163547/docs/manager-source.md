# Manager 来源 OAuth 对接说明

## 目标

侧边栏“来源”新增 `Manager`，用于对接 Codex Manager 的 ChatGPT OAuth 账号录入能力。扩展负责获取 OAuth 授权链接、捕获 localhost 回调，并通过 Manager RPC 完成本轮账号录入。

## 配置项

- `Manager`：Codex Manager 服务地址，默认 `http://localhost:48760`。
- `RPC Token`：Codex Manager 的 RPC 鉴权令牌。Manager 服务会校验 `X-CodexManager-Rpc-Token` 请求头，扩展不会尝试从本机 token 文件读取，需要用户在侧边栏手动填写。
- `标签`：可选，按逗号分隔，原样传给 Manager 登录开始接口。
- `备注`：可选，原样传给 Manager 登录开始接口。

## RPC 调用

扩展会把 Manager 地址统一归一化为 `/rpc` 路径，例如：

- `localhost:48760` -> `http://localhost:48760/rpc`
- `http://localhost:48760/auth/callback` -> `http://localhost:48760/rpc`

### 生成授权链接

步骤 7 通过 JSON-RPC 调用：

- `method`: `account/login/start`
- `params.type`: `chatgpt`
- `params.openBrowser`: `false`
- `params.tags`: 侧边栏标签，空值传 `null`
- `params.note`: 侧边栏备注，空值传 `null`

扩展会读取返回中的 `authUrl/auth_url` 与 `loginId/login_id`，并保存 `managerLoginId`、`managerOAuthState`，用于后续回调 state 校验。

### 完成账号录入

步骤 10 捕获 `localhost` OAuth 回调后，通过 JSON-RPC 调用：

- `method`: `account/login/complete`
- `params.state`: 回调 URL 中的 `state`
- `params.code`: 回调 URL 中的 `code`
- `params.redirectUri`: 回调 URL 的 origin 加 `/auth/callback`

扩展会先校验回调 `state` 与当前 Manager 授权会话一致，再提交给 Manager，避免把其它授权会话的回调误录入。

## 与 CPA 同时运行

Manager 默认端口是 `48760`，现有 CPA 管理接口默认使用 `8317`。两者使用不同端口时可以同时运行，不会因为扩展新增 Manager 来源而影响 CPA 录入。

需要注意的边界：

- 如果手动把 Manager 和 CPA 配成同一个端口，同一台机器上只能有一个服务成功监听该端口，另一个会启动失败或不可访问。
- 扩展只会按当前侧边栏选择的来源提交回调：选择 CPA 时走 CPA 管理接口，选择 Manager 时走 Manager RPC。
- Manager 模式的回调完成接口使用 Manager 回调 origin 生成 `redirectUri`，不会改动 CPA 的回调提交流程。

