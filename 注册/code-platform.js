// code-platform.js — verification code platform API client
// API: GET {baseUrl}/api/latest?alias={email}
// Auth: Authorization: Bearer {key}, X-API-Key: {key}

const DEFAULT_MAX_ATTEMPTS = 25;
const DEFAULT_INTERVAL_MS = 3000;

function normalizeUrl(baseUrl) {
  let url = String(baseUrl || '').trim();
  if (!url) return 'https://code.youkeduo.site';
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  return url.replace(/\/+$/, '');
}

function buildLatestUrl(baseUrl, email) {
  const root = normalizeUrl(baseUrl);
  return `${root}/api/latest?alias=${encodeURIComponent(String(email || '').trim().toLowerCase())}`;
}

async function requestLatestCode(baseUrl, apiKey, email) {
  const url = buildLatestUrl(baseUrl, email);
  const headers = { Accept: 'application/json' };
  const key = String(apiKey || '').trim();
  if (key) {
    headers['Authorization'] = `Bearer ${key}`;
    headers['X-API-Key'] = key;
  }

  const response = await fetch(url, { headers });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`验证码平台返回非 JSON 响应：${text.slice(0, 200)}`);
  }

  if (!response.ok || payload.ok === false) {
    const msg = payload.error || payload.message || `HTTP ${response.status}`;
    throw new Error(`验证码平台请求失败：${msg}`);
  }

  const code = String(payload.code || payload.record?.code || '').replace(/\D/g, '');
  if (!code) {
    return null; // no code yet
  }

  const record = payload.record || payload.message || {};
  const ts = record.receivedAt || record.received_at || record.emailTimestamp
    || record.email_timestamp || record.timestamp || record.date
    || record.scannedAt || record.scanned_at || 0;
  const emailTimestamp = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000;

  return {
    code,
    emailTimestamp: emailTimestamp || Date.now(),
    mailId: record.id || record.messageId || payload.messageId || '',
  };
}

async function pollForCode(baseUrl, apiKey, email, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS);
  const intervalMs = Math.max(500, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
  const signal = options.signal || null;
  const onAttempt = typeof options.onAttempt === 'function' ? options.onAttempt : null;
  const seenCodes = new Set(options.excludeCodes || []);

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new Error('ABORTED: 验证码轮询已被停止。');
    }

    try {
      const result = await requestLatestCode(baseUrl, apiKey, email);
      if (result && result.code && !seenCodes.has(result.code)) {
        return result;
      }
      if (onAttempt) {
        onAttempt({ attempt, maxAttempts, hasCode: !!result?.code });
      }
    } catch (err) {
      lastError = err;
      if (onAttempt) {
        onAttempt({ attempt, maxAttempts, error: err.message });
      }
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        }
      });
    }
  }

  throw lastError || new Error(`验证码轮询超时：${maxAttempts} 次尝试后仍未获取到验证码，邮箱 ${email}`);
}

module.exports = { pollForCode, requestLatestCode, normalizeUrl, buildLatestUrl };
