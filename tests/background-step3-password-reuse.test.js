const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/steps/fill-password.js', 'utf8');
const globalScope = {};
const api = new Function('self', `${source}; return self.MultiPageBackgroundStep3;`)(globalScope);

test('step 3 reuses existing generated password when rerunning the same email flow', async () => {
  const events = {
    passwordStates: [],
    messages: [],
  };

  const executor = api.createStep3Executor({
    addLog: async () => {},
    chrome: { tabs: { update: async () => {} } },
    ensureContentScriptReadyOnTab: async () => {},
    generatePassword: () => 'Generated-Should-Not-Be-Used',
    getTabId: async () => 88,
    isTabAlive: async () => true,
    sendToContentScript: async (_source, message) => {
      events.messages.push(message);
    },
    setPasswordState: async (password) => {
      events.passwordStates.push(password);
    },
    setState: async () => {},
    SIGNUP_PAGE_INJECT_FILES: [],
  });

  await executor.executeStep3({
    email: 'keep@example.com',
    password: 'Secret123!',
    customPassword: '',
    accounts: [],
  });

  assert.deepStrictEqual(events.passwordStates, ['Secret123!']);
  assert.deepStrictEqual(events.messages, [
    {
      type: 'EXECUTE_STEP',
      step: 3,
      source: 'background',
      payload: {
        email: 'keep@example.com',
        phoneNumber: '',
        accountIdentifierType: 'email',
        accountIdentifier: 'keep@example.com',
        password: 'Secret123!',
      },
    },
  ]);
});

test('step 3 supports phone-only signup identity when password page is present', async () => {
  const events = {
    passwordStates: [],
    messages: [],
    stateUpdates: [],
    logs: [],
  };

  const executor = api.createStep3Executor({
    addLog: async (message) => {
      events.logs.push(message);
    },
    chrome: { tabs: { update: async () => {} } },
    ensureContentScriptReadyOnTab: async () => {},
    generatePassword: () => 'Generated123!',
    getTabId: async () => 88,
    isTabAlive: async () => true,
    sendToContentScript: async (_source, message) => {
      events.messages.push(message);
    },
    setPasswordState: async (password) => {
      events.passwordStates.push(password);
    },
    setState: async (updates) => {
      events.stateUpdates.push(updates);
    },
    SIGNUP_PAGE_INJECT_FILES: [],
  });

  await executor.executeStep3({
    email: '',
    signupPhoneNumber: '66959916439',
    accountIdentifierType: 'phone',
    accountIdentifier: '66959916439',
    customPassword: 'PhoneSecret123!',
    accounts: [],
  });

  assert.deepStrictEqual(events.passwordStates, ['PhoneSecret123!']);
  assert.equal(events.logs.some((message) => /注册手机号为 66959916439/.test(message)), true);
  assert.equal(events.stateUpdates.length, 1);
  assert.deepStrictEqual(events.stateUpdates[0].accounts.map((account) => ({
    email: account.email,
    phoneNumber: account.phoneNumber,
    accountIdentifierType: account.accountIdentifierType,
    accountIdentifier: account.accountIdentifier,
    password: account.password,
  })), [
    {
      email: '',
      phoneNumber: '66959916439',
      accountIdentifierType: 'phone',
      accountIdentifier: '66959916439',
      password: 'PhoneSecret123!',
    },
  ]);
  assert.deepStrictEqual(events.messages, [
    {
      type: 'EXECUTE_STEP',
      step: 3,
      source: 'background',
      payload: {
        email: '',
        phoneNumber: '66959916439',
        accountIdentifierType: 'phone',
        accountIdentifier: '66959916439',
        password: 'PhoneSecret123!',
      },
    },
  ]);
});

test('step 3 phone signup intent does not fall back to a stale email identity', async () => {
  const events = {
    passwordStates: [],
    messages: [],
    stateUpdates: [],
  };

  const executor = api.createStep3Executor({
    addLog: async () => {},
    chrome: { tabs: { update: async () => {} } },
    ensureContentScriptReadyOnTab: async () => {},
    generatePassword: () => 'Generated123!',
    getTabId: async () => 88,
    isTabAlive: async () => true,
    resolveSignupMethod: () => 'phone',
    sendToContentScript: async (_source, message) => {
      events.messages.push(message);
    },
    setPasswordState: async (password) => {
      events.passwordStates.push(password);
    },
    setState: async (updates) => {
      events.stateUpdates.push(updates);
    },
    SIGNUP_PAGE_INJECT_FILES: [],
  });

  await assert.rejects(
    () => executor.executeStep3({
      email: 'stale@example.com',
      signupMethod: 'phone',
      resolvedSignupMethod: 'phone',
      accountIdentifierType: null,
      accountIdentifier: '',
      customPassword: 'PhoneSecret123!',
      accounts: [],
    }),
    /缺少注册手机号，请先完成步骤 2 或在侧栏填写注册手机号后再执行步骤 3。/
  );

  assert.deepStrictEqual(events.passwordStates, []);
  assert.deepStrictEqual(events.stateUpdates, []);
  assert.deepStrictEqual(events.messages, []);
});

test('step 3 respects resolved email fallback when phone signup is unavailable', async () => {
  const events = {
    messages: [],
  };

  const executor = api.createStep3Executor({
    addLog: async () => {},
    chrome: { tabs: { update: async () => {} } },
    ensureContentScriptReadyOnTab: async () => {},
    generatePassword: () => 'Generated123!',
    getTabId: async () => 88,
    isTabAlive: async () => true,
    resolveSignupMethod: () => 'email',
    sendToContentScript: async (_source, message) => {
      events.messages.push(message);
    },
    setPasswordState: async () => {},
    setState: async () => {},
    SIGNUP_PAGE_INJECT_FILES: [],
  });

  await executor.executeStep3({
    email: 'fallback@example.com',
    signupMethod: 'phone',
    resolvedSignupMethod: 'email',
    customPassword: 'EmailSecret123!',
    accounts: [],
  });

  assert.equal(events.messages[0].payload.accountIdentifierType, 'email');
  assert.equal(events.messages[0].payload.accountIdentifier, 'fallback@example.com');
});
