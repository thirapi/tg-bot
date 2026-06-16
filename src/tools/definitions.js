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
    ],
  },
];
