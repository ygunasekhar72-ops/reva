---
name: commit
description: Create a clean, well-scoped git commit for the current changes.
version: 1.0.0
when-to-use: When the user asks to commit, save progress, or checkpoint their work with git.
allowed-tools: exec, read, list, grep
---

# Commit skill

1. Run `git status --porcelain` and `git diff --stat` to understand what changed.
2. If there are no changes, say so and stop.
3. Review the diff (`git diff`) enough to write an accurate message. Never commit secrets (.env, keys, tokens) — if you see one, warn the user and stop.
4. Stage only files relevant to the change (`git add <paths>` — avoid `git add -A` unless the user asked for it).
5. Write a commit message:
   - subject line ≤ 72 chars, imperative mood ("add rate limiter", not "added")
   - body (optional) explaining why, wrapped at 72 chars
6. Commit with a heredoc so quoting is safe:
   git commit -m "$(cat <<'EOF'
   <subject>

   <body>
   EOF
   )"
7. Report the new commit hash. Never push unless the user explicitly asked.
