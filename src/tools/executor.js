import { callGitHubAPI } from "../services/github.js";

export async function executeTool(name, args, env) {
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
    default:
      throw new Error(`Tool "${name}" tidak dikenal atau belum diimplementasikan.`);
  }
}
