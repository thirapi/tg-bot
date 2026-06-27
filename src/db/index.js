const MAX_ROWS_PER_CHAT = 60;

export async function getHistory(env, chatId, limit = 40) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT role, parts FROM (
         SELECT id, role, parts FROM conversations
         WHERE chat_id = ?
         ORDER BY id DESC
         LIMIT ?
       )
       ORDER BY id ASC`
    ).bind(chatId, limit).all();

    return results.map(row => ({
      role: row.role,
      parts: JSON.parse(row.parts)
    }));
  } catch (e) {
    console.error("DB getHistory error:", e);
    return [];
  }
}

export async function addHistory(env, chatId, messages) {
  if (!messages || messages.length === 0) return;

  try {
    const stmt = env.DB.prepare(
      `INSERT INTO conversations (chat_id, role, parts) VALUES (?, ?, ?)`
    );
    const batch = messages.map(msg =>
      stmt.bind(chatId, msg.role, JSON.stringify(msg.parts))
    );
    await env.DB.batch(batch);
  } catch (e) {
    console.error("DB addHistory error:", e);
  }
}

export async function clearHistory(env, chatId) {
  try {
    await env.DB.prepare(
      `DELETE FROM conversations WHERE chat_id = ?`
    ).bind(chatId).run();
  } catch (e) {
    console.error("DB clearHistory error:", e);
  }
}

export async function trimHistory(env, chatId, maxPairs) {
  try {
    const maxRows = maxPairs * 6;
    await env.DB.prepare(
      `DELETE FROM conversations
       WHERE chat_id = ? AND id NOT IN (
         SELECT id FROM conversations
         WHERE chat_id = ?
         ORDER BY id DESC
         LIMIT ?
       )`
    ).bind(chatId, chatId, Math.min(maxRows, MAX_ROWS_PER_CHAT)).run();
  } catch (e) {
    console.error("DB trimHistory error:", e);
  }
}

export async function setMemory(env, chatId, key, value) {
  try {
    await env.DB.prepare(
      `INSERT INTO memories (chat_id, key, value, updated_at)
       VALUES (?, ?, ?, unixepoch())
       ON CONFLICT(chat_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    ).bind(chatId, key, String(value)).run();
  } catch (e) {
    console.error("DB setMemory error:", e);
  }
}

export async function getMemory(env, chatId, key) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT value FROM memories WHERE chat_id = ? AND key = ?`
    ).bind(chatId, key).all();
    return results.length > 0 ? results[0].value : null;
  } catch (e) {
    console.error("DB getMemory error:", e);
    return null;
  }
}

export async function getAllMemories(env, chatId) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT key, value FROM memories WHERE chat_id = ? ORDER BY updated_at DESC`
    ).bind(chatId).all();
    return results || [];
  } catch (e) {
    console.error("DB getAllMemories error:", e);
    return [];
  }
}

export async function deleteMemory(env, chatId, key) {
  try {
    await env.DB.prepare(
      `DELETE FROM memories WHERE chat_id = ? AND key = ?`
    ).bind(chatId, key).run();
  } catch (e) {
    console.error("DB deleteMemory error:", e);
  }
}

export async function addTask(env, chatId, title, description, priority = "medium") {
  try {
    const { results } = await env.DB.prepare(
      `INSERT INTO tasks (chat_id, title, description, priority)
       VALUES (?, ?, ?, ?) RETURNING id`
    ).bind(chatId, title, description || null, priority).all();
    return results?.[0]?.id ?? null;
  } catch (e) {
    console.error("DB addTask error:", e);
    return null;
  }
}

export async function getTasks(env, chatId, status) {
  try {
    let query = `SELECT * FROM tasks WHERE chat_id = ?`;
    const params = [chatId];
    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }
    query += ` ORDER BY created_at DESC`;
    const { results } = await env.DB.prepare(query).bind(...params).all();
    return results || [];
  } catch (e) {
    console.error("DB getTasks error:", e);
    return [];
  }
}

export async function updateTaskStatus(env, chatId, taskId, status) {
  try {
    await env.DB.prepare(
      `UPDATE tasks SET status = ?, updated_at = unixepoch() WHERE id = ? AND chat_id = ?`
    ).bind(status, taskId, chatId).run();
  } catch (e) {
    console.error("DB updateTaskStatus error:", e);
  }
}

export async function createTasks(env, chatId, tasks) {
  try {
    const stmt = env.DB.prepare(
      `INSERT INTO tasks (chat_id, title, description, priority) VALUES (?, ?, ?, ?) RETURNING id`
    );
    const batch = tasks.map(t =>
      stmt.bind(chatId, t.title, t.description || null, t.priority || "medium")
    );
    const results = await env.DB.batch(batch);
    return results.map(r => r.results?.[0]?.id ?? null).filter(id => id !== null);
  } catch (e) {
    console.error("DB createTasks error:", e);
    return [];
  }
}

export async function addReminder(env, chatId, title, triggerAt, recurring = 0, intervalSeconds = 0) {
  try {
    const { results } = await env.DB.prepare(
      `INSERT INTO reminders (chat_id, title, trigger_at, recurring, interval_seconds) VALUES (?, ?, ?, ?, ?) RETURNING id`
    ).bind(chatId, title, triggerAt, recurring, intervalSeconds).all();
    return results?.[0]?.id ?? null;
  } catch (e) {
    console.error("DB addReminder error:", e);
    return null;
  }
}

export async function getDueReminders(env, now) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM reminders WHERE trigger_at <= ? AND (last_triggered IS NULL OR last_triggered < trigger_at) ORDER BY trigger_at ASC`
    ).bind(now).all();
    return results || [];
  } catch (e) {
    console.error("DB getDueReminders error:", e);
    return [];
  }
}

export async function markReminderTriggered(env, id, now, nextTriggerAt) {
  try {
    if (nextTriggerAt) {
      await env.DB.prepare(
        `UPDATE reminders SET last_triggered = ?, trigger_at = ? WHERE id = ?`
      ).bind(now, nextTriggerAt, id).run();
    } else {
      await env.DB.prepare(
        `UPDATE reminders SET last_triggered = ? WHERE id = ?`
      ).bind(now, id).run();
    }
  } catch (e) {
    console.error("DB markReminderTriggered error:", e);
  }
}

export async function getReminders(env, chatId) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, title, trigger_at, recurring, interval_seconds, last_triggered FROM reminders WHERE chat_id = ? ORDER BY trigger_at ASC`
    ).bind(chatId).all();
    return results || [];
  } catch (e) {
    console.error("DB getReminders error:", e);
    return [];
  }
}

export async function deleteReminder(env, chatId, id) {
  try {
    await env.DB.prepare(
      `DELETE FROM reminders WHERE id = ? AND chat_id = ?`
    ).bind(id, chatId).run();
  } catch (e) {
    console.error("DB deleteReminder error:", e);
  }
}

export async function clearTasks(env, chatId) {
  try {
    await env.DB.prepare(
      `DELETE FROM tasks WHERE chat_id = ?`
    ).bind(chatId).run();
  } catch (e) {
    console.error("DB clearTasks error:", e);
  }
}
