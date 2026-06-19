import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getFixSuggestion } from './runner-gemini.js';

const { TARGET_REPO, INSTRUCTION, CHAT_ID, GLOBAL_WORKER_PAT, TELEGRAM_BOT_TOKEN } = process.env;

async function callGitHubAPI(endpoint, method = 'GET', body = null) {
  const url = `https://api.github.com/${endpoint}`;
  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${GLOBAL_WORKER_PAT}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Kokoa-Dev-Agent'
    },
    body: body ? JSON.stringify(body) : null
  });
  if (!response.ok) throw new Error(`GitHub API Error: ${response.statusText}`);
  return response.json();
}

async function main() {
  try {
    const repo = 'thirapi/tg-bot';
    const branchName = 'remove-readme-draft';
    const filePath = 'README_DRAFT.md';

    const mainBranch = await callGitHubAPI(`repos/${repo}/branches/main`);
    const sha = mainBranch.commit.sha;

    await callGitHubAPI(`repos/${repo}/git/refs`, 'POST', {
      ref: `refs/heads/${branchName}`,
      sha: sha
    });

    const fileData = await callGitHubAPI(`repos/${repo}/contents/${filePath}?ref=${branchName}`);
    
    await callGitHubAPI(`repos/${repo}/contents/${filePath}`, 'DELETE', {
      message: 'chore: remove draft readme',
      sha: fileData.sha,
      branch: branchName
    });

    await callGitHubAPI(`repos/${repo}/pulls`, 'POST', {
      title: 'Remove README_DRAFT.md',
      head: branchName,
      base: 'main',
      body: 'Automated cleanup of draft file.'
    });

    console.log('Successfully removed file and created PR.');
  } catch (error) {
    console.error('Error:', error);
  }
}

main();