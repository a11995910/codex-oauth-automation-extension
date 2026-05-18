(function attachBuiltinCodexAuth(root, factory) {
  root.MultiPageBuiltinCodexAuth = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function createBuiltinCodexAuthModule(root) {
  const CODEX_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
  const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
  const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
  const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
  const CODEX_SCOPE = 'openid email profile offline_access';
  const CODEX_DOWNLOAD_DIR = 'Codex-OAuth-JSON';
  const WEB_ACCESS_TOKEN_DOWNLOAD_DIR = 'ChatGPT-Web-Access-Tokens';

  function createBuiltinCodexAuth(deps = {}) {
    const {
      chrome,
      crypto: injectedCrypto,
      fetch: injectedFetch,
      now = () => new Date(),
    } = deps;

    function getCrypto() {
      const cryptoLike = injectedCrypto || root.crypto;
      if (!cryptoLike?.getRandomValues || !cryptoLike?.subtle?.digest) {
        throw new Error('当前环境不支持 Web Crypto，无法生成 Codex OAuth PKCE。');
      }
      return cryptoLike;
    }

    function getFetch() {
      const fetchLike = injectedFetch || root.fetch;
      if (typeof fetchLike !== 'function') {
        throw new Error('当前环境不支持 fetch，无法交换 Codex OAuth token。');
      }
      return fetchLike.bind(root);
    }

    function bytesToBase64Url(bytes) {
      let binary = '';
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode(...chunk);
      }
      return root.btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    }

    function base64UrlToBytes(value = '') {
      const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      const binary = root.atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    }

    function bytesToHex(bytes) {
      return Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    }

    function randomBytes(length) {
      const bytes = new Uint8Array(length);
      getCrypto().getRandomValues(bytes);
      return bytes;
    }

    async function sha256Bytes(input) {
      const encoded = new TextEncoder().encode(String(input || ''));
      const digest = await getCrypto().subtle.digest('SHA-256', encoded);
      return new Uint8Array(digest);
    }

    async function generatePkceCodes() {
      const codeVerifier = bytesToBase64Url(randomBytes(96));
      const codeChallenge = bytesToBase64Url(await sha256Bytes(codeVerifier));
      return {
        codeVerifier,
        codeChallenge,
      };
    }

    function generateState() {
      return bytesToHex(randomBytes(16));
    }

    function buildCodexAuthUrl(state, codeChallenge) {
      const normalizedState = String(state || '').trim();
      const normalizedChallenge = String(codeChallenge || '').trim();
      if (!normalizedState) {
        throw new Error('缺少 Codex OAuth state，无法生成授权链接。');
      }
      if (!normalizedChallenge) {
        throw new Error('缺少 Codex OAuth code_challenge，无法生成授权链接。');
      }

      const params = new URLSearchParams({
        client_id: CODEX_CLIENT_ID,
        response_type: 'code',
        redirect_uri: CODEX_REDIRECT_URI,
        scope: CODEX_SCOPE,
        state: normalizedState,
        code_challenge: normalizedChallenge,
        code_challenge_method: 'S256',
        prompt: 'login',
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
      });
      return `${CODEX_AUTH_URL}?${params.toString()}`;
    }

    async function createOAuthSession() {
      const state = generateState();
      const pkceCodes = await generatePkceCodes();
      return {
        oauthUrl: buildCodexAuthUrl(state, pkceCodes.codeChallenge),
        state,
        codeVerifier: pkceCodes.codeVerifier,
        codeChallenge: pkceCodes.codeChallenge,
      };
    }

    function parseJwtPayload(idToken = '') {
      const parts = String(idToken || '').split('.');
      if (parts.length !== 3) {
        throw new Error('Codex id_token 不是有效的 JWT 格式。');
      }
      const payloadBytes = base64UrlToBytes(parts[1]);
      return JSON.parse(new TextDecoder().decode(payloadBytes));
    }

    function getCodexAuthInfo(claims = {}) {
      const nested = claims?.['https://api.openai.com/auth'] || {};
      return {
        email: String(claims?.email || '').trim(),
        accountId: String(
          nested?.chatgpt_account_id
          || claims?.['https://api.openai.com/auth.chatgpt_account_id']
          || ''
        ).trim(),
        planType: String(
          nested?.chatgpt_plan_type
          || claims?.['https://api.openai.com/auth.chatgpt_plan_type']
          || ''
        ).trim(),
      };
    }

    async function exchangeCodeForTokens(code, codeVerifier, options = {}) {
      const normalizedCode = String(code || '').trim();
      const normalizedVerifier = String(codeVerifier || '').trim();
      if (!normalizedCode) {
        throw new Error('缺少 Codex OAuth code，无法交换 token。');
      }
      if (!normalizedVerifier) {
        throw new Error('缺少 Codex OAuth code_verifier，请重新执行 OAuth 登录步骤。');
      }

      const redirectUri = String(options.redirectUri || CODEX_REDIRECT_URI).trim() || CODEX_REDIRECT_URI;
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CODEX_CLIENT_ID,
        code: normalizedCode,
        redirect_uri: redirectUri,
        code_verifier: normalizedVerifier,
      });

      const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || 30000));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      let responseText = '';
      try {
        response = await getFetch()(CODEX_TOKEN_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
          signal: controller.signal,
        });
        responseText = await response.text();
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error('Codex OAuth token 交换请求超时，请稍后重试。');
        }
        throw new Error(`Codex OAuth token 交换请求失败：${error?.message || error}`);
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new Error(`Codex OAuth token 交换失败（HTTP ${response.status}）：${responseText}`);
      }

      try {
        return JSON.parse(responseText || '{}');
      } catch {
        throw new Error('Codex OAuth token 响应不是有效 JSON。');
      }
    }

    function normalizePlanTypeForFilename(planType = '') {
      const parts = String(planType || '')
        .trim()
        .split(/[^\p{L}\p{N}]+/u)
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
      return parts.join('-');
    }

    function buildCredentialFileName(email, planType = '', hashAccountId = '', includeProviderPrefix = true) {
      const normalizedEmail = String(email || '').trim();
      const normalizedPlan = normalizePlanTypeForFilename(planType);
      const prefix = includeProviderPrefix ? 'codex' : '';
      if (!normalizedPlan) {
        return `${prefix}-${normalizedEmail}.json`;
      }
      if (normalizedPlan === 'team') {
        return `${prefix}-${String(hashAccountId || '').trim()}-${normalizedEmail}-${normalizedPlan}.json`;
      }
      return `${prefix}-${normalizedEmail}-${normalizedPlan}.json`;
    }

    async function buildCodexAuthJson(tokenResponse) {
      const idToken = String(tokenResponse?.id_token || '').trim();
      const accessToken = String(tokenResponse?.access_token || '').trim();
      const refreshToken = String(tokenResponse?.refresh_token || '').trim();
      if (!idToken || !accessToken || !refreshToken) {
        throw new Error('Codex token 响应缺少 id_token、access_token 或 refresh_token。');
      }

      const claims = parseJwtPayload(idToken);
      const authInfo = getCodexAuthInfo(claims);
      const currentTime = now();
      const expiresInSeconds = Math.max(0, Number(tokenResponse?.expires_in) || 0);
      const expiredAt = new Date(currentTime.getTime() + expiresInSeconds * 1000);
      const accountHash = authInfo.accountId
        ? bytesToHex(await sha256Bytes(authInfo.accountId)).slice(0, 8)
        : '';
      const fileName = buildCredentialFileName(authInfo.email, authInfo.planType, accountHash, true);
      const authJson = {
        id_token: idToken,
        access_token: accessToken,
        refresh_token: refreshToken,
        account_id: authInfo.accountId,
        last_refresh: currentTime.toISOString(),
        email: authInfo.email,
        type: 'codex',
        expired: expiredAt.toISOString(),
      };

      return {
        fileName,
        authJson,
        authInfo,
      };
    }

    function normalizeDownloadFileName(fileName = '') {
      return String(fileName || '')
        .trim()
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/^\.+/g, '')
        || 'codex-auth.json';
    }

    function buildDownloadPath(fileName = '') {
      return `${CODEX_DOWNLOAD_DIR}/${normalizeDownloadFileName(fileName)}`;
    }

    function padDatePart(value) {
      return String(value).padStart(2, '0');
    }

    function formatBatchTimestamp(date = now()) {
      const current = date instanceof Date && !Number.isNaN(date.getTime())
        ? date
        : new Date();
      return [
        current.getFullYear(),
        padDatePart(current.getMonth() + 1),
        padDatePart(current.getDate()),
        '-',
        padDatePart(current.getHours()),
        padDatePart(current.getMinutes()),
        padDatePart(current.getSeconds()),
      ].join('');
    }

    function buildWebAccessTokenBatchFileName(options = {}) {
      const batchLabel = String(options.batchLabel || '').trim();
      const timestamp = formatBatchTimestamp(options.date instanceof Date ? options.date : now());
      const normalizedLabel = batchLabel
        ? batchLabel.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '')
        : '';
      const suffix = normalizedLabel
        ? `-${normalizedLabel}`
        : '';
      return `web-access-tokens-${timestamp}${suffix}.txt`;
    }

    function buildWebAccessTokenDownloadPath(fileName = '') {
      const normalizedFileName = normalizeDownloadFileName(fileName || buildWebAccessTokenBatchFileName());
      return `${WEB_ACCESS_TOKEN_DOWNLOAD_DIR}/${normalizedFileName}`;
    }

    async function downloadAuthJson(fileName, authJson) {
      const normalizedFileName = normalizeDownloadFileName(fileName);
      const downloadPath = buildDownloadPath(normalizedFileName);
      const content = `${JSON.stringify(authJson, null, 2)}\n`;
      const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(content)}`;
      if (chrome?.downloads?.download) {
        return chrome.downloads.download({
          url: dataUrl,
          filename: downloadPath,
          saveAs: false,
          conflictAction: 'uniquify',
        });
      }

      if (chrome?.runtime?.sendMessage) {
        await chrome.runtime.sendMessage({
          type: 'BUILTIN_CODEX_AUTH_JSON_READY',
          source: 'background',
          payload: {
            fileName: downloadPath,
            fileContent: content,
          },
        });
        return null;
      }

      throw new Error('当前环境不支持自动下载 Codex OAuth JSON。');
    }

    async function downloadWebAccessTokens(tokens = [], options = {}) {
      const lines = Array.isArray(tokens)
        ? tokens.map((token) => String(token || '').trim()).filter(Boolean)
        : [];
      if (!lines.length) {
        throw new Error('网页 access token 下载内容为空。');
      }

      const fileName = String(options.fileName || '').trim()
        ? normalizeDownloadFileName(options.fileName)
        : buildWebAccessTokenBatchFileName(options);
      const downloadPath = buildWebAccessTokenDownloadPath(fileName);
      const content = `${lines.join('\n')}\n`;
      const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`;
      const conflictAction = ['overwrite', 'prompt', 'uniquify'].includes(options.conflictAction)
        ? options.conflictAction
        : 'overwrite';
      if (chrome?.downloads?.download) {
        return chrome.downloads.download({
          url: dataUrl,
          filename: downloadPath,
          saveAs: false,
          conflictAction,
        });
      }

      if (chrome?.runtime?.sendMessage) {
        await chrome.runtime.sendMessage({
          type: 'WEB_ACCESS_TOKENS_READY',
          source: 'background',
          payload: {
            fileName: downloadPath,
            fileContent: content,
          },
        });
        return null;
      }

      throw new Error('当前环境不支持自动下载网页 access token。');
    }

    return {
      CODEX_AUTH_URL,
      CODEX_CLIENT_ID,
      CODEX_DOWNLOAD_DIR,
      CODEX_REDIRECT_URI,
      CODEX_SCOPE,
      CODEX_TOKEN_URL,
      WEB_ACCESS_TOKEN_DOWNLOAD_DIR,
      buildCodexAuthJson,
      buildCodexAuthUrl,
      buildCredentialFileName,
      buildWebAccessTokenBatchFileName,
      buildWebAccessTokenDownloadPath,
      createOAuthSession,
      downloadAuthJson,
      downloadWebAccessTokens,
      exchangeCodeForTokens,
      generatePkceCodes,
      generateState,
      getCodexAuthInfo,
      buildDownloadPath,
      normalizePlanTypeForFilename,
      parseJwtPayload,
    };
  }

  return {
    createBuiltinCodexAuth,
  };
});
