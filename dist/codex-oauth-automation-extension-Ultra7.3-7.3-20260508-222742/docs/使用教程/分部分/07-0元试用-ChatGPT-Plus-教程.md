# 第七部分：0元试用 ChatGPT Plus 教程

## 部分信息

- `section_slug`: `chatgpt-plus-free-trial`
- `适用主题`: `ChatGPT Plus`、0元试用、支付链接提取脚本、PayPal 支付、地址推荐填写
- `维护方式`: `直接更新本文件`

## 适用场景

- 在已登录 ChatGPT 的状态下，想要快速生成 Plus 支付链接并尝试 0 元试用订阅。

## 准备内容

- 已有一个登录状态的 ChatGPT 账户。
- 一个可用的 PayPal 账户（参考第六部分进行注册和绑卡）。
- 能够接收生成的账单地址的真实地址或虚拟地址。
- Chrome 浏览器（推荐使用地址补全功能）。

## 操作步骤

### 【方案一】：通过 PayPal 订阅

如果你选择 PayPal 支付，可使用脚本快速生成支持 PayPal 的支付短链并操作，具体如下：

#### 第一步：进入 ChatGPT 并打开开发者工具

在已登录 ChatGPT 的页面上，按 `F12` 打开浏览器开发者工具。
点击 `Console`（控制台）标签进入命令行界面。

#### 第二步：允许粘贴脚本

在控制台中输入 `allow pasting` 并回车。
浏览器将允许你粘贴多行脚本代码。

#### 第三步：粘贴并执行脚本

复制下方脚本代码，粘贴到控制台，然后回车执行。

```javascript
(async function(){
    try {
        const t = await (await fetch("/api/auth/session")).json();
        if(!t.accessToken){
            alert("请先登录 ChatGPT！");
            return;
        }

        // 核心1：强制使用触发 PayPal 的欧洲区参数 (DE 德国 / EUR 欧元)
        const payload = {
            entry_point: "all_plans_pricing_modal",
            plan_name: "chatgptplusplan", // Plus 的套餐名
            billing_details: {
                country: "DE", // 必须是 DE 或 FR 才能在后续页面使用 PayPal
                currency: "EUR"
            },
            checkout_ui_mode: "custom",
            promo_campaign: {
                promo_campaign_id: "plus-1-month-free", // Plus 对应优惠码
                is_coupon_from_query_param: false
            }
        };

        const response = await fetch("https://chatgpt.com/backend-api/payments/checkout", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + t.accessToken,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        
        if(data.checkout_session_id) {
            // 核心2：拼接 Plus 的专属支付短链
            // 如果 openai_ie 报错，可以直接把 /openai_ie 删掉，变成 "https://chatgpt.com/checkout/" + data.checkout_session_id
            const shortLink = "https://chatgpt.com/checkout/openai_ie/" + data.checkout_session_id;
            
            // 弹窗让你复制这个带有 PayPal 的短链
            prompt("提取成功！这是你的 Plus 支付短链（复制保留）：", shortLink);
            
            // 自动跳转到该短链
            window.location.href = shortLink;
        } else {
            console.error(data);
            alert("提取失败：" + (data.detail || JSON.stringify(data)));
        }
    } catch(e) {
        alert("发生异常：" + e);
    }
})();
```

#### 第四步：复制支付短链

脚本执行后会弹出一个对话框，显示你的 Plus 支付短链。
点击"确定"按钮，页面会自动跳转到支付页面。
（可以复制这个链接备用，以防需要重新进入。）

#### 第五步：选择 PayPal 支付

页面加载完成后，你会看到 ChatGPT Plus 的 checkout 页面，标题通常为"开始免费试用 Plus"。
在左侧付款方式中选择 `PayPal`。

#### 第六步：填写账单信息 - 选择国家

页面右侧会显示账单地址表单。
"国家或地区" 字段会根据你当前的地址预填（通常是德国或法国）。
如果页面显示的不是你期望的国家，可以点击下拉框更改（建议保持德国或法国，以确保支付流程顺利）。

#### 第七步：填写账单信息 - 输入完整名字

在 "全名" 字段中输入完整的英文名字（例如 `John Smith`）。

#### 第八步：生成和填写地址

在 "地址第 1 行" 字段中开始输入。
输入城市名、州名或街道名（例如输入 `Berlin` 或 `New York`）。
页面会弹出 Google 地址推荐列表。
从推荐列表中选择一个地址项（建议选择第二项）。
页面会自动回填"城市"、"州"、"邮编"等字段。

#### 第九步：使用虚拟地址生成工具（可选）

如果地址推荐没有出现或推荐的地址不满足需求，可以使用 [https://www.meiguodizhi.com/](https://www.meiguodizhi.com/) 生成虚拟地址。
在该网站输入城市名或随机字母获取推荐地址，复制完整地址后粘贴到表单对应字段。

#### 第十步：完成地址填写并点击订阅

确认所有必填字段已填完（全名、地址、城市、州、邮编）。
在右侧点击 "订阅" 按钮。
页面会跳转到 PayPal 登录界面。

#### 第十一步：PayPal 登录

在 PayPal 登录页输入 PayPal 账户邮箱，然后输入 PayPal 账户密码。
点击 "登录" 按钮。

#### 第十二步：处理相关提示与弹窗

- 如果出现 "要在无痕模式以外保存此通行密钥吗？" 的弹窗，点击 "取消"。
- 如果出现 "下次登录更快捷" 或其他 PayPal 通行密钥引导弹窗，点击右上角的关闭图标。

#### 第十三步：同意并继续

页面显示 "只需一次设置，结账更快捷。" 以及向 `OpenAI Ireland Limited` 付款的摘要。
点击 "同意并继续" 按钮。
等待页面跳转并加载完成。

#### 第十四步：订阅成功

页面会回跳到 ChatGPT 或 OpenAI 的订阅确认页面。
此时 Plus 的0元试用订阅已成功完成。
你现在可以使用 ChatGPT Plus 的所有功能，试用期结束后会自动按月续订。

---

### 【方案二】：通过 GoPay 订阅

如果你需要通过印度尼西亚的 GoPay 钱包（配合国内手机号），可以直接在常规入口更改国家后购买：

#### 第一步：注册 WhatsApp

下载并打开 `WhatsApp`，将网络切换至台湾节点（别的应该也可以注册，如果注册不成功就换，自行尝试），使用你的国内手机号（`+86`）完成注册。

#### 第二步：注册 GoPay 并设置 PIN 码

1. 下载并打开 `GoPay` App，使用**与 WhatsApp 相同的国内手机号**进行注册。
2. 验证码会发送至你的 WhatsApp，前往 WhatsApp 获取并填入以完成注册。
3. 注册成功后，点击 `Profile`（个人资料），进入 `Account`（账户）设置 `PIN` 码。必须设置 PIN 码，否则后续即使有余额也无法支付。

#### 第三步：使用扩展运行账号并停止

1. 随意使用一个节点打开浏览器，配置好扩展（建议使用网易邮箱或自定义域名邮箱，iCloud 邮箱可能无法享受相关优惠）。
2. 让扩展运行到**第五步结束**，然后停止自动运行。
3. 如果页面有弹窗或新手引导，请先手动处理关闭。

#### 第四步：进入订阅页面更改国家

1. 在 ChatGPT 对话页面的最上方，点击 `免费试用` 按钮进入订阅页面。
2. 此时节点随意（无需和之前相同）。在支付界面的右下角，将国家/地区更改为**印度尼西亚**（`Indonesia`）。

#### 第五步：填写地址与 GoPay 支付

1. 付款方式选择 `GoPay`。
2. 填写账单地址：需要填写与你当前节点相匹配的地址。
   - 如果使用谷歌浏览器，可以随便输入几个字母利用自动补全功能。
   - 也可以前往 [美国地址生成器](https://www.meiguodizhi.com/) 生成一个对应的地址填入。
3. 点击 `订阅`。
4. 在弹出的支付页面中，输入你刚才注册 GoPay 的手机号（带 `+86`）。
5. 按照后续提示流程完成支付即可。

## 常见问题

### 为什么脚本执行报错 "请先登录 ChatGPT！"？

请确认你当前已登录 ChatGPT 账户。可以退出重新登录后再尝试运行脚本。

### 脚本执行返回错误信息怎么办？

先检查网络连接是否正常。如果多次尝试仍然失败，可能是当前账户不符合 0 元试用条件，请稍后再试。

### `/openai_ie` 部分出现 404 错误怎么办？

如果短链中的 `/openai_ie/` 无法访问，手动修改短链，删除 `/openai_ie/` 即可（变为 `https://chatgpt.com/checkout/{checkout_session_id}`），然后再访问。

### 支付页面没有显示 PayPal 选项？

这可能是因为脚本中的 `country` 参数不是 `DE`（德国）或 `FR`（法国）。重新运行脚本，确保脚本里国家参数为 DE 或 FR。

### 地址推荐没有出现怎么办？

在 "地址第 1 行" 中输入字母后，稍等 1-2 秒，输入框下方应该会出现推荐列表。如果一直没出现，可清空后重新输入，或直接跳到第九步借助虚拟地址生成网站生成地址填入。

### PayPal 登录后页面无法继续跳转？

稍等片刻让页面加载完毕。如果长时间未响应，检查浏览器是否有弹窗被拦截/隐藏，或者尝试刷新页面。

## 注意事项

- 执行脚本前必须处于已登录 ChatGPT 的状态。
- PayPal 必须要先绑定好有效的借记卡/信用卡。
- 试用期结束后会自动按月扣费续订。如果不打算长期使用，记得在后台取消连续订阅。