export async function callGitHubAPI(
  env,
  endpoint,
  method = "GET",
  body = null,
  extraHeaders = {},
) {
  const url = `https://api.github.com/${endpoint.replace(/^\//, "")}`;
  const headers = {
    Authorization: `Bearer ${env.GITHUB_PAT_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Cloudflare-Worker-GitHub-Agent",
    ...extraHeaders,
  };
  const options = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, options);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub API Error: ${res.status} - ${errText}`);
  }
  const contentType = res.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
}
