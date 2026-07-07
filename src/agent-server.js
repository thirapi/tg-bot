import { createServer } from 'http';
import https from 'https';
import { execSync } from 'child_process';
import { runAgentLoop, buildProviderConfigs } from './handlers/message.js';
import { executeTool } from './tools/executor.js';
import { executeSpacesTool, isSpacesTool } from './tools/spaces-executor.js';
import { SPACES_HEARTBEAT_INTERVAL } from './config.js';

async function hybridExecutor(name, args, env, chatId) {
  if (isSpacesTool(name)) {
    return executeSpacesTool(name, args, env, chatId);
  }
  return executeTool(name, args, env, chatId);
}

// Install system dependencies at startup
try {
  execSync('apt-get update -qq && apt-get install -y -qq git', { stdio: 'pipe', timeout: 60000 });
  console.log('Git installed successfully');
} catch (e) {
  console.log('Git install failed (non-fatal):', e.message);
}

const PORT = parseInt(process.env.PORT || '7860', 10);

const workspaceStore = new Map();
const resultsStore = new Map();
const RESULT_TTL = 60 * 60 * 1000; // 1 jam (sama dengan TTL pending di KV)
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of resultsStore) {
    if (now - val.ts > RESULT_TTL) resultsStore.delete(key);
  }
}, 60000);
// Track ongoing chat processes to avoid duplicate execution on the same workspace
const activeChats = new Set();

let lastWorkerUrl = null;
let heartbeatInterval = null;
const workerAgent = new https.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30000 });

function startHeartbeat(workerUrl) {
  if (heartbeatInterval) return;
  console.log(`[Heartbeat] Starting keep-warm pings to ${workerUrl} every ${SPACES_HEARTBEAT_INTERVAL}ms`);
  heartbeatInterval = setInterval(async () => {
    const url = new URL(`${workerUrl}/api/health`);
    try {
      await new Promise((resolve, reject) => {
        const req = https.request({
          agent: workerAgent,
          hostname: url.hostname,
          path: url.pathname + url.search + `?_=${Date.now()}`,
          method: 'GET',
          timeout: 10000,
        }, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
    } catch (e) {
      console.warn(`[Heartbeat] Ping error: ${e.message}`);
      workerAgent.destroy();
    }
  }, SPACES_HEARTBEAT_INTERVAL);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function buildProxyEnv(envVars) {
  const inMemoryKV = new Map();

  const proxyEnv = {
    ...envVars,
    TELEGRAM_BOT_TOKEN: envVars.TELEGRAM_BOT_TOKEN || '',
    GEMINI_API_KEYS: envVars.GEMINI_API_KEYS || '',
    GEMINI_MODELS: envVars.GEMINI_MODELS || 'gemini-3.1-flash-lite,gemini-3-flash-preview,gemini-3.5-flash',
    GROQ_API_KEY: envVars.GROQ_API_KEY || '',
    GROQ_MODELS: envVars.GROQ_MODELS || 'openai/gpt-oss-120b,openai/gpt-oss-20b,llama-3.3-70b-versatile,qwen/qwen3.6-27b',
    AI_PROVIDERS: envVars.AI_PROVIDERS || 'gemini,groq',
    GITHUB_PAT_TOKEN: envVars.GITHUB_PAT_TOKEN || '',
    GEMINI_SYSTEM_PERSONA: envVars.GEMINI_SYSTEM_PERSONA || '',
    GEMINI_SYSTEM_INSTRUCTION: envVars.GEMINI_SYSTEM_INSTRUCTION || '',
    WORKER_URL: envVars.WORKER_URL || '',
    IS_SPACES: 'true',
    CHAT_HISTORY: {
      get: async (key) => inMemoryKV.get(key) || null,
      put: async (key, value, opts) => {
        inMemoryKV.set(key, value);
        if (opts?.expirationTtl) {
          setTimeout(() => inMemoryKV.delete(key), opts.expirationTtl * 1000);
        }
      },
      delete: async (key) => inMemoryKV.delete(key),
    },
    DB: {
      prepare: () => ({
        bind: () => ({
          run: async () => {},
          first: async () => null,
        }),
      }),
    },
  };
  return proxyEnv;
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
    return;
  }

  if (url.pathname.startsWith('/api/result/') && req.method === 'GET') {
    const chatId = url.pathname.slice('/api/result/'.length);
    const data = resultsStore.get(chatId);
    if (!data) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'not_found' }));
      return;
    }
    if (data.status === 'processing') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'processing' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const { status: _s, ...cleanData } = data;
    res.end(JSON.stringify({ status: 'ready', ...cleanData }));
    return;
  }

  if (url.pathname === '/api/result' && req.method === 'DELETE') {
    const chatId = (new URL(req.url, `http://localhost:${PORT}`)).searchParams.get('chatId');
    if (chatId) resultsStore.delete(chatId);
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'deleted' }));
    return;
  }

  if (url.pathname === '/api/process' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { chatId, userPrompt, currentContents: rawContents, memories, tasks, workerUrl: reqWorkerUrl, progressMsgId } = body;

      if (!chatId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing chatId' }));
        return;
      }

      // Keep connection warm by storing worker url and starting heartbeat
      if (reqWorkerUrl) {
        lastWorkerUrl = reqWorkerUrl;
        startHeartbeat(reqWorkerUrl);
      }

      const stringChatId = String(chatId);
      if (activeChats.has(stringChatId)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'busy' }));
        return;
      }

      // Respond immediately to the Cloudflare Worker to prevent HTTP timeout
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'processing' }));

      // Run the agent loop in the background
      activeChats.add(stringChatId);

      // Initialize result as 'processing' so cron doesn't clean up prematurely
      resultsStore.set(stringChatId, { status: 'processing', ts: Date.now() });

      (async () => {
        const proxyEnv = buildProxyEnv(process.env);
        if (lastWorkerUrl) {
          proxyEnv.WORKER_URL = lastWorkerUrl;
        }

          async function sendCallback(body) {
          const url = new URL(`${lastWorkerUrl}/api/spaces-callback`);
          const bodyStr = JSON.stringify(body);
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const result = await new Promise((resolve, reject) => {
                const req = https.request({
                  agent: workerAgent,
                  hostname: url.hostname,
                  path: url.pathname + url.search + `?_=${Date.now()}`,
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer kokoa-runner-secret',
                    'Content-Length': Buffer.byteLength(bodyStr),
                  },
                  timeout: 25000,
                }, (res) => {
                  let data = '';
                  res.on('data', c => data += c);
                  res.on('end', () => {
                    resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: data });
                  });
                });
                req.on('error', (e) => {
                  const cause = e.cause ? ` | cause: ${e.cause?.code || e.cause?.message || JSON.stringify(e.cause)}` : '';
                  reject({ message: e.message, cause });
                });
                req.on('timeout', () => { req.destroy(); reject({ message: 'timeout', cause: '' }); });
                req.write(bodyStr);
                req.end();
              });

              if (result.ok) {
                console.log(`[Spaces] Callback success for chat ${stringChatId} (attempt ${attempt})`);
                resultsStore.delete(stringChatId);
                return;
              }
              console.warn(`[Spaces] Callback returned ${result.status} for chat ${stringChatId} (attempt ${attempt}): ${result.text.slice(0, 200)}`);
            } catch (e) {
              console.warn(`[Spaces] Callback attempt ${attempt} failed for chat ${stringChatId}: ${e.message}${e.cause}`);
              workerAgent.destroy();
            }
            if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
          }
          console.error(`[Spaces] Callback failed for chat ${stringChatId}, short-poll will handle`);
        }

        try {
          const originalHistoryLength = rawContents ? rawContents.length - 1 : 0;
          const currentContents = rawContents || [{ role: 'user', parts: [{ text: userPrompt || '' }] }];
          console.log(`[Spaces] Received chat ${stringChatId} rawContents.length=${rawContents?.length} historyLength=${originalHistoryLength} userPrompt="${(userPrompt || '').slice(0,50)}"`);

          if (memories) proxyEnv.__INJECTED_MEMORIES = memories;
          if (tasks) proxyEnv.__INJECTED_TASKS = tasks;

          // Restore persisted workspace for this chat session
          const workspaceKey = `workspace:${stringChatId}`;
          const savedState = workspaceStore.get(workspaceKey);
          if (savedState) {
            const savedPath = typeof savedState === 'string' ? savedState : savedState.path;
            const savedRepo = typeof savedState === 'string' ? null : savedState.repo;
            const { existsSync } = await import('fs');
            if (existsSync(savedPath)) {
              proxyEnv.__WORKSPACE = savedPath;
              if (savedRepo) proxyEnv.CURRENT_REPO = savedRepo;
              console.log(`[Spaces] Restored workspace for chat ${stringChatId}: ${savedPath}${savedRepo ? ` (repo: ${savedRepo})` : ''}`);
            } else {
              console.log(`[Spaces] Persisted workspace folder not found on disk (likely container restarted), clearing: ${savedPath}`);
              workspaceStore.delete(workspaceKey);
            }
          }

          const providerConfigs = buildProviderConfigs(proxyEnv);
          if (providerConfigs.length === 0) {
            throw new Error('No AI providers configured');
          }

          const startTime = Date.now();
          const result = await runAgentLoop(
            currentContents, proxyEnv, stringChatId, userPrompt || '',
            providerConfigs, [], startTime,
            { executionTimeout: 240000, iterationTimeout: 30000, toolExecutor: hybridExecutor }
          );

          // Persist workspace update if cloneRepo was called during this loop
          const newPath = proxyEnv.__WORKSPACE;
          const newRepo = proxyEnv.CURRENT_REPO;
          if (newPath && (!savedState || newPath !== (typeof savedState === 'string' ? savedState : savedState.path))) {
            workspaceStore.set(workspaceKey, { path: newPath, repo: newRepo || null });
            console.log(`[Spaces] Saved workspace for chat ${stringChatId}: ${newPath}${newRepo ? ` (repo: ${newRepo})` : ''}`);
          }

          const newContent = currentContents.slice(originalHistoryLength)
            .filter(c => !c._selfReflection);
          console.log(`[Spaces] originalHistoryLength=${originalHistoryLength} curLen=${currentContents.length} newLen=${newContent.length} roles=${newContent.map(c=>c.role).join(',')}`);
          let finalText = null;
          if (!result.escalationTriggered) {
            finalText = result.finalText || "tugasnya udah aku jalanin ya! tp aku ga dapet respons teks penutup dr sistem. coba cek repo kamu deh, harusnya kodenya udh ke-update";
          }

          resultsStore.set(stringChatId, {
            status: 'complete',
            finalText,
            newContent,
            escalationTriggered: result.escalationTriggered,
            error: null,
            progressMsgId: progressMsgId || null,
            ts: Date.now()
          });
          console.log(`[Spaces] Result stored for chat ${stringChatId}`);

          if (lastWorkerUrl) {
            sendCallback({
              chatId: stringChatId, newContents: newContent, finalText,
              isFinal: true, maxHistory: 15, progressMsgId,
            });
          }

        } catch (err) {
          console.error('[Spaces] Async agent loop error:', err);
          const errorMsg = err.message;
          resultsStore.set(stringChatId, {
            status: 'complete',
            finalText: null,
            newContent: [],
            escalationTriggered: false,
            error: errorMsg,
            progressMsgId: progressMsgId || null,
            ts: Date.now()
          });
          console.log(`[Spaces] Error result stored for chat ${stringChatId}`);

          if (lastWorkerUrl) {
            sendCallback({
              chatId: stringChatId,
              error: `yah eror pas jalanin di server: ${errorMsg}. coba kirim lagi ya!`,
              isFinal: true,
              progressMsgId,
            });
          }

        } finally {
          activeChats.delete(stringChatId);
        }
      })();

      return;
    } catch (err) {
      console.error('Agent server error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent server running on port ${PORT}`);
});
