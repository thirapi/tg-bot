import { getDueReminders, markReminderTriggered } from "../db/index.js";
import { sendTelegramMessage } from "../services/telegram.js";

export async function handleCron(event, env, ctx) {
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
}
