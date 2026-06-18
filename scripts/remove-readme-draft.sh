#!/bin/bash

# 1. Buat branch baru
git checkout -b chore/remove-readme-draft-final

# 2. Hapus file
rm README_DRAFT.md
git add README_DRAFT.md

# 3. Commit perubahan
git commit -m "chore: remove redundant README_DRAFT.md\n\nCo-authored-by: thirapi <132630759+thirapi@users.noreply.github.com>"

# 4. Push branch
git push origin chore/remove-readme-draft-final

# 5. Buat Pull Request (menggunakan GitHub CLI)
gh pr create --title "Remove README_DRAFT.md" --body "Menghapus file draft yang tidak lagi diperlukan." --base main --head chore/remove-readme-draft-final