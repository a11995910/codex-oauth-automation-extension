const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadGoPayUtils() {
  const source = fs.readFileSync('gopay-utils.js', 'utf8');
  const globalScope = {};
  return new Function('self', `${source}; return self.GoPayUtils;`)(globalScope);
}

test('GoPay utils normalize manual OTP input', () => {
  const api = loadGoPayUtils();
  assert.equal(api.normalizeGoPayOtp(' 12-34 56 '), '123456');
  assert.equal(api.normalizeGoPayOtp('abc'), '');
  assert.equal(api.normalizeGpcOtpChannel('sms'), 'sms');
  assert.equal(api.normalizeGpcOtpChannel('wa'), 'whatsapp');
  assert.equal(api.normalizeGpcOtpChannel('unknown'), 'whatsapp');
});

test('GoPay utils keeps GPC helper payment method distinct', () => {
  const api = loadGoPayUtils();
  assert.equal(api.normalizePlusPaymentMethod('gpc-helper'), 'gpc-helper');
  assert.equal(api.normalizePlusPaymentMethod('gopay'), 'gopay');
  assert.equal(api.normalizePlusPaymentMethod('unknown'), 'paypal');
});

test('GoPay utils builds GPC queue task and balance URLs from helper endpoints', () => {
  const api = loadGoPayUtils();
  assert.equal(api.DEFAULT_GPC_HELPER_API_URL, 'https://gpc.qlhazycoder.top');
  assert.equal(api.normalizeGpcHelperBaseUrl(''), 'https://gpc.qlhazycoder.top');
  assert.equal(api.normalizeGpcHelperBaseUrl('https://example.com/api/gp/tasks'), 'https://gpc.qlhazycoder.top');
  assert.equal(
    api.buildGpcHelperApiUrl('', '/api/checkout/start'),
    'https://gpc.qlhazycoder.top/api/checkout/start'
  );
  assert.equal(
    api.buildGpcApiKeyBalanceUrl('http://localhost:18473/'),
    'http://localhost:18473/api/gp/balance'
  );
  assert.equal(
    api.buildGpcCardBalanceUrl('https://gpc.qlhazycoder.top/api/gp/balance'),
    'https://gpc.qlhazycoder.top/api/gp/balance'
  );
  assert.deepEqual(
    api.buildGpcApiKeyHeaders(' gpc-123 ', { Accept: 'application/json' }),
    { Accept: 'application/json', 'X-API-Key': 'gpc-123' }
  );
  assert.equal(
    api.buildGpcTaskCreateUrl('https://gpc.qlhazycoder.top/api/checkout/start'),
    'https://gpc.qlhazycoder.top/api/gp/tasks'
  );
  assert.equal(
    api.buildGpcTaskQueryUrl('https://gpc.qlhazycoder.top/api/gp/tasks/task_old?card_key=old', 'task/1'),
    'https://gpc.qlhazycoder.top/api/gp/tasks/task%2F1'
  );
  assert.equal(
    api.buildGpcTaskActionUrl('https://gpc.qlhazycoder.top/api/gp/tasks/task_old/stop', 'task_1', 'pin'),
    'https://gpc.qlhazycoder.top/api/gp/tasks/task_1/pin'
  );
});

test('GoPay utils builds GPC queue OTP/PIN payloads without card_key', () => {
  const api = loadGoPayUtils();
  assert.deepEqual(
    api.buildGpcTaskOtpPayload({ otp: ' 12-34 56 ', card_key: ' card_1 ', reference_id: 'ref_1' }),
    { otp: '123456' }
  );
  assert.deepEqual(
    api.buildGpcTaskPinPayload({ pin: '65-43-21', cardKey: 'card_1', challengeId: 'challenge_1' }),
    { pin: '654321' }
  );
});

test('GoPay utils formats balance and maps linked-account errors', () => {
  const api = loadGoPayUtils();
  assert.equal(
    api.formatGpcBalancePayload({ remaining_uses: 12, status: 'active', used_uses: 2, flow_id: 'flow_1' }),
    '余额 12，已用 2，状态 active，flow_id flow_1'
  );
  assert.equal(
    api.formatGpcBalancePayload({
      code: 200,
      message: 'ok',
      data: { remaining_uses: 0, total_uses: 3, used_uses: 3, status: 'active' },
    }),
    '余额 0/3，已用 3，状态 active'
  );
  assert.deepEqual(
    api.unwrapGpcResponse({ code: 200, message: 'ok', data: { task_id: 'task_1' } }),
    { task_id: 'task_1' }
  );
  assert.equal(
    api.extractGpcResponseErrorDetail({ errors: [{ loc: ['body', 'otp'], msg: 'Field required' }] }, 422),
    'body.otp: Field required'
  );
  assert.equal(
    api.extractGpcResponseErrorDetail({
      code: 400,
      message: 'invalid_param',
      data: { detail: '手机号不能为空', fields: [{ field: 'phone_number', message: '必填' }] },
    }, 400),
    '手机号不能为空'
  );
  assert.equal(
    api.extractGpcResponseErrorDetail({
      code: 400,
      message: 'invalid_param',
      data: { fields: [{ field: 'phone_number', message: '必填' }] },
    }, 400),
    'phone_number: 必填'
  );
  assert.equal(
    api.extractGpcResponseErrorDetail({ error_messages: ['account already linked'] }, 406),
    'GOPAY已经绑了订阅，需要手动解绑'
  );
});
