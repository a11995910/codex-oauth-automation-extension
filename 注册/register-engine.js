// register-engine.js — full registration pipeline per account
// Orchestrates: Duck email → signup → code poll → profile → token save

const { generateDuckEmail } = require('./duck-mail');
const {
  goToSignup, enterEmail, enterPassword,
  enterVerificationCode, fillProfile,
  waitForRegistrationSuccess, extractAccessToken,
} = require('./signup-flow');
const { pollForCode } = require('./code-platform');
const { generateRandomName, generateRandomBirthday, generatePassword } = require('./data-names');
const fs = require('fs');
const path = require('path');

async function registerOneAccount(browser, config, runId, onLog) {
  const log = (msg, level = 'info') => {
    if (onLog) onLog(level, `[#${runId}] ${msg}`);
  };

  const signal = config.signal || null;
  const codeUrl = config.codePlatformBaseUrl || 'https://code.youkeduo.site';
  const apiKey = config.codePlatformApiKey || '';
  const accountsDir = config.accountsDir || './accounts';

  let email = '';
  let password = '';
  let duckPage = null;
  let signupPage = null;

  try {
    // ---- STEP 1: Generate DuckDuckGo email ----
    log('正在生成 DuckDuckGo 邮箱地址...');
    duckPage = await browser.newPage();
    email = await generateDuckEmail(duckPage, { generateNew: true, signal });
    await duckPage.close();
    duckPage = null;
    log(`已生成邮箱：${email}`, 'ok');

    // ---- STEP 2: Go to ChatGPT and click signup ----
    log('正在打开 ChatGPT 注册页面...');
    signupPage = await browser.newPage();
    await goToSignup(signupPage, signal);
    log('已进入注册流程');

    // ---- STEP 3: Enter email ----
    log('正在填写邮箱...');
    await enterEmail(signupPage, email, signal);
    log('邮箱已提交');

    // ---- STEP 4: Generate password and enter ----
    password = generatePassword();
    log('正在填写密码...');
    await enterPassword(signupPage, password, signal);
    log('密码已提交', 'ok');

    // ---- STEP 5: Poll for verification code ----
    log('正在等待验证码（轮询验证码平台）...');
    const result = await pollForCode(codeUrl, apiKey, email, {
      maxAttempts: 25,
      intervalMs: 3000,
      signal,
    });
    log(`已获取验证码：${result.code}`, 'ok');

    // ---- STEP 6: Enter verification code ----
    log('正在填写验证码...');
    await enterVerificationCode(signupPage, result.code, signal);
    log('验证码已提交');

    // ---- STEP 7: Fill profile ----
    const { firstName, lastName } = generateRandomName();
    const birthday = generateRandomBirthday();
    log(`正在填写资料（${firstName} ${lastName}）...`);
    await fillProfile(signupPage, firstName, lastName, birthday.year, birthday.month, birthday.day, signal);
    log('资料已提交', 'ok');

    // ---- STEP 8: Wait for registration success ----
    log('等待注册完成...');
    const ok = await waitForRegistrationSuccess(signupPage, 60000);
    if (!ok) {
      log('警告：未能确认注册成功，尝试继续提取 token...', 'warn');
    } else {
      log('注册成功，已进入 ChatGPT 首页！', 'ok');
    }

    // ---- STEP 9: Extract access token ----
    log('正在提取 access token...');
    const accessToken = await extractAccessToken(signupPage);
    if (!accessToken) {
      log('警告：未能提取到 access token，可能注册未完成', 'warn');
    } else {
      log(`已提取 access token：${accessToken.slice(0, 20)}...`, 'ok');
    }

    // ---- STEP 10: Save account JSON ----
    const accountData = {
      email,
      password,
      firstName,
      lastName,
      birthday: `${birthday.year}-${String(birthday.month).padStart(2, '0')}-${String(birthday.day).padStart(2, '0')}`,
      accessToken: accessToken || '',
      sessionToken: accessToken || '',
      registeredAt: new Date().toISOString(),
    };

    const dir = path.resolve(accountsDir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const fileName = `account-${email.replace(/[@.]/g, '_')}.json`;
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(accountData, null, 2), 'utf-8');
    log(`账号已保存至：${filePath}`, 'ok');

    return { success: true, email, password, accessToken, filePath, accountData };
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.includes('ABORTED')) {
      log('已被用户停止', 'warn');
      return { success: false, error: 'ABORTED', email };
    }
    log(`注册失败：${msg}`, 'error');
    return { success: false, error: msg, email, password };
  } finally {
    // cleanup pages
    if (duckPage) {
      try { await duckPage.close(); } catch { /* ignore */ }
    }
    if (signupPage) {
      try { await signupPage.close(); } catch { /* ignore */ }
    }
  }
}

module.exports = { registerOneAccount };
