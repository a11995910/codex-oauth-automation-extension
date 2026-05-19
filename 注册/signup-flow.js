// signup-flow.js — ChatGPT signup page automation via Puppeteer
// Ported selectors and interaction patterns from content/signup-page.js

const SIGNUP_ENTRY_URL = 'https://chatgpt.com/';

// React input helper — ChatGPT uses React-controlled inputs, so .type() alone
// may not work. Use the native property setter + dispatch events pattern.
async function fillReactInput(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: 15000 });
  // click to focus, then clear
  await page.click(selector, { clickCount: 3 });
  await page.evaluate(([sel, val]) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeSetter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [selector, value]);
  // also type a character to trigger React's onChange
  await page.type(selector, ' ', { delay: 20 });
  await page.evaluate(([sel, val]) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeSetter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, [selector, value]);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomPause() {
  return sleep(250 + Math.floor(Math.random() * 800));
}

// ---- button finders ----

async function findButtonByText(page, pattern) {
  const buttons = await page.$$('button[type="submit"], input[type="submit"], button, [role="button"]');
  for (const btn of buttons) {
    const visible = await btn.boundingBox();
    if (!visible) continue;
    const text = await page.evaluate((el) =>
      (el.textContent || el.value || el.getAttribute('aria-label') || '').trim(),
      btn
    );
    if (pattern.test(text)) return btn;
  }
  return null;
}

async function clickContinueButton(page) {
  const btn = await findButtonByText(page, /continue|next|submit|继续|下一步|agree|完成|创建|create|finish|done/i);
  if (!btn) throw new Error('未找到提交/继续按钮');
  await btn.click();
}

// ---- signup entry ----

async function goToSignup(page, signal) {
  await page.goto(SIGNUP_ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (signal?.aborted) throw new Error('ABORTED');

  // wait for homepage to render
  await sleep(2000);

  // try to find and click "Sign up" button
  const signupBtn = await findButtonByText(page, /sign\s*up|register|create\s*account|create\s+account|注册|免费注册|立即注册/i);
  if (signupBtn) {
    await signupBtn.click();
    await sleep(1500);
  }

  // check if we're already on an auth page
  const url = page.url();
  if (!url.includes('/auth/') && !url.includes('/create-account/') && !url.includes('/log-in')) {
    // try clicking a link that leads to signup
    await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="auth"], a[href*="signup"], a[href*="sign-up"], a[href*="register"]');
      if (links.length > 0) links[0].click();
    });
    await sleep(2000);
  }
}

// ---- email entry ----

async function enterEmail(page, email, signal) {
  if (signal?.aborted) throw new Error('ABORTED');

  // wait for email input to appear
  const emailSelectors = [
    'input[type="email"]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[id*="email" i]',
    'input[placeholder*="email" i]',
    'input[placeholder*="电子邮件"]',
    'input[placeholder*="邮箱"]',
    'input[aria-label*="email" i]',
    'input[aria-label*="电子邮件"]',
    'input[aria-label*="邮箱"]',
  ];

  let emailInput = null;
  for (const sel of emailSelectors) {
    emailInput = await page.$(sel);
    if (emailInput) {
      const visible = await emailInput.boundingBox();
      if (visible) break;
      emailInput = null;
    }
  }

  if (!emailInput) {
    // try any visible text input
    const inputs = await page.$$('input[type="text"], input:not([type])');
    for (const inp of inputs) {
      const visible = await inp.boundingBox();
      if (visible) { emailInput = inp; break; }
    }
  }

  if (!emailInput) throw new Error('未找到邮箱输入框');

  // fill using the element handle directly
  await emailInput.click({ clickCount: 3 });
  await emailInput.type(email, { delay: 30 });
  // also set via native setter for React-controlled inputs
  await page.evaluate(([el, val]) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeSetter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [emailInput, email]);

  await randomPause();
  await clickContinueButton(page);
  await sleep(2000);
}

// ---- password entry ----

async function enterPassword(page, password, signal) {
  if (signal?.aborted) throw new Error('ABORTED');

  await page.waitForSelector('input[type="password"]', { visible: true, timeout: 20000 });
  await randomPause();

  await fillReactInput(page, 'input[type="password"]', password);

  await randomPause();
  await clickContinueButton(page);
  await sleep(2000);
}

// ---- verification code ----

async function enterVerificationCode(page, code, signal) {
  if (signal?.aborted) throw new Error('ABORTED');

  // wait for the verification page to load
  await sleep(1500);

  // try single 6-digit input first
  const singleInputs = [
    'input[maxlength="6"]',
    'input[data-testid*="code"]',
    'input[name="code"]',
    'input[placeholder*="code" i]',
    'input[placeholder*="验证码"]',
    'input[inputmode="numeric"]',
  ];

  let filled = false;
  for (const sel of singleInputs) {
    const el = await page.$(sel);
    if (el) {
      const visible = await el.boundingBox();
      if (visible) {
        await fillReactInput(page, sel, code);
        filled = true;
        break;
      }
    }
  }

  if (!filled) {
    // try 6 individual digit inputs
    const digitInputs = await page.$$('input[maxlength="1"]');
    if (digitInputs.length >= 5) {
      const digits = code.split('');
      for (let i = 0; i < Math.min(digits.length, digitInputs.length); i++) {
        await digitInputs[i].type(digits[i], { delay: 30 });
      }
      filled = true;
    }
  }

  if (!filled) {
    // last resort: type into whatever input is focused
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    if (focused === 'INPUT') {
      await page.keyboard.type(code, { delay: 50 });
      filled = true;
    }
  }

  if (!filled) throw new Error('未找到验证码输入框');

  await randomPause();
  await clickContinueButton(page);
  await sleep(2000);
}

// ---- profile ----

async function fillProfile(page, firstName, lastName, year, month, day, signal) {
  if (signal?.aborted) throw new Error('ABORTED');

  await sleep(1500);

  const fullName = `${firstName} ${lastName}`;

  // name field
  const nameSelectors = ['input[name="name"]', 'input[placeholder*="全名"]', 'input[autocomplete="name"]'];
  let nameFilled = false;
  for (const sel of nameSelectors) {
    const el = await page.$(sel);
    if (el) {
      const visible = await el.boundingBox();
      if (visible) {
        await fillReactInput(page, sel, fullName);
        nameFilled = true;
        break;
      }
    }
  }

  // birthday — try spinbuttons first
  const yearEl = await page.$('[role="spinbutton"][data-type="year"]');
  const monthEl = await page.$('[role="spinbutton"][data-type="month"]');
  const dayEl = await page.$('[role="spinbutton"][data-type="day"]');

  if (yearEl && monthEl && dayEl) {
    await yearEl.click();
    await page.keyboard.type(String(year), { delay: 50 });
    await sleep(100);
    await monthEl.click();
    await page.keyboard.type(String(month), { delay: 50 });
    await sleep(100);
    await dayEl.click();
    await page.keyboard.type(String(day), { delay: 50 });
  } else {
    // try React Aria select pattern
    const birthdayFilled = await page.evaluate(({ y, m, d }) => {
      const selects = document.querySelectorAll('select');
      if (selects.length >= 3) {
        // try to find year/month/day by label
        for (const sel of selects) {
          const label = sel.getAttribute('aria-label') || sel.name || '';
          if (/year|年/i.test(label)) { sel.value = String(y); sel.dispatchEvent(new Event('change', { bubbles: true })); }
          if (/month|月/i.test(label)) { sel.value = String(m); sel.dispatchEvent(new Event('change', { bubbles: true })); }
          if (/day|日|天/i.test(label)) { sel.value = String(d); sel.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        return true;
      }
      return false;
    }, { y: year, m: month, d: day });
  }

  await randomPause();
  await clickContinueButton(page);
  await sleep(3000);
}

// ---- wait for success ----

async function waitForRegistrationSuccess(page, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    // if we land on chatgpt.com and NOT on an auth/signup page, we're done
    if (/chatgpt\.com/i.test(url) && !/[\/](?:auth|create-account|email-verification|log-in|add-phone)[\/\?#]/i.test(url)) {
      return true;
    }
    await sleep(1000);
  }
  // check once more
  const url = page.url();
  return /chatgpt\.com/i.test(url) && !/[\/](?:auth|create-account|email-verification|log-in|add-phone)[\/\?#]/i.test(url);
}

// ---- extract tokens ----

async function extractAccessToken(page) {
  // try localStorage for Auth0 session
  const tokenData = await page.evaluate(() => {
    try {
      // look for OpenAI/auth0 session data in localStorage
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (key.includes('auth0') || key.includes('openai') || key.includes('chatgpt')) {
          const val = localStorage.getItem(key);
          try {
            const parsed = JSON.parse(val);
            if (parsed?.body?.access_token) {
              return { access_token: parsed.body.access_token, source: 'localStorage' };
            }
            if (parsed?.access_token) {
              return { access_token: parsed.access_token, source: 'localStorage' };
            }
            if (parsed?.accessToken) {
              return { access_token: parsed.accessToken, source: 'localStorage' };
            }
          } catch { /* not JSON */ }
        }
      }
    } catch { /* localStorage access error */ }
    return null;
  });

  if (tokenData?.access_token) {
    return tokenData.access_token;
  }

  // try OAuth session token from cookies
  const cookies = await page.cookies();
  const sessionCookie = cookies.find(c =>
    c.name === '__Secure-next-auth.session-token' ||
    c.name === 'next-auth.session-token'
  );
  if (sessionCookie) {
    return sessionCookie.value;
  }

  // try extracting from page context
  const fromPage = await page.evaluate(() => {
    // check for __NEXT_DATA__ or similar
    if (window.__NEXT_DATA__?.props?.pageProps?.accessToken) {
      return window.__NEXT_DATA__.props.pageProps.accessToken;
    }
    return null;
  });

  return fromPage || null;
}

module.exports = {
  goToSignup,
  enterEmail,
  enterPassword,
  enterVerificationCode,
  fillProfile,
  waitForRegistrationSuccess,
  extractAccessToken,
  SIGNUP_ENTRY_URL,
};
