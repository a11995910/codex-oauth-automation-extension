(function attachBackgroundPanelBridge(root, factory) {
  root.MultiPageBackgroundPanelBridge = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundPanelBridgeModule() {
  function createPanelBridge(deps = {}) {
    const {
      chrome,
      addLog,
      builtinCodexAuth,
      closeConflictingTabsForSource,
      ensureContentScriptReadyOnTab,
      getPanelMode,
      normalizeManagerUrl,
      normalizeCodex2ApiUrl,
      normalizeSub2ApiUrl,
      rememberSourceLastUrl,
      sendToContentScript,
      sendToContentScriptResilient,
      waitForTabUrlFamily,
      DEFAULT_SUB2API_GROUP_NAME,
      SUB2API_STEP1_RESPONSE_TIMEOUT_MS,
    } = deps;

    function normalizeAdminKey(value = '') {
      return String(value || '').trim();
    }

    function extractStateFromAuthUrl(authUrl = '') {
      try {
        return new URL(authUrl).searchParams.get('state') || '';
      } catch {
        return '';
      }
    }

    function getCodex2ApiErrorMessage(payload, responseStatus = 500) {
      const candidates = [
        payload?.error,
        payload?.message,
        payload?.detail,
        payload?.reason,
      ];
      const message = candidates
        .map((value) => String(value || '').trim())
        .find(Boolean);
      return message || `Codex2API 请求失败（HTTP ${responseStatus}）。`;
    }

    function getManagerRpcErrorMessage(payload, responseStatus = 500) {
      const candidates = [
        payload?.error?.message,
        payload?.error,
        payload?.message,
        payload?.detail,
        payload?.reason,
        payload?.result?.error,
      ];
      const message = candidates
        .map((value) => String(value || '').trim())
        .find(Boolean);
      return message || `Manager RPC 请求失败（HTTP ${responseStatus}）。`;
    }

    function isFetchTransportError(error) {
      const message = String(typeof error === 'string' ? error : error?.message || '').trim();
      if (!message) {
        return false;
      }
      return /failed to fetch|networkerror|network error|fetch failed|load failed|net::err_|connection refused|econnrefused|econnreset|timeout|timed out/i.test(message);
    }

    function createFetchTransportError(label, targetUrl, error) {
      const reason = String(error?.message || error || '未知网络错误').trim();
      return new Error(`${label}网络请求失败：${targetUrl}；原因：${reason}。请确认服务地址可访问、端口正确、证书有效，且浏览器代理或系统网络允许访问该地址。`);
    }

    function unwrapJsonRpcPayload(payload) {
      if (payload?.error) {
        throw new Error(getManagerRpcErrorMessage(payload, 200));
      }
      const result = payload?.result;
      if (result && typeof result === 'object' && result.ok === false) {
        throw new Error(String(result.error || result.message || 'Manager RPC 返回失败').trim());
      }
      return result;
    }

    function deriveCpaManagementOrigin(vpsUrl) {
      const normalizedUrl = String(vpsUrl || '').trim();
      if (!normalizedUrl) {
        throw new Error('尚未配置 CPA 地址，请先在侧边栏填写。');
      }
      let parsed;
      try {
        parsed = new URL(normalizedUrl);
      } catch {
        throw new Error('CPA 地址格式无效，请先在侧边栏检查。');
      }
      return parsed.origin;
    }

    function getCpaApiErrorMessage(payload, responseStatus = 500) {
      const candidates = [
        payload?.error,
        payload?.message,
        payload?.detail,
        payload?.reason,
      ];
      const message = candidates
        .map((value) => String(value || '').trim())
        .find(Boolean);
      return message || `CPA 管理接口请求失败（HTTP ${responseStatus}）。`;
    }

    async function fetchCpaManagementJson(origin, path, options = {}) {
      const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || 20000));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const managementKey = String(options.managementKey || '').trim();
        const headers = {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        };
        if (managementKey) {
          headers.Authorization = `Bearer ${managementKey}`;
          headers['X-Management-Key'] = managementKey;
        }

        const requestUrl = `${origin}${path}`;
        const response = await fetch(requestUrl, {
          method: options.method || 'POST',
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });

        let payload = {};
        try {
          payload = await response.json();
        } catch {
          payload = {};
        }

        if (!response.ok) {
          throw new Error(getCpaApiErrorMessage(payload, response.status));
        }

        return payload;
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error('CPA 管理接口请求超时，请稍后重试。');
        }
        if (isFetchTransportError(error)) {
          throw createFetchTransportError('CPA 管理接口', `${origin}${path}`, error);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    async function fetchManagerRpc(state, method, params = {}, options = {}) {
      const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || 30000));
      const managerUrl = normalizeManagerUrl(state.managerUrl);
      const rpcToken = String(state.managerRpcToken || '').trim();
      if (!rpcToken) {
        throw new Error('尚未配置 Manager RPC Token，请先在侧边栏填写。');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(managerUrl, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-CodexManager-Rpc-Token': rpcToken,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method,
            params,
          }),
          signal: controller.signal,
        });

        let payload = {};
        try {
          payload = await response.json();
        } catch {
          payload = {};
        }

        if (!response.ok) {
          throw new Error(getManagerRpcErrorMessage(payload, response.status));
        }
        return unwrapJsonRpcPayload(payload);
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error('Manager RPC 请求超时，请检查 Manager 服务是否运行。');
        }
        if (isFetchTransportError(error)) {
          throw createFetchTransportError('Manager RPC', managerUrl, error);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    async function fetchCodex2ApiJson(origin, path, options = {}) {
      const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || 30000));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const requestUrl = `${origin}${path}`;
        const response = await fetch(requestUrl, {
          method: options.method || 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Admin-Key': normalizeAdminKey(options.adminKey),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });

        let payload = {};
        try {
          payload = await response.json();
        } catch {
          payload = {};
        }

        if (!response.ok) {
          throw new Error(getCodex2ApiErrorMessage(payload, response.status));
        }

        return payload;
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error('Codex2API 请求超时，请稍后重试。');
        }
        if (isFetchTransportError(error)) {
          throw createFetchTransportError('Codex2API', `${origin}${path}`, error);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    async function requestOAuthUrlFromPanel(state, options = {}) {
      if (getPanelMode(state) === 'builtin-codex') {
        return requestBuiltinCodexOAuthUrl(state, options);
      }
      if (getPanelMode(state) === 'codex2api') {
        return requestCodex2ApiOAuthUrl(state, options);
      }
      if (getPanelMode(state) === 'manager') {
        return requestManagerOAuthUrl(state, options);
      }
      if (getPanelMode(state) === 'sub2api') {
        return requestSub2ApiOAuthUrl(state, options);
      }
      return requestCpaOAuthUrl(state, options);
    }

    async function requestBuiltinCodexOAuthUrl(_state, options = {}) {
      const { logLabel = 'OAuth 刷新' } = options;
      if (!builtinCodexAuth?.createOAuthSession) {
        throw new Error('内置 Codex OAuth 生成器未加载，请重新加载扩展后重试。');
      }

      await addLog(`${logLabel}：正在由扩展内置生成 Codex OAuth 授权链接...`);
      const session = await builtinCodexAuth.createOAuthSession();
      return {
        oauthUrl: session.oauthUrl,
        builtinCodexOAuthState: session.state,
        builtinCodexCodeVerifier: session.codeVerifier,
        builtinCodexCodeChallenge: session.codeChallenge,
      };
    }

    async function requestCpaOAuthUrl(state, options = {}) {
      const { logLabel = 'OAuth 刷新' } = options;
      if (!state.vpsUrl) {
        throw new Error('尚未配置 CPA 地址，请先在侧边栏填写。');
      }
      const managementKey = String(state.vpsPassword || '').trim();
      if (!managementKey) {
        throw new Error('尚未配置 CPA 管理密钥，请先在侧边栏填写。');
      }

      const origin = deriveCpaManagementOrigin(state.vpsUrl);

      await addLog(`${logLabel}：正在通过 CPA 管理接口获取 OAuth 授权链接...`);
      let result;
      try {
        result = await fetchCpaManagementJson(origin, '/v0/management/codex-auth-url', {
          method: 'GET',
          managementKey,
        });
      } catch (error) {
        if (!isFetchTransportError(error)) {
          throw error;
        }
        return requestCpaOAuthUrlViaPanelPage(state, {
          logLabel,
          origin,
          directError: error,
        });
      }

      const oauthUrl = String(
        result?.url
        || result?.auth_url
        || result?.authUrl
        || result?.data?.url
        || result?.data?.auth_url
        || result?.data?.authUrl
        || ''
      ).trim();
      const oauthState = String(
        result?.state
        || result?.auth_state
        || result?.authState
        || result?.data?.state
        || result?.data?.auth_state
        || result?.data?.authState
        || ''
      ).trim()
        || extractStateFromAuthUrl(oauthUrl);

      if (!oauthUrl || !oauthUrl.startsWith('http')) {
        throw new Error('CPA 管理接口未返回有效的 auth_url。');
      }
      if (!oauthState) {
        throw new Error('CPA 管理接口返回的 OAuth 授权链接缺少 state，无法安全校验回调。');
      }

      return {
        oauthUrl,
        cpaOAuthState: oauthState,
        cpaManagementOrigin: origin,
      };
    }

    async function requestCpaOAuthUrlViaPanelPage(state, options = {}) {
      const {
        logLabel = 'OAuth 刷新',
        origin = '',
        directError = null,
      } = options;
      const vpsUrl = String(state.vpsUrl || '').trim();
      if (!vpsUrl) {
        throw directError || new Error('尚未配置 CPA 地址，请先在侧边栏填写。');
      }
      if (!chrome?.tabs?.create || typeof sendToContentScript !== 'function') {
        throw directError || new Error('CPA 管理接口不可用，且当前运行环境不支持打开 CPA 面板兜底获取 OAuth 链接。');
      }

      await addLog(
        `${logLabel}：CPA 管理接口直连失败，改用打开 CPA 面板页面点击 OAuth 登录兜底。原因：${directError?.message || '未知错误'}`,
        'warn'
      );

      const injectFiles = ['content/utils.js', 'content/vps-panel.js'];
      if (typeof closeConflictingTabsForSource === 'function') {
        await closeConflictingTabsForSource('vps-panel', vpsUrl);
      }

      const tab = await chrome.tabs.create({ url: vpsUrl, active: true });
      const tabId = tab.id;
      if (typeof rememberSourceLastUrl === 'function') {
        await rememberSourceLastUrl('vps-panel', vpsUrl);
      }

      await addLog(`${logLabel}：CPA 面板已打开，正在等待页面加载...`);
      if (typeof waitForTabUrlFamily === 'function') {
        const matchedTab = await waitForTabUrlFamily('vps-panel', tabId, vpsUrl, {
          timeoutMs: 15000,
          retryDelayMs: 400,
        });
        if (!matchedTab) {
          await addLog(`${logLabel}：CPA 面板地址尚未稳定，继续尝试连接内容脚本...`, 'warn');
        }
      }

      if (typeof ensureContentScriptReadyOnTab === 'function') {
        await ensureContentScriptReadyOnTab('vps-panel', tabId, {
          inject: injectFiles,
          injectSource: 'vps-panel',
          timeoutMs: 45000,
          retryDelayMs: 900,
          logMessage: `${logLabel}：CPA 面板仍在加载，正在重试连接内容脚本...`,
        });
      }

      const result = await sendToContentScript('vps-panel', {
        type: 'REQUEST_OAUTH_URL',
        source: 'background',
        payload: {
          vpsPassword: state.vpsPassword,
          logStep: 7,
        },
      }, {
        responseTimeoutMs: 90000,
      });

      if (result?.error) {
        throw new Error(result.error);
      }

      const oauthUrl = String(result?.oauthUrl || '').trim();
      const oauthState = extractStateFromAuthUrl(oauthUrl);
      if (!oauthUrl || !oauthUrl.startsWith('http')) {
        throw new Error('CPA 面板兜底流程未返回有效的 OAuth 授权链接。');
      }
      if (!oauthState) {
        throw new Error('CPA 面板兜底流程返回的 OAuth 授权链接缺少 state，无法安全校验回调。');
      }

      return {
        oauthUrl,
        cpaOAuthState: oauthState,
        cpaManagementOrigin: origin || deriveCpaManagementOrigin(vpsUrl),
      };
    }

    async function requestManagerOAuthUrl(state, options = {}) {
      const { logLabel = 'OAuth 刷新' } = options;
      await addLog(`${logLabel}：正在通过 Manager RPC 生成 OAuth 授权链接...`);

      const result = await fetchManagerRpc(state, 'account/login/start', {
        type: 'chatgpt',
        openBrowser: false,
        tags: String(state.managerTags || '').trim() || null,
        note: String(state.managerNote || '').trim() || null,
      }, {
        timeoutMs: 30000,
      });

      const oauthUrl = String(result?.authUrl || result?.auth_url || '').trim();
      const loginId = String(result?.loginId || result?.login_id || '').trim();
      const oauthState = loginId || extractStateFromAuthUrl(oauthUrl);
      if (!oauthUrl || !oauthUrl.startsWith('http')) {
        throw new Error('Manager RPC 未返回有效的 auth_url。');
      }
      if (!oauthState) {
        throw new Error('Manager RPC 返回的 OAuth 授权链接缺少 state，无法安全校验回调。');
      }

      return {
        oauthUrl,
        managerLoginId: loginId || oauthState,
        managerOAuthState: oauthState,
      };
    }

    async function requestCodex2ApiOAuthUrl(state, options = {}) {
      const { logLabel = 'OAuth 刷新' } = options;
      const codex2apiUrl = normalizeCodex2ApiUrl(state.codex2apiUrl);
      const adminKey = normalizeAdminKey(state.codex2apiAdminKey);

      if (!adminKey) {
        throw new Error('尚未配置 Codex2API 管理密钥，请先在侧边栏填写。');
      }

      const origin = new URL(codex2apiUrl).origin;
      await addLog(`${logLabel}：正在通过 Codex2API 协议生成 OAuth 授权链接...`);

      const result = await fetchCodex2ApiJson(origin, '/api/admin/oauth/generate-auth-url', {
        adminKey,
        method: 'POST',
        body: {},
      });

      const oauthUrl = String(result?.auth_url || result?.authUrl || '').trim();
      const sessionId = String(result?.session_id || result?.sessionId || '').trim();
      const oauthState = extractStateFromAuthUrl(oauthUrl);

      if (!oauthUrl || !sessionId) {
        throw new Error('Codex2API 未返回有效的 auth_url 或 session_id。');
      }

      return {
        oauthUrl,
        codex2apiSessionId: sessionId,
        codex2apiOAuthState: oauthState || null,
      };
    }

    async function requestSub2ApiOAuthUrl(state, options = {}) {
      const { logLabel = 'OAuth 刷新' } = options;
      const sub2apiUrl = normalizeSub2ApiUrl(state.sub2apiUrl);
      const groupName = (state.sub2apiGroupName || DEFAULT_SUB2API_GROUP_NAME).trim() || DEFAULT_SUB2API_GROUP_NAME;

      if (!sub2apiUrl) {
        throw new Error('SUB2API URL is not configured. Please fill it in the side panel first.');
      }
      if (!state.sub2apiEmail) {
        throw new Error('尚未配置 SUB2API 登录邮箱，请先在侧边栏填写。');
      }
      if (!state.sub2apiPassword) {
        throw new Error('尚未配置 SUB2API 登录密码，请先在侧边栏填写。');
      }

      await addLog(`${logLabel}：正在打开 SUB2API 后台...`);

      const injectFiles = ['content/utils.js', 'content/sub2api-panel.js'];
      await closeConflictingTabsForSource('sub2api-panel', sub2apiUrl);

      const tab = await chrome.tabs.create({ url: sub2apiUrl, active: true });
      const tabId = tab.id;
      await rememberSourceLastUrl('sub2api-panel', sub2apiUrl);

      await addLog(`${logLabel}：SUB2API 页面已打开，正在等待页面进入目标地址...`);
      const matchedTab = await waitForTabUrlFamily('sub2api-panel', tabId, sub2apiUrl, {
        timeoutMs: 15000,
        retryDelayMs: 400,
      });
      if (!matchedTab) {
        await addLog(`${logLabel}：SUB2API 页面尚未稳定，继续尝试连接内容脚本...`, 'warn');
      }

      await ensureContentScriptReadyOnTab('sub2api-panel', tabId, {
        inject: injectFiles,
        injectSource: 'sub2api-panel',
        timeoutMs: 45000,
        retryDelayMs: 900,
        logMessage: `${logLabel}：SUB2API 页面仍在加载，正在重试连接内容脚本...`,
      });

      const result = await sendToContentScript('sub2api-panel', {
        type: 'REQUEST_OAUTH_URL',
        source: 'background',
        payload: {
          sub2apiUrl,
          sub2apiEmail: state.sub2apiEmail,
          sub2apiPassword: state.sub2apiPassword,
          sub2apiGroupName: groupName,
          sub2apiDefaultProxyName: state.sub2apiDefaultProxyName,
          sub2apiAccountPriority: state.sub2apiAccountPriority,
          logStep: 7,
        },
      }, {
        responseTimeoutMs: SUB2API_STEP1_RESPONSE_TIMEOUT_MS,
      });

      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    return {
      requestOAuthUrlFromPanel,
      requestCodex2ApiOAuthUrl,
      requestCpaOAuthUrl,
      requestBuiltinCodexOAuthUrl,
      requestManagerOAuthUrl,
      requestSub2ApiOAuthUrl,
    };
  }

  return {
    createPanelBridge,
  };
});
