import { updateTaskStatus, setMemory } from "../db/index.js";

const CALLBACK_TOKEN = "kokoa-runner-secret";

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
