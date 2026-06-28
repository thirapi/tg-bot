import { updateTaskStatus, setMemory, deleteMemoriesByPrefix } from "../db/index.js";

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

  return new Response("Not Found", { status: 404 });
}
