const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getIcloudForwardMailConfig,
  getIcloudForwardMailProviderOptions,
  getMailProviderConfig,
  normalizeIcloudForwardMailProvider,
  normalizeIcloudTargetMailboxType,
  normalizeMailProvider,
} = require('../mail-provider-utils.js');

test('normalizeMailProvider only keeps simplified mail providers', () => {
  assert.equal(normalizeMailProvider('qq'), 'qq');
  assert.equal(normalizeMailProvider('2925'), '2925');
  assert.equal(normalizeMailProvider('code-platform'), 'code-platform');
  assert.equal(normalizeMailProvider('126'), 'qq');
  assert.equal(normalizeMailProvider('hotmail-api'), 'qq');
  assert.equal(normalizeMailProvider('unknown-provider'), 'qq');
});

test('getMailProviderConfig returns simplified provider configs', () => {
  assert.deepEqual(
    getMailProviderConfig({ mailProvider: 'qq' }),
    {
      source: 'qq-mail',
      url: 'https://wx.mail.qq.com/',
      label: 'QQ 邮箱',
    }
  );
  assert.deepEqual(
    getMailProviderConfig({ mailProvider: '2925' }),
    {
      provider: '2925',
      label: '2925 邮箱',
    }
  );
  assert.deepEqual(
    getMailProviderConfig({ mailProvider: 'code-platform' }),
    {
      provider: 'code-platform',
      label: '验证码平台',
    }
  );
});

test('iCloud forward mailbox helpers normalize and expose supported providers', () => {
  assert.equal(normalizeIcloudTargetMailboxType('forward-mailbox'), 'forward-mailbox');
  assert.equal(normalizeIcloudTargetMailboxType('unknown'), 'icloud-inbox');
  assert.equal(normalizeIcloudForwardMailProvider('GMAIL'), 'gmail');
  assert.equal(normalizeIcloudForwardMailProvider('unknown'), 'qq');
  assert.deepEqual(
    getIcloudForwardMailProviderOptions().map((option) => option.value),
    ['qq', '163', '163-vip', '126', 'gmail']
  );
});

test('getIcloudForwardMailConfig reuses shared mailbox provider configs', () => {
  assert.deepEqual(getIcloudForwardMailConfig('qq'), {
    source: 'qq-mail',
    url: 'https://wx.mail.qq.com/',
    label: 'QQ 邮箱',
  });
  assert.deepEqual(getIcloudForwardMailConfig('gmail'), {
    source: 'gmail-mail',
    url: 'https://mail.google.com/mail/u/0/#inbox',
    label: 'Gmail 邮箱',
    inject: ['content/activation-utils.js', 'content/utils.js', 'content/gmail-mail.js'],
    injectSource: 'gmail-mail',
  });
});
