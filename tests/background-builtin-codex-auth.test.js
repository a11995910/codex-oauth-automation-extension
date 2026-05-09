const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { webcrypto } = require('node:crypto');

function loadBuiltinCodexAuth(overrides = {}) {
  const source = fs.readFileSync('background/builtin-codex-auth.js', 'utf8');
  const root = {
    ...globalThis,
    crypto: webcrypto,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    ...overrides,
  };
  const api = new Function('self', `${source}; return self.MultiPageBuiltinCodexAuth;`)(root);
  return api.createBuiltinCodexAuth({ crypto: webcrypto, ...overrides });
}

function createJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value))
    .toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

test('builtin codex auth builds official OAuth url with PKCE parameters', async () => {
  const auth = loadBuiltinCodexAuth();
  const session = await auth.createOAuthSession();
  const parsed = new URL(session.oauthUrl);

  assert.equal(parsed.origin + parsed.pathname, 'https://auth.openai.com/oauth/authorize');
  assert.equal(parsed.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.equal(parsed.searchParams.get('scope'), 'openid email profile offline_access');
  assert.equal(parsed.searchParams.get('state'), session.state);
  assert.equal(parsed.searchParams.get('code_challenge'), session.codeChallenge);
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('prompt'), 'login');
  assert.equal(parsed.searchParams.get('id_token_add_organizations'), 'true');
  assert.equal(parsed.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.match(session.state, /^[a-f0-9]{32}$/);
  assert.equal(session.codeVerifier.length, 128);
});

test('builtin codex auth exchanges code with verifier using form body', async () => {
  let captured = null;
  const auth = loadBuiltinCodexAuth({
    fetch: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id_token: 'id-token',
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        }),
      };
    },
  });

  const result = await auth.exchangeCodeForTokens('callback-code', 'verifier-123');
  const body = new URLSearchParams(captured.options.body);

  assert.equal(captured.url, 'https://auth.openai.com/oauth/token');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.Accept, 'application/json');
  assert.equal(captured.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(body.get('code'), 'callback-code');
  assert.equal(body.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.equal(body.get('code_verifier'), 'verifier-123');
  assert.equal(result.refresh_token, 'refresh-token');
});

test('builtin codex auth builds CLIProxyAPI compatible auth json and filename', async () => {
  const idToken = createJwt({
    email: 'flow@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'account-123',
      chatgpt_plan_type: 'Team',
    },
  });
  const auth = loadBuiltinCodexAuth({
    now: () => new Date('2026-05-09T00:00:00.000Z'),
  });

  const result = await auth.buildCodexAuthJson({
    id_token: idToken,
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
  });

  assert.equal(result.fileName, 'codex-725a2fd1-flow@example.com-team.json');
  assert.deepStrictEqual(result.authJson, {
    id_token: idToken,
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    account_id: 'account-123',
    last_refresh: '2026-05-09T00:00:00.000Z',
    email: 'flow@example.com',
    type: 'codex',
    expired: '2026-05-09T01:00:00.000Z',
  });
});

test('builtin codex auth downloads json into a fixed Downloads subfolder', async () => {
  const downloadCalls = [];
  const auth = loadBuiltinCodexAuth({
    chrome: {
      downloads: {
        download: async (payload) => {
          downloadCalls.push(payload);
          return 42;
        },
      },
    },
  });

  const downloadId = await auth.downloadAuthJson('codex-flow@example.com-plus.json', {
    email: 'flow@example.com',
    type: 'codex',
  });

  assert.equal(downloadId, 42);
  assert.equal(downloadCalls.length, 1);
  assert.equal(downloadCalls[0].filename, 'Codex-OAuth-JSON/codex-flow@example.com-plus.json');
  assert.equal(downloadCalls[0].saveAs, false);
  assert.equal(downloadCalls[0].conflictAction, 'uniquify');
});

test('background imports builtin codex auth before panel bridge', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /'background\/builtin-codex-auth\.js',\s*'background\/panel-bridge\.js'/);
});
