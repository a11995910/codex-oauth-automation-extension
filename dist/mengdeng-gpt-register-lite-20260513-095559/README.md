# 猛蹬GPT注册器

这是面向内置 Codex JSON 落地链路的简化版浏览器扩展。扩展只保留邮箱注册、DuckDuckGo 邮箱生成、QQ/2925/验证码平台收码、HeroSMS/SMSBower 手机号验证兜底，以及生成 Codex JSON 的主流程。

## 功能范围

- 来源固定为 `内置 Codex JSON`。
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
