// server.js — Express server with SSE, task orchestration, and API endpoints

const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { registerOneAccount } = require('./register-engine');

// ---- config ----

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {
      codePlatformBaseUrl: 'https://code.youkeduo.site',
      codePlatformApiKey: '',
      parallelThreads: 1,
      duckProfileDir: './profiles/duck-profile',
      accountsDir: './accounts',
      port: 3456,
    };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

// ---- app setup ----

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- SSE helpers ----

const sseClients = new Set();

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('event: connected\ndata: {}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ---- runtime state ----

let browser = null;
let abortController = null;
let runningState = {
  status: 'idle',       // idle | running | stopping
  total: 0,
  completed: 0,
  failed: 0,
  tasks: [],
};

function resetState() {
  runningState = {
    status: 'idle',
    total: 0,
    completed: 0,
    failed: 0,
    tasks: [],
  };
}

// ---- API routes ----

app.get('/api/config', (_req, res) => {
  res.json(loadConfig());
});

app.post('/api/config', (req, res) => {
  const current = loadConfig();
  const updates = req.body || {};
  const merged = { ...current, ...updates };
  saveConfig(merged);
  res.json(merged);
});

app.get('/api/status', (_req, res) => {
  res.json(runningState);
});

app.post('/api/start', async (req, res) => {
  if (runningState.status === 'running') {
    return res.status(400).json({ error: '已有任务在运行中，请先停止。' });
  }

  const config = loadConfig();
  const count = Math.max(1, Math.min(100, Number(req.body?.count) || 1));
  const threads = Math.max(1, Math.min(10, Number(req.body?.threads) || config.parallelThreads || 1));

  // merge any override config
  if (req.body?.codePlatformBaseUrl) config.codePlatformBaseUrl = req.body.codePlatformBaseUrl;
  if (req.body?.codePlatformApiKey !== undefined) config.codePlatformApiKey = req.body.codePlatformApiKey;

  abortController = new AbortController();
  runningState = {
    status: 'running',
    total: count,
    completed: 0,
    failed: 0,
    tasks: [],
  };

  broadcastSSE('status', { status: 'running', total: count, completed: 0, failed: 0 });
  broadcastSSE('log', { level: 'info', message: `开始注册 ${count} 个账号（并行线程：${threads}）` });

  // launch browser if needed
  if (!browser || !browser.isConnected()) {
    const profileDir = path.resolve(config.duckProfileDir || './profiles/duck-profile');
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }
    browser = await puppeteer.launch({
      headless: false,
      userDataDir: profileDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
      defaultViewport: { width: 1280, height: 800 },
    });
    broadcastSSE('log', { level: 'info', message: '浏览器已启动' });
  }

  // run tasks with proper concurrency control
  const running = new Set();

  async function runOneTask(runId) {
    const onLog = (level, message) => {
      broadcastSSE('log', { level, message });
    };

    const result = await registerOneAccount(browser, {
      signal: abortController.signal,
      codePlatformBaseUrl: config.codePlatformBaseUrl,
      codePlatformApiKey: config.codePlatformApiKey,
      accountsDir: config.accountsDir || './accounts',
    }, runId, onLog);

    if (result.success) {
      runningState.completed++;
      broadcastSSE('progress', {
        completed: runningState.completed,
        failed: runningState.failed,
        total: runningState.total,
      });
      broadcastSSE('account_saved', result.accountData);
    } else if (result.error !== 'ABORTED') {
      runningState.failed++;
      broadcastSSE('progress', {
        completed: runningState.completed,
        failed: runningState.failed,
        total: runningState.total,
      });
    }
    return result;
  }

  const runTasks = async () => {
    for (let i = 1; i <= count; i++) {
      if (abortController.signal.aborted) break;

      // wait until a thread slot frees up
      while (running.size >= threads) {
        await Promise.race(running).catch(() => {});
      }

      const taskPromise = runOneTask(i);
      running.add(taskPromise);
      runningState.tasks.push(taskPromise);
      taskPromise.finally(() => running.delete(taskPromise));
    }

    await Promise.allSettled(runningState.tasks);
  };

  // run in background
  runTasks().finally(() => {
    if (runningState.status === 'running') {
      runningState.status = 'idle';
      broadcastSSE('status', {
        status: 'idle',
        total: runningState.total,
        completed: runningState.completed,
        failed: runningState.failed,
      });
      broadcastSSE('log', {
        level: 'info',
        message: `全部完成：成功 ${runningState.completed}，失败 ${runningState.failed}`,
      });
    }
  });

  res.json({ ok: true, count, threads });
});

app.post('/api/stop', (_req, res) => {
  runningState.status = 'stopping';
  if (abortController) {
    abortController.abort();
  }
  broadcastSSE('log', { level: 'warn', message: '正在停止所有任务...' });
  broadcastSSE('status', { status: 'stopped' });
  resetState();
  res.json({ ok: true });
});

// ---- start ----

const config = loadConfig();
const port = config.port || 3456;

app.listen(port, () => {
  console.log(`注册机已启动：http://localhost:${port}`);
  console.log(`验证码平台：${config.codePlatformBaseUrl}`);
  console.log(`默认线程数：${config.parallelThreads}`);
});
