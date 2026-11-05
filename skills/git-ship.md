---
name: git-ship
description: Commit, push to both remotes and verify without leaking secrets
---

# Git Ship (hydra release routine)

1. Inspect before staging: `git status`, `git diff`, `git log --oneline -5`. Stage only intended files.
2. Secrets sweep before ANY commit: `rg "pattern1|pattern2" README.md hydra.mjs` must return nothing (exit 1). Never commit tokens, keys, LAN addresses or model IDs from private providers.
3. Commit message: one line, behavior-first ("freeze fix: ..."), matches repo style.
4. Push BOTH remotes: `git push origin` and `git push backup`. Every release ships to both or it is not shipped.
5. Smoke test before claiming success: run the live binary and verify the exact expected output (for hydra-cli: a one-shot "reply with exactly: pong" must print `pong`).
6. If a push is rejected, fix the remote version, never force-push.

## Anti-patterns
- Committing debug scratch files, temp harness dirs, or screenshots inside the repo.
- Claiming "shipping" after only one remote got the push.
- Amending history while remotes already have it.
