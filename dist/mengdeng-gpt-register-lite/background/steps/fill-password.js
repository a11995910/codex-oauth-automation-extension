(function attachBackgroundStep3(root, factory) {
  root.MultiPageBackgroundStep3 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep3Module() {
  function createStep3Executor(deps = {}) {
    const {
      addLog,
      chrome,
      ensureContentScriptReadyOnTab,
      generatePassword,
      getTabId,
      isTabAlive,
      resolveSignupMethod,
      sendToContentScript,
      setPasswordState,
      setState,
      SIGNUP_PAGE_INJECT_FILES,
    } = deps;

    function normalizeSignupMethod(value = '') {
      return String(value || '').trim().toLowerCase() === 'phone'
        ? 'phone'
        : 'email';
    }

    function getResolvedSignupMethodForStep3(state = {}) {
      if (typeof resolveSignupMethod === 'function') {
        return normalizeSignupMethod(resolveSignupMethod(state));
      }
      const frozenMethod = String(state?.resolvedSignupMethod || '').trim().toLowerCase();
      if (frozenMethod === 'phone' || frozenMethod === 'email') {
        return normalizeSignupMethod(frozenMethod);
      }
      return normalizeSignupMethod(state?.signupMethod);
    }

    function resolveStep3AccountIdentity(state = {}) {
      const resolvedEmail = String(state?.email || '').trim();
      const rawAccountIdentifierType = String(state?.accountIdentifierType || '').trim().toLowerCase();
      const signupPhoneNumber = String(
        state?.signupPhoneNumber
        || (rawAccountIdentifierType === 'phone' ? state?.accountIdentifier : '')
        || ''
      ).trim();
      const explicitEmailIdentity = rawAccountIdentifierType === 'email' && resolvedEmail;
      const shouldUsePhoneIdentity = !explicitEmailIdentity && (
        rawAccountIdentifierType === 'phone'
        || Boolean(signupPhoneNumber)
        || getResolvedSignupMethodForStep3(state) === 'phone'
      );
      const accountIdentifierType = shouldUsePhoneIdentity
        ? 'phone'
        : (resolvedEmail ? 'email' : 'email');
      const accountIdentifier = accountIdentifierType === 'phone'
        ? signupPhoneNumber
        : resolvedEmail;

      return {
        accountIdentifierType,
        accountIdentifier,
        email: resolvedEmail,
        phoneNumber: signupPhoneNumber,
      };
    }

    async function executeStep3(state) {
      const identity = resolveStep3AccountIdentity(state);
      if (!identity.accountIdentifier) {
        if (identity.accountIdentifierType === 'phone') {
          throw new Error('缺少注册手机号，请先完成步骤 2 或在侧栏填写注册手机号后再执行步骤 3。');
        }
        throw new Error('缺少注册账号，请先完成步骤 2。');
      }

      const signupTabId = await getTabId('signup-page');
      if (!signupTabId || !(await isTabAlive('signup-page'))) {
        throw new Error('认证页面标签页已关闭，请先重新完成步骤 2。');
      }

      const password = state.customPassword || state.password || generatePassword();
      await setPasswordState(password);

      const accounts = state.accounts || [];
      accounts.push({
        email: identity.email,
        phoneNumber: identity.phoneNumber,
        accountIdentifierType: identity.accountIdentifierType,
        accountIdentifier: identity.accountIdentifier,
        password,
        createdAt: new Date().toISOString(),
      });
      await setState({ accounts });

      await chrome.tabs.update(signupTabId, { active: true });
      await ensureContentScriptReadyOnTab('signup-page', signupTabId, {
        inject: SIGNUP_PAGE_INJECT_FILES,
        injectSource: 'signup-page',
        timeoutMs: 45000,
        retryDelayMs: 900,
        logMessage: '步骤 3：密码页内容脚本未就绪，正在等待页面恢复...',
      });

      const identityLabel = identity.accountIdentifierType === 'phone'
        ? `注册手机号为 ${identity.accountIdentifier}`
        : `邮箱为 ${identity.accountIdentifier}`;
      await addLog(
        `步骤 3：正在填写密码，${identityLabel}，密码为${state.customPassword ? '自定义' : '自动生成'}（${password.length} 位）`
      );
      await sendToContentScript('signup-page', {
        type: 'EXECUTE_STEP',
        step: 3,
        source: 'background',
        payload: {
          email: identity.email,
          phoneNumber: identity.phoneNumber,
          accountIdentifierType: identity.accountIdentifierType,
          accountIdentifier: identity.accountIdentifier,
          password,
        },
      });
    }

    return { executeStep3 };
  }

  return { createStep3Executor };
});
