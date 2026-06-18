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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  const options = { method, headers, signal: controller.signal };
  if (body) {
    options.body = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  try {
    const res = await fetch(url, options);
    clearTimeout(timeoutId);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`GitHub API Error: ${res.status} - ${errText}`);
    }
    const contentType = res.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      return res.json();
    }
    return res.text();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("GitHub API Request Timeout (15s)");
    }
    throw err;
  }
}
