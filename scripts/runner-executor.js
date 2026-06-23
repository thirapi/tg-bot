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
  return path.normalize(p).replace(/^(\.\.(\/|\\|$))+/, '');
}

async function main() {
  const safeInstruction = String(INSTRUCTION || '');

  if (GLOBAL_WORKER_PAT) {
    process.env.GITHUB_TOKEN = GLOBAL_WORKER_PAT;
    process.env.GH_TOKEN = GLOBAL_WORKER_PAT;
  }

  await sendTelegramUpdate(`🛠 **kokoa dev agent aktif!**\n\nrepo: \`${TARGET_REPO}\`\n\n*analisis instruksi:* ${safeInstruction}\naku mulai explore kode dan cari cara terbaik ya...`);

  try {
    const workDir = path.join(process.cwd(), 'target_workspace');
    const repoUrl = `https://x-access-token:${GLOBAL_WORKER_PAT}@github.com/${TARGET_REPO}.git`;

    console.log('Cloning...');
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });

    try {
      execSync(`git clone ${repoUrl} ${workDir}`, { stdio: 'pipe' });
      process.chdir(workDir);
    } catch (error) {
      const stderr = (error.stderr || '').toString();
      if (stderr.includes('not found')) {
        console.log(`Repo ${TARGET_REPO} tidak ditemukan. Membuat repo baru...`);
        await sendTelegramUpdate(`✨ repo \`${TARGET_REPO}\` belum ada nih. aku buatkan yg baru dulu ya...`);

        fs.mkdirSync(workDir, { recursive: true });
        process.chdir(workDir);
        execSync('git init');
        try { execSync('git checkout -b main'); } catch (e) { }

        execSync('git config user.name "ccocoa"');
        execSync('git config user.email "270871570+ccocoa@users.noreply.github.com"');

        fs.writeFileSync('README.md', `# ${TARGET_REPO}\n\nRepository automatically created by Kokoa Dev Agent.`);
        execSync('git add README.md');
        execSync('git commit -m "chore: initial commit"');

        execSync(`gh repo create ${TARGET_REPO} --public --source=. --remote=origin --push`);
        await sendTelegramUpdate(`✅ repo \`${TARGET_REPO}\` udh berhasil dibuat! lanjut ngerjain instruksi ya...`);
      } else {
        throw error;
      }
    }

    execSync('git config user.name "ccocoa"');
    execSync('git config user.email "270871570+ccocoa@users.noreply.github.com"');

    function ensureDefaultGitignore() {
      const gitignorePath = '.gitignore';
      const defaults = [
        'node_modules/',
        'dist/',
        'build/',
        '.next/',
        '.astro/',
        '.nuxt/',
        'out/',
        '*.log',
        '.DS_Store',
        '.env',
        '.env.local',
        '.env.production',
        '.env.development'
      ];

      let currentContent = '';
      if (fs.existsSync(gitignorePath)) {
        currentContent = fs.readFileSync(gitignorePath, 'utf8');
      }

      const lines = currentContent.split('\n').map(l => l.trim());
      const toAdd = defaults.filter(item => !lines.includes(item));

      if (toAdd.length > 0) {
        console.log('Menambahkan aturan default ke .gitignore...');
        const appendText = (currentContent && !currentContent.endsWith('\n') ? '\n' : '') +
          '\n# Default ignores added by Kokoa Executor\n' +
          toAdd.join('\n') + '\n';
        fs.appendFileSync(gitignorePath, appendText, 'utf8');
      }
    }
    ensureDefaultGitignore();

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
        const trimmedCommand = command.trim();
        if (trimmedCommand.startsWith('cd ') && !trimmedCommand.includes('&&') && !trimmedCommand.includes(';') && !trimmedCommand.includes('|')) {
          return `[ERROR]\nPeringatan: Perintah 'cd' tidak bersifat persisten di antara pemanggilan tool. Jika kamu ingin menjalankan perintah di direktori tertentu, gabungkan perintah tersebut menggunakan operator '&&', contoh: 'cd ${trimmedCommand.substring(3).trim()} && perintah_kamu'.`;
        }

        const cleanedCommand = command.replace(/2>&1/g, '').replace(/>\s*\/dev\/null/g, '');
        if (cleanedCommand.includes('>') || cleanedCommand.includes('>>') || cleanedCommand.includes('<<')) {
          return `[ERROR]\nKamu terdeteksi mencoba menulis/memodifikasi file menggunakan redirection shell (>, >>, <<) di runCommand. Hal ini dilarang karena rentan terhadap kesalahan interpretasi tanda kutip, ekspansi variabel shell (seperti \${{ secrets.GITHUB_TOKEN }}), dan pemotongan teks. Silakan gunakan tool 'writeFile' untuk membuat atau memperbarui file secara aman.`;
        }

        try {
          const output = execSync(command, { encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
          return `[SUCCESS]\n${output}`;
        } catch (error) {
          return `[ERROR]\nstdout: ${error.stdout || ''}\nstderr: ${error.stderr || ''}`;
        }
      }
    };

    const agent = new AgentSession(safeInstruction, toolHandlers, async (statusMsg) => {
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

      let cleanBranchName = (branchName || `auto-fix/${Date.now()}`)
        .replace(/[^a-zA-Z0-9-]/g, '-')
        .replace(/-+/g, '-');
      if (cleanBranchName.startsWith('-')) cleanBranchName = cleanBranchName.substring(1);

      const originUrl = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
      const authUrl = originUrl.replace('https://github.com/', `https://x-access-token:${GLOBAL_WORKER_PAT}@github.com/`);

      if (cleanBranchName === 'main') {
        execFileSync('git', ['commit', '-m', commitMsg]);
        execSync(`git push ${authUrl} main`);
        await sendTelegramUpdate(`🚀 **tugas selesai!**\n\nperubahan udah berhasil aku push langsung ke branch \`main\` ya!`);
      } else {
        execSync(`git checkout -b ${cleanBranchName}`);
        execFileSync('git', ['commit', '-m', commitMsg]);
        execSync(`git push ${authUrl} ${cleanBranchName}`);

        let finalPrBody = prBody || `🤖 **Kokoa Dev Agent Report**\n\n**Original Instruction:**\n${safeInstruction}`;
        if (!finalPrBody.includes('Original Instruction')) {
          finalPrBody += `\n\n---\n🤖 **Kokoa Dev Agent Report**\n**Original Instruction:**\n${safeInstruction}`;
        }

        execFileSync('gh', [
          'pr', 'create',
          '--title', prTitle || 'Auto-fix',
          '--body', finalPrBody,
          '--head', cleanBranchName,
          '--base', 'main'
        ], { encoding: 'utf8' });

        await sendTelegramUpdate(`🚀 **tugas selesai!**\n\nbranch baru \`${cleanBranchName}\` udh dibuat dan pull request-nya juga udh aku kirim ke \`main\`!`);
      }
    } else {
      await sendTelegramUpdate(`selesai! kayaknya ga ada kode yg perlu diubah deh.`);
    }

  } catch (error) {
    console.error('Fatal Error:', error);
    await sendTelegramUpdate(`waduh, kokoa dapet kendala nih:\n\`${error.message}\``);
    process.exit(1);
  }
}

main();