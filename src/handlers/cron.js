import { getDueReminders, markReminderTriggered, addHistory, trimHistory, releaseChatLock, getPendingSpaces, removePendingSpace, cleanupExpiredPending } from "../db/index.js";
import { sendTelegramMessage } from "../services/telegram.js";
import { markdownToRichHtml } from "../utils/formatter.js";

async function pollSpacesResults(env, ctx) {
  if (!env.HF_SPACES_URL) return;

  try {
    await cleanupExpiredPending(env, 3600);
    const pending = await getPendingSpaces(env);
    if (pending.length === 0) return;

    for (const row of pending) {
      const chatId = row.chat_id;
      try {
        const res = await fetch(`${env.HF_SPACES_URL}/api/result/${chatId}`, {
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json();

        if (data.status === 'processing') {
          // Still processing — try again next cron cycle
          continue;
        }

        if (data.status === 'not_found') {
          console.log(`[Cron] Spaces result not found for chat ${chatId}, sending error`);
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            "server Spaces aku restart atau kereset sebelum sempat selesai. coba kirim lagi ya!",
          );
          const errProgressKey = `progress_msg:${chatId}`;
          let errProgressId = data.progressMsgId;
          if (!errProgressId) {
            errProgressId = await env.CHAT_HISTORY.get(errProgressKey);
          }
          if (errProgressId) {
            const { deleteTelegramMessage } = await import("../services/telegram.js");
            await deleteTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, parseInt(errProgressId)).catch(() => {});
            await env.CHAT_HISTORY.delete(errProgressKey).catch(() => {});
          }
          await removePendingSpace(env, chatId);
          await releaseChatLock(env, chatId);
          continue;
        }

        if (data.status !== 'ready') continue;

        // Result ready — send to Telegram, save history, release lock
        console.log(`[Cron] Spaces result ready for chat ${chatId}`);

        console.log(`[Cron] chatId=${chatId} newContent=${data.newContent?.length} finalText=${data.finalText?.slice(0,30)}`);
        if (data.newContent && data.newContent.length > 0) {
          const cleaned = data.newContent.map(c => ({
            role: c.role,
            parts: c.parts.map(p => {
              if (p.inline_data) return { text: `[Media: ${p.inline_data.mime_type}]` };
              const cp = {};
              if (p.text !== undefined) cp.text = p.text;
              if (Object.keys(cp).length > 0) return cp;
              if (p.functionCall) return { text: `[FunctionCall: ${p.functionCall.name}]` };
              if (p.functionResponse) return { text: `[FunctionResponse: ${p.functionResponse.name}]` };
              return { text: '' };
            }).filter(p => p.text || Object.keys(p).length > 0)
          }));
          await addHistory(env, chatId, cleaned);
          await trimHistory(env, chatId, 15);
        }

        if (data.escalationTriggered) {
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            `tugas ini butuh akses sistem yang lebih dalam. aku kerjakan di GitHub Actions ya...`
          );
        } else if (data.finalText) {
          const richHtml = markdownToRichHtml(data.finalText);
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, richHtml);
        } else if (data.error) {
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            `yah eror pas jalanin di server: ${data.error}. coba kirim lagi ya!`
          );
        } else {
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            "tugasnya udah aku jalanin ya! tp aku ga dapet respons teks penutup dr sistem. coba cek repo kamu deh, harusnya kodenya udh ke-update",
          );
        }

        await removePendingSpace(env, chatId);

        // Delete progress message — priority dari result body (direct pass, no KV)
        let progressMsgId = data.progressMsgId;
        if (!progressMsgId) {
          progressMsgId = await env.CHAT_HISTORY.get(`progress_msg:${chatId}`);
        }
        if (progressMsgId) {
          const { deleteTelegramMessage } = await import("../services/telegram.js");
          await deleteTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, parseInt(progressMsgId)).catch(() => {});
          await env.CHAT_HISTORY.delete(`progress_msg:${chatId}`).catch(() => {});
        }

        // Release lock
        await releaseChatLock(env, chatId);

        // Dequeue pending message jika ada
        try {
          const { processMessage } = await import("./message.js");
          const pendingRaw = await env.CHAT_HISTORY.get(`pending:${chatId}`);
          if (pendingRaw) {
            await env.CHAT_HISTORY.delete(`pending:${chatId}`).catch(() => {});
            const pending = JSON.parse(pendingRaw);
            const { acquireChatLock } = await import("../db/index.js");
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
          console.error(`[Cron] Dequeue pending message failed for chat ${chatId}:`, e);
        }

        console.log(`[Cron] Completed Spaces result for chat ${chatId}`);

        // Delete result from Spaces server
        try {
          await fetch(`${env.HF_SPACES_URL}/api/result?chatId=${chatId}`, { method: 'DELETE' });
        } catch (_) {}

      } catch (e) {
        console.error(`[Cron] Failed to poll Spaces result for chat ${chatId}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Cron] Spaces polling error:', e.message);
  }
}

export async function handleCron(event, env, ctx) {
  // 1. Handle reminders
  const now = Math.floor(Date.now() / 1000);
  const due = await getDueReminders(env, now);

  for (const reminder of due) {
    try {
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        reminder.chat_id,
        `<b>eeh inget!</b>\n${reminder.title}`,
      );

      let nextTrigger = null;
      if (reminder.recurring && reminder.interval_seconds > 0) {
        nextTrigger = now + reminder.interval_seconds;
      }
      await markReminderTriggered(env, reminder.id, now, nextTrigger);
    } catch (e) {
      console.error(`Cron: gagal kirim reminder ${reminder.id}:`, e.message);
    }
  }

  if (due.length > 0) {
    console.log(`Cron: ${due.length} reminder(s) terkirim.`);
  }

  // 2. Poll Spaces for pending results
  await pollSpacesResults(env, ctx);
}
