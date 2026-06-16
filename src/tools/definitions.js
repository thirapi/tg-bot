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
    ],
  },
];
