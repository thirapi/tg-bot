import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { AgentSession } from './runner-gemini.js';

const {
  TARGET_REPO,
  INSTRUCTION,
  CHAT_ID,
  GLOBAL_WORKER_PAT,
  TELEGRAM_BOT_TOKEN
} = process.env;

async function sendTelegramUpdate(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });
  } catch (error) {
    console.error('Telegram Error:', error);
  }
}

function normalizePath(p) {
  // Prevent path traversal
  return path.normalize(p).replace(/^(\.\.(\/|\\|$))+/, '');
}

async function main() {
  const safeInstruction = String(INSTRUCTION || '');
  
  if (GLOBAL_WORKER_PAT) {
    process.env.GITHUB_TOKEN = GLOBAL_WORKER_PAT;
    process.env.GH_TOKEN = GLOBAL_WORKER_PAT;
  }

  await sendTelegramUpdate(`🛠 **Agent Kokoa Dev Aktif!**\n\nRepo: \`${TARGET_REPO}\`\n\n*Menganalisis instruksi:* ${safeInstruction}\nAku akan mengeksplorasi kode dan mencari cara terbaik...`);

  try {
    const workDir = path.join(process.cwd(), 'target_workspace');
    const repoUrl = `https://x-access-token:${GLOBAL_WORKER_PAT}@github.com/${TARGET_REPO}.git`;

    console.log('Cloning...');
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
    execSync(`git clone ${repoUrl} ${workDir}`);
    process.chdir(workDir);

    execSync('git config user.name "ccocoa"');
    execSync('git config user.email "270871570+ccocoa@users.noreply.github.com"');

    // Tool Handlers for the Agent
    const toolHandlers = {
      listDirectory: async ({ path: dirPath }) => {
        const safePath = normalizePath(dirPath || '.');
        const fullPath = path.join(process.cwd(), safePath);
        if (!fs.existsSync(fullPath)) return `Error: Direktori ${safePath} tidak ditemukan.`;
        const list = fs.readdirSync(fullPath, { withFileTypes: true });
        return list.map(item => `${item.isDirectory() ? '[DIR] ' : '[FILE]'} ${item.name}`).join('\n');
      },
      readFile: async ({ path: filePath }) => {
        const safePath = normalizePath(filePath);
        const fullPath = path.join(process.cwd(), safePath);
        if (!fs.existsSync(fullPath)) return `Error: File ${safePath} tidak ditemukan.`;
        return fs.readFileSync(fullPath, 'utf8');
      },
      writeFile: async ({ path: filePath, content }) => {
        const safePath = normalizePath(filePath);
        const fullPath = path.join(process.cwd(), safePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf8');
        return `Sukses: File ${safePath} berhasil ditulis.`;
      },
      deleteFile: async ({ path: filePath }) => {
        const safePath = normalizePath(filePath);
        const fullPath = path.join(process.cwd(), safePath);
        if (fs.existsSync(fullPath)) {
          fs.rmSync(fullPath, { force: true, recursive: true });
          return `Sukses: File ${safePath} berhasil dihapus.`;
        }
        return `Catatan: File ${safePath} memang tidak ada.`;
      },
      runCommand: async ({ command }) => {
        try {
          const output = execSync(command, { encoding: 'utf8', stdio: 'pipe', timeout: 60000 }); // 60s timeout
          return `[SUCCESS]\n${output}`;
        } catch (error) {
          return `[ERROR]\nstdout: ${error.stdout || ''}\nstderr: ${error.stderr || ''}`;
        }
      }
    };

    // Initialize Agent
    const agent = new AgentSession(safeInstruction, toolHandlers, async (statusMsg) => {
      // Kita kirim pesan status kalau perlu, tapi untuk menghindari spam, mungkin batasi saja
      // await sendTelegramUpdate(statusMsg);
    });

    console.log("Memulai Agent Loop...");
    const result = await agent.start();

    if (!result) {
      throw new Error("Agent selesai tapi tidak memberikan result final.");
    }

    console.log("Agent selesai. Mengecek perubahan git...");
    execSync('git add .');
    const status = execSync('git status --porcelain', { encoding: 'utf8' });
    
    if (status.trim()) {
      const { commitMessage, branchName, prTitle, prBody } = result;

      const commitMsg = commitMessage 
        ? `${commitMessage}\n\nCo-authored-by: thirapi <132630759+thirapi@users.noreply.github.com>` 
        : `feat: auto-fix instruction applied\n\nCo-authored-by: thirapi <132630759+thirapi@users.noreply.github.com>`;

      // Bersihkan nama branch
      let cleanBranchName = (branchName || `auto-fix/${Date.now()}`)
        .replace(/[^a-zA-Z0-9-]/g, '-')
        .replace(/-+/g, '-');
      if (cleanBranchName.startsWith('-')) cleanBranchName = cleanBranchName.substring(1);

      execSync(`git checkout -b ${cleanBranchName}`);
      execFileSync('git', ['commit', '-m', commitMsg]);
      execSync(`git push https://x-access-token:${GLOBAL_WORKER_PAT}@github.com/${TARGET_REPO}.git ${cleanBranchName}`);

      let finalPrBody = prBody || `🤖 **Kokoa Dev Agent Report**\n\n**Original Instruction:**\n${safeInstruction}`;
      if (!finalPrBody.includes('Original Instruction')) {
        finalPrBody += `\n\n---\n🤖 **Kokoa Dev Agent Report**\n**Original Instruction:**\n${safeInstruction}`;
      }

      execSync(`gh pr create --repo "${TARGET_REPO}" --title "${prTitle || 'Auto-fix'}" --body "${finalPrBody}" --head "${cleanBranchName}" --base main`);

      await sendTelegramUpdate(`🚀 **Tugas Selesai!**\n\nBranch baru \`${cleanBranchName}\` berhasil dibuat dan Pull Request telah dikirim ke \`main\`!`);
    } else {
      await sendTelegramUpdate(`Selesai! Agent merasa tidak ada kode yang perlu diubah.`);
    }

  } catch (error) {
    console.error('Fatal Error:', error);
    await sendTelegramUpdate(`Waduh, Agent mengalami kendala:\n\`${error.message}\``);
    process.exit(1);
  }
}

main();