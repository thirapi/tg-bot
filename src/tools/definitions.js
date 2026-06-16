export const githubTools = [
  {
    functionDeclarations: [
      {
        name: "listGitHubIssues",
        description: "Mengambil daftar issue dari repositori GitHub tertentu.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            state: {
              type: "STRING",
              description: "Status issue: 'open', 'closed', atau 'all'.",
              enum: ["open", "closed", "all"],
            },
          },
          required: ["owner", "repo"],
        },
      },
      {
        name: "getPRDiff",
        description:
          "Mengambil diff (perubahan kode) mentah dari Pull Request di GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            pull_number: { type: "NUMBER", description: "Nomor Pull Request." },
          },
          required: ["owner", "repo", "pull_number"],
        },
      },
      {
        name: "createGitHubIssue",
        description: "Membuat issue baru di repositori GitHub tertentu.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            title: { type: "STRING", description: "Judul issue." },
            body: { type: "STRING", description: "Isi atau deskripsi issue." },
            labels: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Daftar label untuk issue.",
            },
          },
          required: ["owner", "repo", "title"],
        },
      },
      {
        name: "getFileContent",
        description: "Membaca isi file mentah dari repositori GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            path: {
              type: "STRING",
              description: "Path lengkap ke file dalam repo (contoh: src/index.js).",
            },
            ref: {
              type: "STRING",
              description: "Nama branch, commit SHA, atau tag. Default ke default branch.",
            },
          },
          required: ["owner", "repo", "path"],
        },
      },
      {
        name: "createOrUpdateFile",
        description: "Membuat baru atau memperbarui file yang sudah ada di repositori GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            path: {
              type: "STRING",
              description: "Path lengkap ke file tujuan dalam repo.",
            },
            message: {
              type: "STRING",
              description: "Pesan commit.",
            },
            content: {
              type: "STRING",
              description: "Isi file teks biasa.",
            },
            sha: {
              type: "STRING",
              description: "SHA dari file yang akan diupdate (diperlukan jika memperbarui file yang sudah ada).",
            },
            branch: {
              type: "STRING",
              description: "Nama branch tujuan commit. Default ke default branch.",
            },
          },
          required: ["owner", "repo", "path", "message", "content"],
        },
      },
      {
        name: "createPullRequest",
        description: "Membuat Pull Request baru di repositori GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            title: {
              type: "STRING",
              description: "Judul Pull Request.",
            },
            head: {
              type: "STRING",
              description: "Nama branch asal perubahan (contoh: feature-branch).",
            },
            base: {
              type: "STRING",
              description: "Nama branch tujuan merge (contoh: main atau master).",
            },
            body: {
              type: "STRING",
              description: "Deskripsi isi Pull Request.",
            },
          },
          required: ["owner", "repo", "title", "head", "base"],
        },
      },
      {
        name: "mergePullRequest",
        description: "Menggabungkan (merge) Pull Request di GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            pull_number: {
              type: "NUMBER",
              description: "Nomor Pull Request.",
            },
            commit_title: {
              type: "STRING",
              description: "Judul commit merge opsional.",
            },
            merge_method: {
              type: "STRING",
              description: "Metode merge: 'merge', 'squash', atau 'rebase'. Default ke 'merge'.",
              enum: ["merge", "squash", "rebase"],
            },
          },
          required: ["owner", "repo", "pull_number"],
        },
      },
      {
        name: "addLabels",
        description: "Menambahkan label ke issue atau Pull Request.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            issue_number: {
              type: "NUMBER",
              description: "Nomor issue atau Pull Request.",
            },
            labels: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "List nama label yang ingin ditambahkan.",
            },
          },
          required: ["owner", "repo", "issue_number", "labels"],
        },
      },
      {
        name: "assignUser",
        description: "Menetapkan assignee pada issue atau Pull Request.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            issue_number: {
              type: "NUMBER",
              description: "Nomor issue atau Pull Request.",
            },
            assignees: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "List username GitHub yang akan dijadikan assignee.",
            },
          },
          required: ["owner", "repo", "issue_number", "assignees"],
        },
      },
      {
        name: "createIssueComment",
        description: "Membuat komentar baru pada issue atau Pull Request di GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: {
              type: "STRING",
              description: "Username atau organisasi pemilik repo.",
            },
            repo: { type: "STRING", description: "Nama repositori." },
            issue_number: {
              type: "NUMBER",
              description: "Nomor issue atau Pull Request.",
            },
            body: {
              type: "STRING",
              description: "Isi teks komentar.",
            },
          },
          required: ["owner", "repo", "issue_number", "body"],
        },
      },
      {
        name: "updateIssueState",
        description: "Memperbarui status atau detail issue GitHub (misal: menutup issue).",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: { type: "STRING", description: "Username pemilik repo." },
            repo: { type: "STRING", description: "Nama repositori." },
            issue_number: { type: "NUMBER", description: "Nomor issue." },
            state: {
              type: "STRING",
              description: "Status baru: 'open' atau 'closed'.",
              enum: ["open", "closed"],
            },
            title: { type: "STRING", description: "Judul baru jika ingin diubah." },
            body: { type: "STRING", description: "Deskripsi baru jika ingin diubah." },
          },
          required: ["owner", "repo", "issue_number"],
        },
      },
      {
        name: "updatePRState",
        description: "Memperbarui status atau detail Pull Request GitHub (misal: menutup PR tanpa merge).",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: { type: "STRING", description: "Username pemilik repo." },
            repo: { type: "STRING", description: "Nama repositori." },
            pull_number: { type: "NUMBER", description: "Nomor Pull Request." },
            state: {
              type: "STRING",
              description: "Status baru: 'open' atau 'closed'.",
              enum: ["open", "closed"],
            },
            title: { type: "STRING", description: "Judul baru jika ingin diubah." },
            body: { type: "STRING", description: "Deskripsi baru jika ingin diubah." },
            base: { type: "STRING", description: "Branch tujuan baru (contoh: 'main')." },
          },
          required: ["owner", "repo", "pull_number"],
        },
      },
      {
        name: "listDirectoryContents",
        description: "Melihat isi dari sebuah direktori di repositori GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: { type: "STRING", description: "Username pemilik repo." },
            repo: { type: "STRING", description: "Nama repositori." },
            path: { type: "STRING", description: "Path ke direktori (contoh: 'src/utils')." },
            ref: { type: "STRING", description: "Nama branch atau tag." },
          },
          required: ["owner", "repo", "path"],
        },
      },
      {
        name: "deleteFile",
        description: "Menghapus file dari repositori GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: { type: "STRING", description: "Username pemilik repo." },
            repo: { type: "STRING", description: "Nama repositori." },
            path: { type: "STRING", description: "Path ke file yang akan dihapus." },
            message: { type: "STRING", description: "Pesan commit penghapusan." },
            sha: { type: "STRING", description: "SHA file yang akan dihapus (didapat dari getFileContent atau listDirectoryContents)." },
            branch: { type: "STRING", description: "Nama branch." },
          },
          required: ["owner", "repo", "path", "message", "sha"],
        },
      },
      {
        name: "searchInFiles",
        description: "Mencari kode di seluruh repositori GitHub menggunakan query (seperti grep).",
        parameters: {
          type: "OBJECT",
          properties: {
            q: { type: "STRING", description: "Query pencarian (contoh: 'function login repo:owner/repo')." },
            sort: { type: "STRING", description: "Urutan: 'indexed' (default)." },
            order: { type: "STRING", description: "Order: 'desc' atau 'asc'." },
          },
          required: ["q"],
        },
      },
      {
        name: "triggerDeveloperWorkflow",
        description: "Memicu workflow pengembangan berat (bengkel kerja) di GitHub Actions untuk tugas seperti kloning repo, analisis file lokal mendalam, modifikasi kode masif, perbaikan error build/compile otomatis, hingga push dan PR. Gunakan ini jika tugas terlalu berat untuk dilakukan via API biasa atau terkena limitasi timeout.",
        parameters: {
          type: "OBJECT",
          properties: {
            target_repo: {
              type: "STRING",
              description: "Nama repositori target penuh (contoh: 'thirapi/62chan' atau 'thirapi/tg-bot').",
            },
            instruction: {
              type: "STRING",
              description: "Instruksi atau detail tugas penulisan/perbaikan kode yang harus dilakukan secara mendalam.",
            },
          },
          required: ["target_repo", "instruction"],
        },
      },
    ],
  },
];
