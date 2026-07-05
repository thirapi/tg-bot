import { createServer } from 'http';
import { execSync } from 'child_process';
import { runAgentLoop, buildProviderConfigs } from './handlers/message.js';
import { executeTool } from './tools/executor.js';
import { executeSpacesTool, isSpacesTool } from './tools/spaces-executor.js';

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
const RESULT_TTL = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of resultsStore) {
    if (now - val.ts > RESULT_TTL) resultsStore.delete(key);
  }
}, 60000);
// Track ongoing chat processes to avoid duplicate execution on the same workspace
const activeChats = new Set();

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
    res.end(JSON.stringify({ status: 'ready', ...data }));
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
      const { chatId, userPrompt, currentContents: rawContents, memories, tasks, workerUrl } = body;

      if (!chatId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing chatId' }));
        return;
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
        if (workerUrl) {
          proxyEnv.WORKER_URL = workerUrl;
        }
        try {
          const currentContents = rawContents || [{ role: 'user', parts: [{ text: userPrompt || '' }] }];

          if (memories) proxyEnv.__INJECTED_MEMORIES = memories;
          if (tasks) proxyEnv.__INJECTED_TASKS = tasks;

          // Restore persisted workspace for this chat session
          const workspaceKey = `workspace:${stringChatId}`;
          const savedWorkspace = workspaceStore.get(workspaceKey);
          if (savedWorkspace) {
            const { existsSync } = await import('fs');
            if (existsSync(savedWorkspace)) {
              proxyEnv.__WORKSPACE = savedWorkspace;
              console.log(`[Spaces] Restored workspace for chat ${stringChatId}: ${savedWorkspace}`);
            } else {
              console.log(`[Spaces] Persisted workspace folder not found on disk (likely container restarted), clearing: ${savedWorkspace}`);
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
          if (proxyEnv.__WORKSPACE && proxyEnv.__WORKSPACE !== savedWorkspace) {
            workspaceStore.set(workspaceKey, proxyEnv.__WORKSPACE);
            console.log(`[Spaces] Saved workspace for chat ${stringChatId}: ${proxyEnv.__WORKSPACE}`);
          }

          const newContent = currentContents.slice(rawContents?.length || 0)
            .filter(c => !c._selfReflection);
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
            ts: Date.now()
          });
          console.log(`[Spaces] Result stored for chat ${stringChatId}`);

          // Fast-path: coba HTTP (port 80) — mungkin tidak diblokir seperti 443.
          // Cloudflare redirect HTTP→HTTPS, jadi data tidak sampai ke Worker.
          // Tapi ini buat test apakah port 80 bisa tembus HF firewall.
          if (workerUrl) {
            const httpUrl = workerUrl.replace(/^https:\/\//, 'http://');
            fetch(`${httpUrl}/api/spaces-callback`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer kokoa-runner-secret' },
              body: JSON.stringify({ chatId: stringChatId, newContents: newContent, finalText, isFinal: true, maxHistory: 15 }),
              redirect: 'manual',
              signal: AbortSignal.timeout(5000),
            }).then(r => console.log(`[Spaces] HTTP port 80 reachable! Status: ${r.status}`))
              .catch(e => console.log(`[Spaces] HTTP port 80 juga gagal: ${e.message}`));
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
            ts: Date.now()
          });
          console.log(`[Spaces] Error result stored for chat ${stringChatId}`);

          if (workerUrl) {
            const httpUrl = workerUrl.replace(/^https:\/\//, 'http://');
            fetch(`${httpUrl}/api/spaces-callback`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer kokoa-runner-secret' },
              body: JSON.stringify({ chatId: stringChatId, error: errorMsg, isFinal: true }),
              redirect: 'manual',
              signal: AbortSignal.timeout(5000),
            }).then(r => console.log(`[Spaces] HTTP port 80 reachable (error path)! Status: ${r.status}`))
              .catch(e => console.log(`[Spaces] HTTP port 80 juga gagal (error path): ${e.message}`));
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
