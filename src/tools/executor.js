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
    default:
      throw new Error(`Tool "${name}" tidak dikenal atau belum diimplementasikan.`);
  }
}
