import { execSync } from 'child_process';
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
    return {
      success: true,
      output: execSync(command, { encoding: 'utf8', stdio: 'pipe' })
    };
  } catch (error) {
    return {
      success: false,
      output: error.stdout + error.stderr
    };
  }
}

function getFilesRecursively(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getFilesRecursively(filePath));
    } else {
      if (/\.(js|ts|jsx|tsx|json|jsonc|css|scss|md)$/i.test(filePath)) {
        results.push(filePath);
      }
    }
  }
  return results;
}

async function main() {
  await sendTelegramUpdate(`🛠 **Bengkel Kerja Dimulai**\n\nRepo: \`${TARGET_REPO}\`\n\n*Instruksi:* ${INSTRUCTION}`);

  try {
    const workDir = path.join(process.cwd(), 'target_workspace');
    const repoUrl = `https://x-access-token:${GLOBAL_WORKER_PAT}@github.com/${TARGET_REPO}.git`;

    console.log('Cloning...');
    execSync(`git clone ${repoUrl} ${workDir}`);
    process.chdir(workDir);

    execSync('git config user.name "Kokoa Bengkel Bot"');
    execSync('git config user.email "bot@kokoa.dev"');

    let iteration = 0;
    let buildStatus = { success: false, output: '' };

    while (iteration < MAX_ITERATIONS) {
      iteration++;
      console.log(`--- Iterasi ${iteration} ---`);
      
      await sendTelegramUpdate(`🔄 **Iterasi ${iteration}/${MAX_ITERATIONS}**: Mencoba melakukan build...`);

      buildStatus = runCommand('npm install && npm run build');

      if (buildStatus.success) {
        await sendTelegramUpdate(`✅ **Build Sukses!** pada iterasi ke-${iteration}.`);
        break;
      }

      await sendTelegramUpdate(`❌ **Build Gagal**. Menghubungi Gemini untuk mencari solusi...`);
      
      const fileContexts = [];
      const files = getFilesRecursively('src');
      for (const f of files) {
        fileContexts.push({ path: f, content: fs.readFileSync(f, 'utf8') });
      }

      const suggestion = await getFixSuggestion(INSTRUCTION, buildStatus.output, fileContexts);
      
      await sendTelegramUpdate(`💡 **Saran Gemini**: ${suggestion.explanation}\n\nMenerapkan perubahan...`);

      for (const change of suggestion.changes) {
        fs.mkdirSync(path.dirname(change.path), { recursive: true });
        fs.writeFileSync(change.path, change.content);
        console.log(`Updated: ${change.path}`);
      }
    }

    if (buildStatus.success) {
      console.log('Pushing changes...');
      execSync('git add .');
      execSync(`git commit -m "chore: auto-fix build based on Gemini suggestions\n\nOriginal Instruction: ${INSTRUCTION}"`);
      execSync('git push origin main');

      await sendTelegramUpdate(`🚀 **Tugas Selesai!** Perubahan telah di-push ke branch \`main\`.`);
    } else {
      await sendTelegramUpdate(`⚠️ **Batas Iterasi Tercapai**. Build masih gagal setelah ${MAX_ITERATIONS} percobaan. Mohon periksa log secara manual.`);
    }

  } catch (error) {
    console.error('Fatal Error:', error);
    await sendTelegramUpdate(`🚨 **Fatal Error**: ${error.message}`);
    process.exit(1);
  }
}

main();
