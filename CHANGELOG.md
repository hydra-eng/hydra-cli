# changelog

## v3.2.0 — turn receipts & save durability

- tool steps now fold into the saved reply as a `[work log]` tail, so a fresh turn or a resumed session keeps the receipts — the model stops redoing the same work every turn
- empty assistant rows no longer pollute the session file
- huge tool results get a window clip before they enter history
- context face default lowered to 24k tokens (60k starved local 65k-context models into blank replies) — `HYDRA_CTX_MAX` tunes it
- `atomicWrite` retries on antivirus/defender file locks with a direct-write fallback; a save failure announces itself instead of vanishing
- the step-budget stop note prints even when the last round carried only tool calls
- repo: live demo GIF, social preview, CI (windows + ubuntu), installer, contributing guide, issue templates, changelog

## v3.1.0 — hermes port: the agent learns

- agent-authored skills: `skill_write` writes `~/.hydra/skills/<name>/SKILL.md`, the body auto-loads when a message starts with the skill name, `skill_load` on demand
- `/learn` distills `text|url|file` into a skill; `/skills` hub scans for secrets/tamper patterns before install
- memory that survives sessions: `memory_write` → `memory.md`, per-turn lessons (`learnings.jsonl`) riding in the system prompt
- sandbox y/n gating for risky tool commands (`/sandbox ask|strict|open`), auto-deny headless, `skills_safe` write-approval gate
- persistent deep terminal: `cd`/env/venv survive between bash tool calls
- plain sessions get the hermes commands too

## v2.9.x series

- **v2.9.0** — sessions UI, palettes (`/theme`), full-text search, `/fork`, custom-API provider discovery, exports, timeouts
- **v2.9.1** — one-step paste-key connect (`/key`), vendor auto-detect, auto model pick
- **v2.9.2** — `/model` refetches per provider (stale list no longer blocks qwen), gemini key shape, id prefix strip
- **v2.9.3** — `/undo` `/regen` `/web` `/stats`, quote-proof model ids, failed turns keep the question
- **v2.9.4** — bash tool no longer blocks the event loop (esc interrupts, `HYDRA_TOOL_TIMEOUT`, saves between tool steps), stale popup protection, instant model popup
- **v2.9.5** — renames no longer hard-delete the superseded session — `.trash` + `u` undo

## v3.0.0 — production hardening

- fully non-blocking UI: async clipboard with caps, no per-frame config reads, render backpressure guard
- atomic session saves (temp file + rename), event-loop lag heartbeat (`~/.hydra/heartbeat.txt`), crash log diagnostics

## milestone trail between 3.0 and 3.2 (chronological)

- try/verify hardening: keypress/mouse-handler throws no longer kill a running turn; transient stream errors retry up to twice (esc/timed-out never retry); exit restores the `1002` mouse mode
- work LED — pulsing footer dot reads busy-vs-idle at a glance
- radar freeze kill — the fan-out scan became an iterative BFS that yields between dirs and caps its budget
- mid-stream timeout fix — the killer watches stream **idle** (re-armed per chunk), not total wall clock; local/never-stop providers can no longer be silenced mid-sentence (`HYDRA_MODEL_IDLE`)
- chat markdown rendering — aligned table boxes, headings, lists, fences, inline styles; never-stop mode for local/ollama/qwen-family endpoints
- browser-style copy — persistent drag-paint selection, ctrl+shift+c, alt+c whole-reply, orng theme (new default), 3-col content indent
- copy/paste overhaul — bracketed paste, viewport copy map, double-click paragraph grab, clipboard ANSI strip
- session/turn durability — full history kept forever (file-side caps removed), tool-output window trim, `MAX_STEPS` 100 (`HYDRA_MAX_STEPS`), drag button-motion tracking requested on enter, scenarios 19–20
- TUI facelift & repair — boxed composer, queue crown, log flash-in, toast cards, ctrl+a/ctrl+c clipboard, aligned box seams, ANSI-safe wrap, riffled rail (22) with the todo checklist
- agentic toolbox rounds — context governance (`ctrl+p` `/ctx` `/purge` `/time`), permission zones (`.agentrules`), macros (`ctrl+r`), radar fan-out, lane B, ghost-write, diagnostic cards + `/fix`, telemetry

## v2.9.0 → earlier

see the git tags: the sessions/palettes/search/provider line was the pre-3.0 core.
