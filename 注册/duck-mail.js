// duck-mail.js — DuckDuckGo Email Protection address generation via Puppeteer
// Opens DDG autofill settings page, clicks generate, reads the new @duck.com address.

const DUCK_AUTOFILL_URL = 'https://duckduckgo.com/email/settings/autofill';
const GENERATOR_BTN_SELECTOR = 'button.AutofillSettingsPanel__GeneratorButton';
const ADDRESS_INPUT_SELECTOR = 'input.AutofillSettingsPanel__PrivateDuckAddressValue';
const GENERATE_TEXT_PATTERN = /generate\s+private\s+duck\s+address|new\s+private\s+duck\s+address|generate\s+new|new\s+address|生成.*地址/i;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function findGeneratorButton(page) {
  const direct = await page.$(GENERATOR_BTN_SELECTOR);
  if (direct) return direct;

  const buttons = await page.$$('button');
  for (const btn of buttons) {
    const text = await page.evaluate((el) => {
      const parts = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')];
      return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }, btn);
    if (GENERATE_TEXT_PATTERN.test(text)) {
      return btn;
    }
  }
  return null;
}

async function readEmailInput(page) {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    const val = (el?.value || '').trim();
    return val.includes('@duck.com') ? val : '';
  }, ADDRESS_INPUT_SELECTOR);
}

async function generateDuckEmail(page, options = {}) {
  const { generateNew = true, signal } = options;

  await page.goto(DUCK_AUTOFILL_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // check if logged in — wait for UI elements
  try {
    await page.waitForSelector(
      `${ADDRESS_INPUT_SELECTOR}, ${GENERATOR_BTN_SELECTOR}`,
      { visible: true, timeout: 10000 }
    );
  } catch {
    const url = page.url();
    if (!url.includes('/email/settings/autofill')) {
      throw new Error(
        'DUCK_NOT_LOGGED_IN: 请先在打开的浏览器窗口中登录 DuckDuckGo（duckduckgo.com/email），登录后重试。'
      );
    }
    throw new Error('DuckDuckGo 邮箱设置页面加载超时，请检查网络后重试。');
  }

  if (signal?.aborted) throw new Error('ABORTED');

  const currentEmail = await readEmailInput(page);
  if (currentEmail && !generateNew) {
    return currentEmail;
  }

  const genBtn = await findGeneratorButton(page);
  if (!genBtn) {
    if (currentEmail) return currentEmail;
    throw new Error('未找到"生成 Duck 私有地址"按钮，请确认已登录 DuckDuckGo Email Protection。');
  }

  const prevEmail = currentEmail || '';
  await genBtn.click();

  // wait for new address to appear
  for (let i = 0; i < 60; i++) {
    if (signal?.aborted) throw new Error('ABORTED');
    const nextEmail = await readEmailInput(page);
    if (nextEmail && nextEmail !== prevEmail) {
      return nextEmail;
    }
    await sleep(200);
  }

  // retry once
  const retryBtn = await findGeneratorButton(page);
  if (retryBtn) {
    await retryBtn.click();
    for (let i = 0; i < 60; i++) {
      if (signal?.aborted) throw new Error('ABORTED');
      const nextEmail = await readEmailInput(page);
      if (nextEmail && nextEmail !== prevEmail) {
        return nextEmail;
      }
      await sleep(200);
    }
  }

  throw new Error('DuckDuckGo 地址生成失败，未检测到新地址出现。');
}

module.exports = { generateDuckEmail, DUCK_AUTOFILL_URL };
