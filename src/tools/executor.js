import { callGitHubAPI } from "../services/github.js";
import { bufferToBase64 } from "../utils/array.js";
import { webSearch, webFetch } from "../services/search.js";
import {
  createTasks,
  getTasks,
  updateTaskStatus,
  clearTasks,
  setMemory,
  getMemory,
  getAllMemories,
  deleteMemory,
  addReminder,
  getReminders,
  deleteReminder,
} from "../db/index.js";

export async function executeTool(name, args, env, chatId) {
  switch (name) {
    case "listGitHubIssues": {
      const endpoint = `repos/${args.owner}/${args.repo}/issues?state=${args.state || "open"}`;
      return callGitHubAPI(env, endpoint);
    }
    case "getPRDiff": {
      const pull_number = parseInt(args.pull_number, 10);
      const endpoint = `repos/${args.owner}/${args.repo}/pulls/${pull_number}`;
      return callGitHubAPI(env, endpoint, "GET", null, {
        Accept: "application/vnd.github.v3.diff",
      });
    }
    case "createGitHubIssue": {
      const endpoint = `repos/${args.owner}/${args.repo}/issues`;
      return callGitHubAPI(env, endpoint, "POST", {
        title: args.title,
        body: args.body,
        labels: args.labels,
      });
    }
    case "getFileContent": {
      const endpoint = `repos/${args.owner}/${args.repo}/contents/${args.path}${args.ref ? "?ref=" + args.ref : ""}`;
      const res = await callGitHubAPI(env, endpoint);
      if (res && res.type === "file" && res.encoding === "base64" && res.content) {
        const decoded = new TextDecoder().decode(
          Uint8Array.from(atob(res.content.replace(/\s/g, "")), (c) => c.charCodeAt(0))
        );
        return { ...res, content: decoded };
      }
      return res;
    }
    case "createOrUpdateFile": {
      const endpoint = `repos/${args.owner}/${args.repo}/contents/${args.path}`;
      const bytes = new TextEncoder().encode(args.content);
      const base64Content = bufferToBase64(bytes);
      const body = {
        message: args.message,
        content: base64Content,
      };
      if (args.sha) body.sha = args.sha;
      if (args.branch) body.branch = args.branch;
      return callGitHubAPI(env, endpoint, "PUT", body);
    }
    case "createPullRequest": {
      const endpoint = `repos/${args.owner}/${args.repo}/pulls`;
      const body = {
        title: args.title,
        head: args.head,
        base: args.base,
      };
      if (args.body) body.body = args.body;
      return callGitHubAPI(env, endpoint, "POST", body);
    }
    case "mergePullRequest": {
      const pull_number = parseInt(args.pull_number, 10);
      const endpoint = `repos/${args.owner}/${args.repo}/pulls/${pull_number}/merge`;
      const body = {};
      if (args.commit_title) body.commit_title = args.commit_title;
      if (args.merge_method) body.merge_method = args.merge_method;
      return callGitHubAPI(env, endpoint, "PUT", body);
    }
    case "addLabels": {
      const issue_number = parseInt(args.issue_number, 10);
      const endpoint = `repos/${args.owner}/${args.repo}/issues/${issue_number}/labels`;
      return callGitHubAPI(env, endpoint, "POST", { labels: args.labels });
    }
    case "assignUser": {
      const issue_number = parseInt(args.issue_number, 10);
      const endpoint = `repos/${args.owner}/${args.repo}/issues/${issue_number}/assignees`;
      return callGitHubAPI(env, endpoint, "POST", { assignees: args.assignees });
    }
    case "createIssueComment": {
      const issue_number = parseInt(args.issue_number, 10);
      const endpoint = `repos/${args.owner}/${args.repo}/issues/${issue_number}/comments`;
      return callGitHubAPI(env, endpoint, "POST", { body: args.body });
    }
    case "updateIssueState": {
      const issue_number = parseInt(args.issue_number, 10);
      const endpoint = `repos/${args.owner}/${args.repo}/issues/${issue_number}`;
      const body = {};
      if (args.state) body.state = args.state;
      if (args.title) body.title = args.title;
      if (args.body) body.body = args.body;
      return callGitHubAPI(env, endpoint, "PATCH", body);
    }
    case "updatePRState": {
      const pull_number = parseInt(args.pull_number, 10);
      const endpoint = `repos/${args.owner}/${args.repo}/pulls/${pull_number}`;
      const body = {};
      if (args.state) body.state = args.state;
      if (args.title) body.title = args.title;
      if (args.body) body.body = args.body;
      if (args.base) body.base = args.base;
      return callGitHubAPI(env, endpoint, "PATCH", body);
    }
    case "listDirectoryContents": {
      const endpoint = `repos/${args.owner}/${args.repo}/contents/${args.path}${args.ref ? "?ref=" + args.ref : ""}`;
      return callGitHubAPI(env, endpoint);
    }
    case "deleteFile": {
      const endpoint = `repos/${args.owner}/${args.repo}/contents/${args.path}`;
      const body = {
        message: args.message,
        sha: args.sha,
      };
      if (args.branch) body.branch = args.branch;
      return callGitHubAPI(env, endpoint, "DELETE", body);
    }
    case "searchInFiles": {
      const endpoint = `search/code?q=${encodeURIComponent(args.q)}${args.sort ? "&sort=" + args.sort : ""}${args.order ? "&order=" + args.order : ""}`;
      return callGitHubAPI(env, endpoint);
    }
    case "triggerDeveloperWorkflow": {
      const dispatchEndpoint = `repos/thirapi/tg-bot/dispatches`;
      const mode = args.mode || "code";
      const body = {
        event_type: "kokoa-dev-task",
        client_payload: {
          target_repo: args.target_repo,
          instruction: args.instruction,
          mode,
          chat_id: chatId,
          context_id: args.context_id || "",
          worker_url: args.worker_url || env.WORKER_URL || "",
        },
      };
      await callGitHubAPI(env, dispatchEndpoint, "POST", body);
      const msg = mode === "analysis"
        ? "oke, aku kirim tim analis ke repo itu ya. nanti hasilnya aku kirim ke sini kalo udah selesai!"
        : "Workflow pengembangan berhasil dipicu di GitHub Actions. Proses ini akan berjalan di latar belakang (Ubuntu Runner). Aku akan memberikan notifikasi setelah tugas selesai atau jika ada perkembangan lebih lanjut.";
      return { message: msg };
    }
    case "checkWorkflowStatus": {
      const runsEndpoint = `repos/${args.owner}/${args.repo}/actions/runs?event=repository_dispatch&per_page=3`;
      const runs = await callGitHubAPI(env, runsEndpoint);
      if (!runs || !runs.workflow_runs || runs.workflow_runs.length === 0) {
        return { message: "Belum ada workflow yang pernah dijalankan." };
      }
      const latest = runs.workflow_runs[0];
      const status = latest.status === "completed" ? `completed (${latest.conclusion})` : latest.status;
      return {
        workflow_status: status,
        created_at: latest.created_at,
        updated_at: latest.updated_at,
        html_url: latest.html_url,
        run_id: latest.id,
      };
    }
    case "webSearch": {
      return await webSearch(args.query, env);
    }
    case "webFetch": {
      return await webFetch(args.url);
    }
    case "createTaskPlan": {
      const tasks = (args.steps || []).map((step, i) => ({
        title: step,
        description: `Langkah ${i + 1}: ${step}`,
        priority: "medium",
      }));
      if (tasks.length === 0) return { error: "Tidak ada langkah yang diberikan." };
      const ids = await createTasks(env, chatId, tasks);
      const summary = tasks.map((t, i) => ({
        id: ids[i],
        title: t.title,
        status: "pending",
      }));
      return {
        message: `Rencana "${args.title || "Tanpa judul"}" berhasil dibuat dengan ${tasks.length} langkah.`,
        plan: summary,
        total: tasks.length,
      };
    }
    case "getTaskPlan": {
      const tasks = await getTasks(env, chatId);
      return tasks.length > 0
        ? { tasks: tasks.map(t => ({ id: t.id, title: t.title, status: t.status, priority: t.priority })) }
        : { message: "Belum ada task plan yang dibuat. Gunakan createTaskPlan untuk membuatnya." };
    }
    case "updateTaskStatus": {
      const validStatuses = ["pending", "in_progress", "completed", "failed"];
      if (!validStatuses.includes(args.status)) {
        return { error: `Status tidak valid. Pilihan: ${validStatuses.join(", ")}` };
      }
      await updateTaskStatus(env, chatId, args.task_id, args.status);

      const remaining = await getTasks(env, chatId, "pending");
      const inProgress = await getTasks(env, chatId, "in_progress");
      const allDone = remaining.length === 0 && inProgress.length === 0;

      return {
        message: `Tugas #${args.task_id} diupdate ke "${args.status}".`,
        remaining: remaining.length,
        all_done: allDone,
      };
    }
    case "clearTaskPlan": {
      await clearTasks(env, chatId);
      return { message: "Semua tugas dalam plan berhasil dihapus." };
    }
    case "remember": {
      await setMemory(env, chatId, args.key, args.value);
      return { message: `Oke, aku ingat ${args.key}: ${args.value}` };
    }
    case "recall": {
      const value = await getMemory(env, chatId, args.key);
      return value
        ? { key: args.key, value }
        : { message: `Aku gak nemu info soal "${args.key}" di memori.` };
    }
    case "recallAll": {
      const all = await getAllMemories(env, chatId);
      return all.length > 0
        ? { memories: all.map(m => ({ key: m.key, value: m.value })) }
        : { message: "Belum ada memori yang disimpan." };
    }
    case "forget": {
      await deleteMemory(env, chatId, args.key);
      return { message: `Oke, info soal "${args.key}" udah aku hapus dari memori.` };
    }
    case "setReminder": {
      const delayS = Math.max(60, (args.delay_minutes || 1) * 60);
      const triggerAt = Math.floor(Date.now() / 1000) + delayS;
      const recurring = args.recurring === "daily" ? 1 : 0;
      const id = await addReminder(
        env, chatId, args.title, triggerAt, recurring,
        recurring ? 86400 : 0,
      );
      if (!id) return { error: "Gagal buat reminder." };
      const recurringLabel = recurring ? " (harian)" : "";
      return {
        message: `Oke, aku ingetin kamu "${args.title}" dalam ${args.delay_minutes} menit${recurringLabel}.`,
        reminder_id: id,
        trigger_at: triggerAt,
      };
    }
    case "getReminders": {
      const list = await getReminders(env, chatId);
      if (list.length === 0) return { message: "Tidak ada pengingat yang aktif." };
      return {
        reminders: list.map(r => ({
          id: r.id,
          title: r.title,
          trigger_at: r.trigger_at,
          recurring: !!r.recurring,
          last_triggered: r.last_triggered,
        })),
      };
    }
    case "deleteReminder": {
      await deleteReminder(env, chatId, args.reminder_id);
      return { message: `Pengingat #${args.reminder_id} udah dihapus.` };
    }
    case "cloneRepo": {
      if (!env.IS_SPACES) throw new Error("cloneRepo hanya tersedia di server dedicated (Spaces).");
      const { execSync } = await import("child_process");
      const repoUrl = `https://github.com/${args.repo}.git`;
      const dirName = args.repo.replace(/[^a-zA-Z0-9_-]/g, "-");
      const targetDir = `/tmp/tg-bot/repos/${dirName}`;
      execSync(
        `rm -rf "${targetDir}" && mkdir -p /tmp/tg-bot/repos && git clone ${args.ref ? "-b " + args.ref + " " : ""}"${repoUrl}" "${targetDir}"`,
        { stdio: "pipe", timeout: 60000 }
      );
      env.__WORKSPACE = targetDir;
      return { workspace: targetDir, message: `Repo ${args.repo} berhasil di-clone ke ${targetDir}` };
    }
    case "readLocalFile": {
      if (!env.IS_SPACES) throw new Error("readLocalFile hanya tersedia di server dedicated (Spaces).");
      const { readFileSync } = await import("fs");
      const filePath = args.path || env.__WORKSPACE;
      if (!filePath) throw new Error("Path tidak ditentukan dan tidak ada workspace aktif.");
      const content = readFileSync(filePath, "utf-8");
      return { path: filePath, size: content.length, content };
    }
    case "listLocalDir": {
      if (!env.IS_SPACES) throw new Error("listLocalDir hanya tersedia di server dedicated (Spaces).");
      const { readdirSync, statSync } = await import("fs");
      const { join } = await import("path");
      const dirPath = args.path || env.__WORKSPACE;
      if (!dirPath) throw new Error("Path tidak ditentukan dan tidak ada workspace aktif.");
      const entries = readdirSync(dirPath);
      const details = entries.map(e => {
        const full = join(dirPath, e);
        try {
          const s = statSync(full);
          return { name: e, type: s.isDirectory() ? "dir" : "file", size: s.size };
        } catch { return { name: e, type: "unknown" }; }
      });
      return { path: dirPath, entries: details };
    }
    case "grepLocalFiles": {
      if (!env.IS_SPACES) throw new Error("grepLocalFiles hanya tersedia di server dedicated (Spaces).");
      const { execSync } = await import("child_process");
      const searchPath = args.path || env.__WORKSPACE;
      if (!searchPath) throw new Error("Path tidak ditentukan dan tidak ada workspace aktif.");
      let cmd = `grep -rn '${args.pattern.replace(/'/g, "'\\''")}' "${searchPath}"`;
      if (args.include) cmd += ` --include="${args.include}"`;
      try {
        const output = execSync(cmd, { stdio: "pipe", timeout: 15000, maxBuffer: 1024 * 1024 });
        const lines = output.toString().split("\n").filter(Boolean).slice(0, 100);
        return { matches: lines.length, results: lines };
      } catch (err) {
        const stderr = err.stderr?.toString() || "";
        if (err.status === 1 && !stderr) return { matches: 0, results: [] };
        throw new Error(`grep gagal: ${stderr.slice(0, 200)}`);
      }
    }
    case "runCommand": {
      if (!env.IS_SPACES) throw new Error("runCommand hanya tersedia di server dedicated (Spaces).");
      const { execSync } = await import("child_process");
      const cwd = args.cwd || env.__WORKSPACE;
      if (!cwd) throw new Error("cwd tidak ditentukan dan tidak ada workspace aktif.");
      const timeoutSec = Math.min(args.timeout || 30, 120);
      try {
        const output = execSync(args.command, {
          cwd,
          stdio: "pipe",
          timeout: timeoutSec * 1000,
          maxBuffer: 5 * 1024 * 1024,
          shell: true,
        });
        return { exitCode: 0, stdout: output.toString().slice(0, 5000), stderr: "" };
      } catch (err) {
        return {
          exitCode: err.status || 1,
          stdout: (err.stdout?.toString() || "").slice(0, 5000),
          stderr: (err.stderr?.toString() || "").slice(0, 2000),
        };
      }
    }
    default:
      throw new Error(`Tool "${name}" tidak dikenal atau belum diimplementasikan.`);
  }
}
