// background/contribution-oauth.js — 简化版不再接入外部贡献服务。
(function attachBackgroundContributionOAuth(root, factory) {
  root.MultiPageBackgroundContributionOAuth = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundContributionOAuthModule() {
  const RUNTIME_DEFAULTS = {
    contributionMode: false,
    contributionModeExpected: false,
    contributionSource: 'sub2api',
    contributionTargetGroupName: 'codex号池',
    contributionNickname: '',
    contributionQq: '',
    contributionSessionId: '',
    contributionAuthUrl: '',
    contributionAuthState: '',
    contributionCallbackUrl: '',
    contributionStatus: '',
    contributionStatusMessage: '',
    contributionLastPollAt: 0,
    contributionCallbackStatus: 'idle',
    contributionCallbackMessage: '',
    contributionAuthOpenedAt: 0,
    contributionAuthTabId: 0,
  };

  const RUNTIME_KEYS = Object.keys(RUNTIME_DEFAULTS);

  function createDisabledError() {
    return new Error('简化版已移除贡献模式，不再连接外部贡献服务。');
  }

  function createContributionOAuthManager() {
    return {
      RUNTIME_DEFAULTS,
      RUNTIME_KEYS,
      ensureCallbackListeners: () => {},
      isContributionFinalStatus: () => true,
      startContributionFlow: async () => { throw createDisabledError(); },
      pollContributionStatus: async () => { throw createDisabledError(); },
      handleCapturedCallback: async () => { throw createDisabledError(); },
    };
  }

  return {
    RUNTIME_DEFAULTS,
    RUNTIME_KEYS,
    createContributionOAuthManager,
  };
});
