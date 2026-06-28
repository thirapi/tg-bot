const MAX_STORED_ERRORS = 20;
const ERROR_TTL = 86400;

export async function logError(env, chatId, context, error) {
  const key = `errors:${chatId}`;
  try {
    const raw = await env.CHAT_HISTORY.get(key);
    const errors = raw ? JSON.parse(raw) : [];
    errors.push({
      timestamp: Date.now(),
      context,
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
    while (errors.length > MAX_STORED_ERRORS) errors.shift();
    await env.CHAT_HISTORY.put(key, JSON.stringify(errors), { expirationTtl: ERROR_TTL });
  } catch (e) {
    console.error("ErrorLogger failed:", e);
  }
}

export async function getRecentErrors(env, chatId, limit = 10) {
  try {
    const raw = await env.CHAT_HISTORY.get(`errors:${chatId}`);
    if (!raw) return [];
    const errors = JSON.parse(raw);
    return errors.slice(-limit).reverse();
  } catch (e) {
    console.error("ErrorLogger get failed:", e);
    return [];
  }
}
