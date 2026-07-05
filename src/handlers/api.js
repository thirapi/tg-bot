import { updateTaskStatus, setMemory, deleteMemoriesByPrefix, getGHAContext, consumeGHAContext, getMemory, saveGHAContext, acquireChatLock, releaseChatLock } from "../db/index.js";

const CALLBACK_TOKEN = "kokoa-runner-secret";

async function sendTelegramMessage(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch (e) {
    console.error("TG send error:", e);
  }
}

export async function handleAPI(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/runner-callback") {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${CALLBACK_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const body = await request.json();
      const { chat_id, type, data } = body;

      if (!chat_id) {
        return new Response("Missing chat_id", { status: 400 });
      }

      switch (type) {
        case "task_update": {
          if (data.task_id && data.status) {
            await updateTaskStatus(env, chat_id, data.task_id, data.status);
          }
          break;
        }
        case "memory": {
          if (data.key && data.value) {
            await setMemory(env, chat_id, data.key, data.value);
          }
          break;
        }
        case "analysis_result": {
          let analysis = data.analysis || "gak ada hasil analisis.";
          const repo = data.repo || "";
          const header = `**Analisis Repo: ${repo}**\n\n`;
          const maxLen = 4000;
          if (analysis.length + header.length > maxLen) {
            analysis = analysis.substring(0, maxLen - header.length - 100) + `\n\n... *(laporan dipotong, terlalu panjang)*`;
          }
          const msg = header + analysis;
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chat_id, msg);

          await deleteMemoriesByPrefix(env, chat_id, "last_analysis_");
          const memoryKey = `last_analysis_${(repo || "unknown").replace(/[^a-zA-Z0-9_]/g, "_")}`;
          const truncated = analysis.length > 2500 ? analysis.substring(0, 2500) + "\n\n... (truncated)" : analysis;
          await setMemory(env, chat_id, memoryKey, truncated);
          await setMemory(env, chat_id, "last_analysis_repo", repo);
          break;
        }
        case "workflow_result": {
          await deleteMemoriesByPrefix(env, chat_id, "workflow_");
          if (data.status) {
            await setMemory(env, chat_id, "workflow_status", data.status);
          }
          if (data.pr_url) {
            await setMemory(env, chat_id, "workflow_pr_url", data.pr_url);
          }
          if (data.branch) {
            await setMemory(env, chat_id, "workflow_branch", data.branch);
          }
          if (data.error) {
            const errTrunc = data.error.length > 1500 ? data.error.substring(0, 1500) + "\n\n...(truncated)" : data.error;
            await setMemory(env, chat_id, "workflow_error", errTrunc);
          }

          let notif = "";
          if (data.status === "success") {
            notif = `selesai! PR: ${data.pr_url || "gak tau"}`;
          } else if (data.status === "no_changes") {
            notif = "selesai! gak ada perubahan yang diperlukan.";
          } else {
            notif = `duh error: ${(data.error || "gak tau kenapa").substring(0, 300)}`;
          }
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chat_id, notif);
          break;
        }
        default:
          return new Response("Unknown type", { status: 400 });
      }

      return new Response("OK", { status: 200 });
    } catch (e) {
      console.error("API callback error:", e);
      return new Response("Bad Request", { status: 400 });
    }
  }

  if (path === "/api/context" || path.startsWith("/api/context/")) {
    const contextId = path.startsWith("/api/context/") ? path.split("/api/context/")[1] : null;

    if (request.method === "GET" && contextId) {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${CALLBACK_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const ctx = await getGHAContext(env, contextId);
      if (!ctx) {
        return new Response("Not Found", { status: 404 });
      }
      await consumeGHAContext(env, contextId);
      return new Response(JSON.stringify(ctx), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "PUT" && contextId) {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${CALLBACK_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const body = await request.json();
      await saveGHAContext(env, { id: contextId, ...body });
      return new Response("OK", { status: 200 });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  if (path === "/api/memory" || path.startsWith("/api/memory/")) {
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${CALLBACK_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (request.method === "POST") {
      const body = await request.json();
      const { chat_id, key, value } = body;
      if (chat_id && key && value) {
        await setMemory(env, chat_id, key, value);
        return new Response("OK", { status: 200 });
      }
      return new Response("Missing fields", { status: 400 });
    }

    if (request.method === "GET" && path.startsWith("/api/memory/")) {
      const parts = path.split("/");
      const chatId = parts[3];
      const key = parts.slice(4).join("/");
      if (chatId && key) {
        const value = await getMemory(env, chatId, key);
        return new Response(JSON.stringify({ key, value }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Missing params", { status: 400 });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  if (path === "/api/spaces-callback") {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${CALLBACK_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const body = await request.json();
      const { chatId, newContents, maxHistory, finalText, error, action, progressText, isFinal } = body;

      if (!chatId) {
        return new Response("Missing chatId", { status: 400 });
      }

      // Handle Telegram action (e.g., typing)
      if (action) {
        const { sendTelegramAction } = await import("../services/telegram.js");
        await sendTelegramAction(env.TELEGRAM_BOT_TOKEN, chatId, action).catch(e => 
          console.error("Failed to send action on callback:", e)
        );
      }

      // Handle progress text update by editing the progress message
      if (progressText) {
        const progressMsgId = await env.CHAT_HISTORY.get(`progress_msg:${chatId}`);
        if (progressMsgId) {
          const { editTelegramMessage } = await import("../services/telegram.js");
          const progressHtml = `Cocoa sedang menganalisis/menjalankan tugas kamu... ⏳\n\n<b>Status:</b> ${progressText}`;
          await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, progressMsgId, progressHtml).catch(e =>
            console.error("Failed to edit progress message:", e)
          );
        }
      }

      // Handle Telegram final text response
      if (finalText) {
        const { sendTelegramMessage } = await import("../services/telegram.js");
        const { markdownToRichHtml } = await import("../utils/formatter.js");
        const richHtml = markdownToRichHtml(finalText);
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, richHtml).catch(e =>
          console.error("Failed to send finalText on callback:", e)
        );
      }

      // Handle Telegram error response
      if (error) {
        const { sendTelegramMessage } = await import("../services/telegram.js");
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, error).catch(e =>
          console.error("Failed to send error on callback:", e)
        );
      }

      // Handle final cleanup (delete progress loading message & release lock)
      if (isFinal) {
        // progressMsgId dari body callback (direct pass, no KV)
        let progressMsgId = body.progressMsgId;
        if (!progressMsgId) {
          for (let i = 0; i < 5; i++) {
            progressMsgId = await env.CHAT_HISTORY.get(`progress_msg:${chatId}`);
            if (progressMsgId) break;
            await new Promise(r => setTimeout(r, 300));
          }
        }
        if (progressMsgId) {
          const { deleteTelegramMessage } = await import("../services/telegram.js");
          await deleteTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, parseInt(progressMsgId)).catch(e =>
            console.error("Failed to delete progress message:", e)
          );
          await env.CHAT_HISTORY.delete(`progress_msg:${chatId}`).catch(() => {});
        }

        console.log(`Releasing D1 lock for chat: ${chatId} (spaces-callback)`);
        await releaseChatLock(env, chatId);

        // Tandai callback sudah selesai + hapus pending key biar cron tidak duplicate
        await env.CHAT_HISTORY.put(`callback_done:${chatId}`, "1", { expirationTtl: 300 }).catch(() => {});
        await env.CHAT_HISTORY.delete(`spaces_pending:${chatId}`).catch(() => {});

        // Dequeue pending message if any
        const { processMessage } = await import("./message.js");
        try {
          const pendingRaw = await env.CHAT_HISTORY.get(`pending:${chatId}`);
          if (pendingRaw) {
            await env.CHAT_HISTORY.delete(`pending:${chatId}`).catch(() => {});
            const pending = JSON.parse(pendingRaw);
            const acquired = await acquireChatLock(env, chatId);
            if (acquired) {
              const fakeMsg = {
                chat: { id: chatId },
                text: pending.text,
                caption: pending.caption,
                photo: pending.photo,
                voice: pending.voice,
              };
              ctx.waitUntil(processMessage(fakeMsg, env));
            }
          }
        } catch (e) {
          console.error('Dequeue pending message on callback failed:', e);
        }
      }

      console.log(`[Callback] chatId=${chatId} newContents=${newContents?.length} finalText=${finalText?.slice(0,30)}`);
      // Save history to D1 if new contents are present
      if (newContents && newContents.length > 0) {
        const { addHistory, trimHistory } = await import("../db/index.js");

        // Clean the new contents to ensure safety (strip media objects to metadata labels, etc.)
        const cleaned = newContents.map(c => ({
          role: c.role,
          parts: c.parts.map(p => {
            if (p.inline_data) return { text: `[Media: ${p.inline_data.mime_type}]` };
            const cleanedPart = {};
            if (p.text !== undefined) cleanedPart.text = p.text;
            if (Object.keys(cleanedPart).length > 0) return cleanedPart;
            if (p.functionCall) return { text: `[FunctionCall: ${p.functionCall.name}]` };
            if (p.functionResponse) return { text: `[FunctionResponse: ${p.functionResponse.name}]` };
            return { text: '' };
          }).filter(p => p.text || Object.keys(p).length > 0)
        }));

        await addHistory(env, chatId, cleaned);
        await trimHistory(env, chatId, maxHistory || 15);
      }

      return new Response("OK", { status: 200 });
    } catch (e) {
      console.error("Spaces callback error:", e);
      return new Response("Error", { status: 500 });
    }
  }

  return new Response("Not Found", { status: 404 });
}
