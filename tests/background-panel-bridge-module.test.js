const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('background imports panel bridge module', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /importScripts\([\s\S]*'background\/panel-bridge\.js'/);
});

test('panel bridge module exposes a factory', () => {
  const source = fs.readFileSync('background/panel-bridge.js', 'utf8');
  const globalScope = {};

  const api = new Function('self', `${source}; return self.MultiPageBackgroundPanelBridge;`)(globalScope);

  assert.equal(typeof api?.createPanelBridge, 'function');
});

test('panel bridge requests oauth url with step 7 log label payload', () => {
  const source = fs.readFileSync('background/panel-bridge.js', 'utf8');
  assert.match(source, /logStep:\s*7/);
  assert.doesNotMatch(source, /logStep:\s*6/);
});

test('panel bridge can request codex2api oauth url via protocol', async () => {
  const source = fs.readFileSync('background/panel-bridge.js', 'utf8');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
      assert.equal(url, 'http://localhost:8080/api/admin/oauth/generate-auth-url');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['X-Admin-Key'], 'admin-secret');
      return {
        ok: true,
        json: async () => ({
          auth_url: 'https://auth.openai.com/authorize?state=oauth-state',
          session_id: 'session-123',
        }),
      };
  };

  try {
    const api = new Function('self', `${source}; return self.MultiPageBackgroundPanelBridge;`)({});
    const bridge = api.createPanelBridge({
      addLog: async () => {},
      chrome: {},
      closeConflictingTabsForSource: async () => {},
      ensureContentScriptReadyOnTab: async () => {},
      getPanelMode: () => 'codex2api',
      normalizeCodex2ApiUrl: (value) => value ? `http://${value.replace(/^https?:\/\//, '')}`.replace(/\/admin$/, '/admin/accounts') : 'http://localhost:8080/admin/accounts',
      normalizeSub2ApiUrl: (value) => value,
      rememberSourceLastUrl: async () => {},
      sendToContentScript: async () => ({}),
      sendToContentScriptResilient: async () => ({}),
      waitForTabUrlFamily: async () => null,
      DEFAULT_SUB2API_GROUP_NAME: 'codex',
      SUB2API_STEP1_RESPONSE_TIMEOUT_MS: 90000,
    });

    const result = await bridge.requestOAuthUrlFromPanel({
      panelMode: 'codex2api',
      codex2apiUrl: 'localhost:8080/admin',
      codex2apiAdminKey: 'admin-secret',
    }, { logLabel: '步骤 7' });

    assert.deepStrictEqual(result, {
      oauthUrl: 'https://auth.openai.com/authorize?state=oauth-state',
      codex2apiSessionId: 'session-123',
      codex2apiOAuthState: 'oauth-state',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('panel bridge can request cpa oauth url via management api', async () => {
  const source = fs.readFileSync('background/panel-bridge.js', 'utf8');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(url, 'http://localhost:8317/v0/management/codex-auth-url');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer cpa-key');
    assert.equal(options.headers['X-Management-Key'], 'cpa-key');
    return {
      ok: true,
      json: async () => ({
        status: 'ok',
        url: 'https://auth.openai.com/authorize?state=cpa-oauth-state',
        state: 'cpa-oauth-state',
      }),
    };
  };

  try {
    const api = new Function('self', `${source}; return self.MultiPageBackgroundPanelBridge;`)({});
    const bridge = api.createPanelBridge({
      addLog: async () => {},
      getPanelMode: () => 'cpa',
      normalizeCodex2ApiUrl: (value) => value,
      normalizeSub2ApiUrl: (value) => value,
      DEFAULT_SUB2API_GROUP_NAME: 'codex',
      SUB2API_STEP1_RESPONSE_TIMEOUT_MS: 90000,
    });

    const result = await bridge.requestOAuthUrlFromPanel({
      panelMode: 'cpa',
      vpsUrl: 'http://localhost:8317/admin/oauth',
      vpsPassword: 'cpa-key',
    }, { logLabel: '步骤 7' });

    assert.deepStrictEqual(result, {
      oauthUrl: 'https://auth.openai.com/authorize?state=cpa-oauth-state',
      cpaOAuthState: 'cpa-oauth-state',
      cpaManagementOrigin: 'http://localhost:8317',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('panel bridge rejects cpa oauth url without state', async () => {
  const source = fs.readFileSync('background/panel-bridge.js', 'utf8');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      status: 'ok',
      url: 'https://auth.openai.com/authorize',
    }),
  });

  try {
    const api = new Function('self', `${source}; return self.MultiPageBackgroundPanelBridge;`)({});
    const bridge = api.createPanelBridge({
      addLog: async () => {},
      getPanelMode: () => 'cpa',
      normalizeCodex2ApiUrl: (value) => value,
      normalizeSub2ApiUrl: (value) => value,
      DEFAULT_SUB2API_GROUP_NAME: 'codex',
      SUB2API_STEP1_RESPONSE_TIMEOUT_MS: 90000,
    });

    await assert.rejects(
      () => bridge.requestOAuthUrlFromPanel({
        panelMode: 'cpa',
        vpsUrl: 'http://localhost:8317/admin/oauth',
        vpsPassword: 'cpa-key',
      }, { logLabel: '步骤 7' }),
      /OAuth 授权链接缺少 state/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('panel bridge forwards SUB2API account priority when requesting oauth url', async () => {
  const source = fs.readFileSync('background/panel-bridge.js', 'utf8');
  const sentMessages = [];

  const api = new Function('self', `${source}; return self.MultiPageBackgroundPanelBridge;`)({});
  const bridge = api.createPanelBridge({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => ({ id: 72 }),
      },
    },
    closeConflictingTabsForSource: async () => {},
    ensureContentScriptReadyOnTab: async () => {},
    getPanelMode: () => 'sub2api',
    normalizeCodex2ApiUrl: (value) => value,
    normalizeSub2ApiUrl: (value) => value,
    rememberSourceLastUrl: async () => {},
    sendToContentScript: async (sourceName, message, options) => {
      sentMessages.push({ sourceName, message, options });
      return {
        oauthUrl: 'https://auth.openai.com/authorize?state=oauth-state',
        sub2apiSessionId: 'session-123',
        sub2apiOAuthState: 'oauth-state',
      };
    },
    sendToContentScriptResilient: async () => ({}),
    waitForTabUrlFamily: async () => ({ id: 72 }),
    DEFAULT_SUB2API_GROUP_NAME: 'codex',
    SUB2API_STEP1_RESPONSE_TIMEOUT_MS: 90000,
  });

  await bridge.requestOAuthUrlFromPanel({
    panelMode: 'sub2api',
    sub2apiUrl: 'https://sub.example/admin/accounts',
    sub2apiEmail: 'admin@example.com',
    sub2apiPassword: 'secret',
    sub2apiGroupName: 'codex',
    sub2apiAccountPriority: 3,
  }, { logLabel: '步骤 7' });

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].sourceName, 'sub2api-panel');
  assert.equal(sentMessages[0].message.payload.sub2apiAccountPriority, 3);
});
