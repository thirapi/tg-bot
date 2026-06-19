import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getFixSuggestion } from './runner-gemini.js';

const {
  TARGET_REPO,
  INSTRUCTION,
  CHAT_ID,
  GLOBAL_WORKER_PAT,
  TELEGRAM_BOT_TOKEN
} = process.env;

const MAX_ITERATIONS = 3;

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

function runCommand(command) {
  try {
    const output = execSync(command, { encoding: 'utf8', stdio: 'pipe' });
    return { success: true, output };
  } catch (error) {
    return {
      success: false,
      output: error.stdout + '\n' + error.stderr
    };
  }
}

function getFilesRecursively(dir, results = []) {
  const ignore = ['node_modules', '.git', '.next', 'dist', 'build', '.cache'];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (ignore.includes(file)) continue;
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      getFilesRecursively(filePath, results);
    } else if (/\.(js|ts)$/i.test(filePath)) {
      results.push(filePath);
    }
  }
  return results;
}

function getInstallCommand() {
  if (fs.existsSync('pnpm-lock.yaml')) return 'pnpm install && pnpm run build';
  if (fs.existsSync('yarn.lock')) return 'yarn install && yarn run build';
  return 'npm install && npm run build';
}

async function main() {
  const safeInstruction = String(INSTRUCTION || '');
  
  if (GLOBAL_WORKER_PAT) {
    process.env.GITHUB_TOKEN = GLOBAL_WORKER_PAT;
    process.env.GH_TOKEN = GLOBAL_WORKER_PAT;
  }

  await sendTelegramUpdate(`🛠 **Lagi dikerjain nih!**\n\nRepo: \`${TARGET_REPO}\`\n\n*Instruksi:* ${safeInstruction}`);

  try {
    const workDir = path.join(process.cwd(), 'target_workspace');
    const repoUrl = `https://x-access-token:${GLOBAL_WORKER_PAT}@github.com/${TARGET_REPO}.git`;

    console.log('Cloning...');
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
    execSync(`git clone ${repoUrl} ${workDir}`);
    process.chdir(workDir);

    execSync('git config user.name "ccocoa"');
    execSync('git config user.email "270871570+ccocoa@users.noreply.github.com"');

    let iteration = 0;
    let buildStatus = { success: false, output: '' };
    let lastError = '';

    while (iteration < MAX_ITERATIONS) {
      iteration++;
      console.log(`--- Iterasi ${iteration} ---`);

      const shouldEditFirst = iteration === 1 && safeInstruction.toLowerCase() !== 'test build';
      const isHealing = iteration > 1;

      let suggestion = null;

      if (shouldEditFirst || isHealing) {
        const fileContexts = [];
        const allFiles = getFilesRecursively('.');

        for (const f of allFiles) {
          fileContexts.push({ path: f, content: fs.readFileSync(f, 'utf8') });
        }

        const statusMsg = isHealing ? `🔄 **Iterasi ${iteration}**: Bentar ya, aku coba benerin dulu errornya...` : `🎨 **Iterasi 1**: Aku terapin dulu ya instruksinya...`;
        await sendTelegramUpdate(statusMsg);

        suggestion = await getFixSuggestion(safeInstruction, lastError, fileContexts);
        await sendTelegramUpdate(`💡 **Saran dari aku**: ${suggestion.explanation}`);

        for (const change of suggestion.changes) {
          const safeRelativePath = path.normalize(change.path).replace(/^(\.\.(\/|\\|$))+/, '');
          const fullPath = path.join(process.cwd(), safeRelativePath);

          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, change.content, 'utf8');
          console.log(`Updated: ${safeRelativePath}`);
        }
      }

      if (suggestion && suggestion.needsBuild === true) {
        await sendTelegramUpdate(`🔨 Menjalankan build (Iterasi ${iteration})...`);
        buildStatus = runCommand(getInstallCommand());

        if (buildStatus.success) {
          await sendTelegramUpdate(`Hore! **Buildnya sukses** di iterasi ke-${iteration}.`);
          break;
        } else {
          lastError = buildStatus.output;
          console.error(`Build failed in iteration ${iteration}`);
          await sendTelegramUpdate(`Duh, **buildnya gagal** di iterasi ${iteration}.\n\nError:\n\`\`\`\n${lastError.substring(0, 1500)}\n\`\`\``);
        }
      } else {
        buildStatus = { success: true, output: '' };
        await sendTelegramUpdate(`📝 Perubahan dokumentasi selesai. Tidak perlu build.`);
        break;
      }
    }

    if (buildStatus.success) {
      console.log('Pushing changes...');
      execSync('git add .');
      const status = execSync('git status --porcelain', { encoding: 'utf8' });
      if (status.trim()) {
        const commitMsg = `feat: auto-fix instruction applied\n\n- Applied changes based on: ${safeInstruction}\n- Status: Build successful\n\nCo-authored-by: thirapi <132630759+thirapi@users.noreply.github.com>`;
        
        const lowInstruction = safeInstruction.toLowerCase();
        const butuhPR = lowInstruction.includes('pull request') || lowInstruction.includes('pr ') || lowInstruction.includes('branch baru');

        if (butuhPR) {
          const branchName = `auto-fix/${Date.now()}`;
          execSync(`git checkout -b ${branchName}`);
          execFileSync('git', ['commit', '-m', commitMsg]);
          execSync(`git push origin ${branchName}`);

          const prTitle = `Auto-fix: ${safeInstruction.substring(0, 60).replace(/\n/g, ' ')}...`;
          const prBody = `🤖 **Kokoa Dev Agent Report**\n\n**Original Instruction:**\n${safeInstruction}`;

          execSync(`gh pr create --title "${prTitle}" --body "${prBody}" --head ${branchName} --base main`);

          await sendTelegramUpdate(`🚀 **Branch baru** \`${branchName}\` berhasil dibuat dan Pull Request telah dikirim ke \`main\`!`);
        } else {
          execFileSync('git', ['commit', '-m', commitMsg]);
          execSync('git push origin main');
          await sendTelegramUpdate(`Beres! Perubahan udah aku push ke branch \`main\` ya.`);
        }
      } else {
        await sendTelegramUpdate(`Selesai! Kayaknya nggak ada yang perlu diubah deh.`);
      }
    } else {
      await sendTelegramUpdate(`Aduh, udah ${MAX_ITERATIONS} kali coba tapi masih gagal. Maaf ya, aku nyerah dulu buat sekarang.`);
    }

  } catch (error) {
    console.error('Fatal Error:', error);
    await sendTelegramUpdate(`Waduh, ada masalah serius nih: ${error.message}`);
    process.exit(1);
  }
}

main();