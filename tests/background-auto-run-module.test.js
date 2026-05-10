const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('background imports auto-run controller module', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /background\/auto-run-controller\.js/);
});

test('auto-run controller module exposes a factory', () => {
  const source = fs.readFileSync('background/auto-run-controller.js', 'utf8');
  const globalScope = {};

  const api = new Function('self', `${source}; return self.MultiPageBackgroundAutoRunController;`)(globalScope);

  assert.equal(typeof api?.createAutoRunController, 'function');
});

test('auto-run account record status preserves the real failed step instead of parsing guidance text', () => {
  const source = fs.readFileSync('background/auto-run-controller.js', 'utf8');
  const globalScope = {};
  const api = new Function('self', `${source}; return self.MultiPageBackgroundAutoRunController;`)(globalScope);
  const controller = api.createAutoRunController({});

  const state = {
    currentStep: 11,
    stepStatuses: {
      2: 'completed',
      10: 'completed',
      11: 'failed',
    },
  };
  const error = new Error('缺少登录账号：请先完成步骤 2，或在侧栏填写账号后再执行当前步骤。');

  assert.equal(
    controller.resolveAutoRunAccountRecordStatus('failed', state, error),
    'step11_failed'
  );

  error.failedStep = 13;
  assert.equal(
    controller.resolveAutoRunAccountRecordStatus('failed', state, error),
    'step13_failed'
  );
});
