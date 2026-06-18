#!/bin/bash
git checkout -b chore/remove-readme-draft
rm README_DRAFT.md
git add README_DRAFT.md
git commit -m "chore: remove redundant README_DRAFT.md

Co-authored-by: thirapi <132630759+thirapi@users.noreply.github.com>"
git push origin chore/remove-readme-draft
# PR creation via GitHub CLI or API would follow