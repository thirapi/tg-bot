import { callGitHubAPI } from "../services/github.js";

export async function executeTool(name, args, env, chatId) {
  switch (name) {
    case "listGitHubIssues": {
      const endpoint = `repos/${args.owner}/${args.repo}/issues?state=${args.state || "open"}`;
      return callGitHubAPI(env, endpoint);
    }
    case "getPRDiff": {
      const endpoint = `repos/${args.owner}/${args.repo}/pulls/${args.pull_number}`;
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
      const base64Content = btoa(
        String.fromCharCode(...new TextEncoder().encode(args.content))
      );
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
      const endpoint = `repos/${args.owner}/${args.repo}/pulls/${args.pull_number}/merge`;
      const body = {};
      if (args.commit_title) body.commit_title = args.commit_title;
      if (args.merge_method) body.merge_method = args.merge_method;
      return callGitHubAPI(env, endpoint, "PUT", body);
    }
    case "addLabels": {
      const endpoint = `repos/${args.owner}/${args.repo}/issues/${args.issue_number}/labels`;
      return callGitHubAPI(env, endpoint, "POST", { labels: args.labels });
    }
    case "assignUser": {
      const endpoint = `repos/${args.owner}/${args.repo}/issues/${args.issue_number}/assignees`;
      return callGitHubAPI(env, endpoint, "POST", { assignees: args.assignees });
    }
    case "createIssueComment": {
      const endpoint = `repos/${args.owner}/${args.repo}/issues/${args.issue_number}/comments`;
      return callGitHubAPI(env, endpoint, "POST", { body: args.body });
    }
    case "updateIssueState": {
      const endpoint = `repos/${args.owner}/${args.repo}/issues/${args.issue_number}`;
      const body = {};
      if (args.state) body.state = args.state;
      if (args.title) body.title = args.title;
      if (args.body) body.body = args.body;
      return callGitHubAPI(env, endpoint, "PATCH", body);
    }
    case "updatePRState": {
      const endpoint = `repos/${args.owner}/${args.repo}/pulls/${args.pull_number}`;
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
      const endpoint = `repos/thirapi/tg-bot/dispatches`;
      const body = {
        event_type: "kokoa-dev-task",
        client_payload: {
          target_repo: args.target_repo,
          instruction: args.instruction,
          chat_id: chatId,
        },
      };
      await callGitHubAPI(env, endpoint, "POST", body);
      return {
        message: "Workflow pengembangan berhasil dipicu di GitHub Actions (Bengkel Kerja). Proses ini akan berjalan di latar belakang (Ubuntu Runner). Aku akan memberikan notifikasi setelah tugas selesai atau jika ada perkembangan lebih lanjut.",
      };
    }
    default:
      throw new Error(`Tool "${name}" tidak dikenal atau belum diimplementasikan.`);
  }
}
