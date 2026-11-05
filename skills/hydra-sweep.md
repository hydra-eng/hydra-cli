---
name: hydra-sweep
description: How hydra's own regression sweep works and how to extend it
---

# Hydra Regression Sweep

- The sweep drives the REAL `hydra.mjs` source: `node drive.mjs` reassembles `hydra_test.mjs` (prelude stubs stdout, captures everything into `screen.log`).
- `sweep284.ps1` runs scenarios S1-S14 (skip 9 = screenshots), each in an isolated `home` config dir: rebuild, seed sessions, run, then assert strings in `screen.log`.
- Scenario scripts live INSIDE hydra.mjs at the bottom (`process.env.HYDRA_TEST === "N"` blocks) - they replay a key script against the TUI.

## Adding a scenario
1. Add a `HYDRA_TEST` block with a mock `/v1` HTTP server (127.0.0.1:708X, unique port per scenario) so no network is touched.
2. Script key sends with `setTimeout`: type chars with delays (approx 40-60 ms/char), send `{ name: "return" }` to submit.
3. Add the row to `sweep284.ps1`: `$asserts` map (exact strings that MUST appear in screen.log) and add the scenario number to the loop list.
4. Assert state changes on disk only through the isolated `home` dir (`home\config.json`, `home\sessions\*.json`). The sweep FAILS if the real `~/.hydra` store changes.
5. Keep the whole run under ~30 s; exit with `process.exit(0)` at the end.

## Anti-patterns
- Asserting on ANSI codes or timing races; assert on stable strings.
- Making the sweep depend on real providers or the internet.
