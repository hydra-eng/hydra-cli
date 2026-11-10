# contributing to hydra-cli

hydra is **one file** (`hydra.mjs`) on purpose: zero dependencies, `node hydra.mjs`, it runs. Everything you add must keep that true.

## ground rules

1. **one file stays one file** — no new runtime deps, no second source file, no build step. CI runs `node --check hydra.mjs` plus a plain-mode smoke test and that is the whole pipeline.
2. **sweep before you ship** — the repo ships with the TUI driven end-to-end by scenario numbers (`HYDRA_TEST=1..27` behind an isolated `HYDRA_CFG_DIR`). Run at least the scenarios touching your change:
   ```powershell
   node --check hydra.mjs
   $env:HYDRA_CFG_DIR="$PWD\tmp-home"; $env:HYDRA_TEST="20"; node hydra.mjs
   ```
   Scenario map lives in [README → development](README.md#-development).
3. **new feature = new scenario** — if you add a trick, add the scenario number that proves it. A feature without a scenario isn't done.
4. **no secrets in code or history** — never paste real API keys, real config files, or real session transcripts into issues, commits, or scenarios. Scenario homes are disposable on purpose.
5. **style** — the file already has a house style: lowercase prose in strings, ANSI palette variables over raw colors, atomic writes over plain `writeFileSync`. Mimic what's around you.

## good first contributions

Fertile ground is labeled [`good first issue`](https://github.com/hydra-eng/hydra-cli/labels/good%20first%20issue) — usually a self-contained command, a telemetry light, or a scenario. Bigger ideas live in [discussions](https://github.com/hydra-eng/hydra-cli/discussions) first.

## commit style

Short imperative subject, no body needed: `radar: skip node_modules during fan-out scan`.

## reporting

Bugs go through the issue template — include OS, node version, and the provider/model pair. If a session felt stuck, the `~/.hydra/heartbeat.txt` tail is the diagnosis gold ([README → providers & models](README.md#%EF%B8%8F-providers--models)).

Every issue and PR gets an answer within a day (UTC). Welcome aboard.
