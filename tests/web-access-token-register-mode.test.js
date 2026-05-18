const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

function loadStepDefinitions() {
  const source = fs.readFileSync('data/step-definitions.js', 'utf8');
  const root = {};
  return new Function('self', `${source}; return self.MultiPageStepDefinitions;`)(root);
}

test('网页 access token 注册模式只保留注册阶段步骤', () => {
  const steps = loadStepDefinitions();
  const activeSteps = steps.getSteps({ webAccessTokenRegisterEnabled: true });

  assert.deepEqual(steps.getStepIds({ webAccessTokenRegisterEnabled: true }), [1, 2, 3, 4, 5, 6]);
  assert.equal(activeSteps.at(-1).id, 6);
  assert.equal(activeSteps.at(-1).title, '下载网页 AccessToken');
  assert.equal(steps.getStepById(7, { webAccessTokenRegisterEnabled: true }), null);
  assert.deepEqual(steps.getStepIds({ webAccessTokenRegisterEnabled: false }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('网页 access token 注册模式配置会被持久化并随自动批次保留', () => {
  const backgroundSource = fs.readFileSync('background.js', 'utf8');
  const autoRunSource = fs.readFileSync('background/auto-run-controller.js', 'utf8');

  assert.match(backgroundSource, /webAccessTokenRegisterEnabled:\s*false/);
  assert.match(backgroundSource, /case 'webAccessTokenRegisterEnabled':/);
  assert.match(backgroundSource, /getSteps\(\{\s*signupMethod:[\s\S]*webAccessTokenRegisterEnabled:/);
  assert.match(backgroundSource, /webAccessTokenBatchTokens:\s*\[\]/);
  assert.match(backgroundSource, /normalizeWebAccessTokenBatchTokens\(/);
  assert.match(backgroundSource, /downloadWebAccessTokens\(tokens,\s*\{\s*fileName:\s*batchState\.fileName,\s*conflictAction:\s*'overwrite'/);
  assert.match(autoRunSource, /webAccessTokenRegisterEnabled:\s*prevState\.webAccessTokenRegisterEnabled/);
  assert.match(autoRunSource, /webAccessTokenBatchTokens:\s*Array\.isArray\(prevState\.webAccessTokenBatchTokens\)/);
});

test('侧边栏支持网页 access token 开关和下载兜底消息', () => {
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
  const sidepanelSource = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

  assert.match(html, /id="input-web-access-token-register-enabled"/);
  assert.match(html, /网页 access token 注册/);
  assert.match(sidepanelSource, /const inputWebAccessTokenRegisterEnabled = document\.getElementById\('input-web-access-token-register-enabled'\);/);
  assert.match(sidepanelSource, /webAccessTokenRegisterEnabled:\s*typeof inputWebAccessTokenRegisterEnabled/);
  assert.match(sidepanelSource, /case 'WEB_ACCESS_TOKENS_READY':/);
  assert.match(sidepanelSource, /downloadTextFile\(fileContent,\s*fileName,\s*'text\/plain;charset=utf-8'\)/);
});
