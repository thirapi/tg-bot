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

      (async () => {
        const proxyEnv = buildProxyEnv(process.env);
        if (workerUrl) {
          proxyEnv.WORKER_URL = workerUrl;
        }
        let isAgentRunning = true;

        // Keep sending typing indicator to Telegram while processing
        // Keep sending typing indicator to Telegram by routing through Cloudflare Worker callback
        const sendAgentTyping = async () => {
          if (!isAgentRunning) return;
          try {
            const callbackUrl = `${proxyEnv.WORKER_URL || 'https://gemini-telegram-worker.thirafi.workers.dev'}/api/spaces-callback`;
            await fetch(callbackUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer kokoa-runner-secret'
              },
              body: JSON.stringify({
                chatId: stringChatId,
                action: 'typing'
              })
            });
          } catch (_) {}
          if (isAgentRunning) {
            setTimeout(sendAgentTyping, 4000);
          }
        };
        sendAgentTyping();

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

          isAgentRunning = false; // Stop typing indicator before sending final message

          // Strip self-reflection prompts (internal) from history before persisting
          const newContent = currentContents.slice(rawContents?.length || 0)
            .filter(c => !c._selfReflection);
          let finalText = null;
          if (!result.escalationTriggered) {
            finalText = result.finalText || "tugasnya udah aku jalanin ya! tp aku ga dapet respons teks penutup dr sistem. coba cek repo kamu deh, harusnya kodenya udh ke-update";
          }

          // Send Telegram message directly FIRST so user always gets answer
          if (finalText && proxyEnv.TELEGRAM_BOT_TOKEN) {
            try {
              await fetch(`https://api.telegram.org/bot${proxyEnv.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: stringChatId, text: finalText, parse_mode: 'Markdown' }),
              });
            } catch (e) {
              console.error('[Spaces] Direct Telegram send failed:', e.message);
            }
          }

          // Then try callback for history saving + lock release (best-effort with retry)
          let callbackOk = false;
          const callbackUrl = `${proxyEnv.WORKER_URL || 'https://gemini-telegram-worker.thirafi.workers.dev'}/api/spaces-callback`;
          for (let attempt = 1; attempt <= 3; attempt++) {
            let controller, timer;
            try {
              console.log(`[Spaces] Sending final callback (attempt ${attempt}) to ${callbackUrl}`);
              controller = new AbortController();
              timer = setTimeout(() => controller.abort(), 20000);
              await fetch(callbackUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer kokoa-runner-secret'
                },
                body: JSON.stringify({
                  chatId: stringChatId,
                  newContents: newContent,
                  finalText: finalText,
                  isFinal: true,
                  maxHistory: 15
                }),
                signal: controller.signal,
              });
              clearTimeout(timer);
              callbackOk = true;
              break;
            } catch (e) {
              clearTimeout(timer);
              console.error(`[Spaces] Final callback attempt ${attempt} failed:`, e.message);
              if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
            }
          }

          // Fallback: relay lock release + history via Telegram message
          if (!callbackOk && proxyEnv.TELEGRAM_BOT_TOKEN) {
            try {
              const relay = {
                chatId: stringChatId,
                newContents: newContent,
                isFinal: true,
                maxHistory: 15,
                token: 'kokoa-runner-secret',
              };
              const relayText = `__CB__ ${Buffer.from(JSON.stringify(relay)).toString('base64')}`;
              if (relayText.length < 3800) {
                await fetch(`https://api.telegram.org/bot${proxyEnv.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ chat_id: stringChatId, text: relayText, disable_notification: true }),
                });
                console.log('[Spaces] Sent relay callback via Telegram');
              } else {
                // History too large, send minimal relay (lock release only)
                const minimal = { chatId: stringChatId, isFinal: true, token: 'kokoa-runner-secret' };
                const minimalText = `__CB__ ${Buffer.from(JSON.stringify(minimal)).toString('base64')}`;
                await fetch(`https://api.telegram.org/bot${proxyEnv.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ chat_id: stringChatId, text: minimalText, disable_notification: true }),
                });
                console.log('[Spaces] Sent minimal relay callback (history too large)');
              }
            } catch (relayError) {
              console.error('[Spaces] Relay callback failed:', relayError.message);
            }
          }

        } catch (err) {
          console.error('[Spaces] Async agent loop error:', err);
          isAgentRunning = false;

          // Send error to Telegram directly first
          const errorMsg = `yah eror pas jalanin di server: ${err.message}. coba kirim lagi ya!`;
          if (proxyEnv.TELEGRAM_BOT_TOKEN) {
            try {
              await fetch(`https://api.telegram.org/bot${proxyEnv.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: stringChatId, text: errorMsg }),
              });
            } catch (_) {}
          }

          // Try callback for lock release
          let callbackOk = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            let controller, timer;
            try {
              const callbackUrl = `${proxyEnv.WORKER_URL || 'https://gemini-telegram-worker.thirafi.workers.dev'}/api/spaces-callback`;
              controller = new AbortController();
              timer = setTimeout(() => controller.abort(), 20000);
              await fetch(callbackUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer kokoa-runner-secret'
                },
                body: JSON.stringify({
                  chatId: stringChatId,
                  error: errorMsg,
                  isFinal: true
                }),
                signal: controller.signal,
              });
              clearTimeout(timer);
              callbackOk = true;
              break;
            } catch (e) {
              clearTimeout(timer);
              console.error(`[Spaces] Error callback attempt ${attempt} failed:`, e.message);
              if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
            }
          }

          // Fallback: relay lock release via Telegram
          if (!callbackOk && proxyEnv.TELEGRAM_BOT_TOKEN) {
            try {
              const relay = { chatId: stringChatId, error: errorMsg, isFinal: true, token: 'kokoa-runner-secret' };
              const relayText = `__CB__ ${Buffer.from(JSON.stringify(relay)).toString('base64')}`;
              await fetch(`https://api.telegram.org/bot${proxyEnv.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: stringChatId, text: relayText, disable_notification: true }),
              });
              console.log('[Spaces] Sent error relay callback via Telegram');
            } catch (relayError) {
              console.error('[Spaces] Error relay callback failed:', relayError.message);
            }
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
