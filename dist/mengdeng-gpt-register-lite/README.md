# 猛蹬GPT注册器

这是面向内置 Codex JSON 落地链路的简化版浏览器扩展。扩展只保留邮箱注册、DuckDuckGo 邮箱生成、QQ/2925/验证码平台收码、HeroSMS/SMSBower 手机号验证兜底，以及生成 Codex JSON 的主流程。侧边栏也支持网页 access token 注册模式，用于只注册网页账号并按批次导出 ChatGPT 网页 access token。

## 功能范围

- 来源固定为 `内置 Codex JSON`。
- 网页 access token 注册开关默认关闭；开启后流程只执行到 Step 6，并将当前批次 access token 下载到 `ChatGPT-Web-Access-Tokens`，每行一个 token。
- 邮箱生成固定为 `DuckDuckGo`。
- 邮箱服务保留 `QQ 邮箱`、`2925 邮箱` 与 `验证码平台`。
- 验证码平台默认地址为 `https://code.youkeduo.site`，会按当前注册邮箱直接查询线上验证码，不再打开网页邮箱。
- 注册方式固定为 `邮箱注册`。
- 接码服务仅保留 `HeroSMS` 与 `SMSBower`。
- 每次手机号验证都会重新获取号码。
- 顶部品牌显示为 `猛蹬小店`，顶部入口不跳转外部页面。
- 不包含新手引导、在线公告或在线版本检测。

## 使用方式

1. 打开 Chrome / Edge 的扩展管理页面。
2. 开启开发者模式。
3. 选择“加载已解压的扩展程序”。
4. 选择当前文件夹 `dist/mengdeng-gpt-register-lite`。

## 目录说明

- `manifest.json`：扩展清单名称为 `猛蹬GPT注册器`，面板内品牌显示为 `猛蹬小店`。
- `sidepanel/`：侧边栏页面与交互逻辑。
- `background.js`、`background/`：自动注册、收码、OAuth 与 Codex JSON 生成流程。
- `content/`：注册页、QQ 邮箱、DuckDuckGo、2925 等页面脚本。
- `icons/`：扩展图标与侧边栏品牌 logo。
- `docs/功能说明.md`：当前简化版功能说明。
