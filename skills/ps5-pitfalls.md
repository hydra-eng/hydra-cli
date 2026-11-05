---
name: ps5-pitfalls
description: PowerShell 5.1 traps and safe command patterns for hydra's bash tool
---

# PowerShell 5.1 Pitfalls (Windows)

Rules to keep tool commands from failing or hanging on Windows PowerShell 5.1:

1. No `?:` ternary (does not exist in PS 5.1) - use `if ($?) { }` chains.
2. No `&&` or `||` between native commands - use `cmd1; if ($?) { cmd2 }`.
3. Avoid apostrophes inside single-quoted strings; prefer double quotes when the string needs interpolation.
4. `Set-Content` in PS 5.1 writes a BOM - use `-Encoding utf8` consciously or accept the BOM.
5. `Get-Content` cannot mix `-Raw` with `-TotalCount`; pick one.
6. Inline `node -e "js"` quoting breaks constantly on Windows - write a temp .mjs file and run it instead.
7. `rg` (ripgrep) errors out on `\x` escapes or unbalanced patterns - fall back to Select-String.
8. Long-running or blocking external processes: prefer explicit timeouts; hydra kills a bash tool call after `HYDRA_TOOL_TIMEOUT` (default 300 s).
9. Environment variables: `$env:NAME` for reading, `$env:NAME = "value"` for the process only (not persisted).
10. Paths with spaces must be double-quoted; use the call operator `& "C:\path with spaces\tool.exe" args`.

## Decision rules
- Text manipulation of files? Prefer the hydra read/write/edit tools over shell pipelines.
- Anything destructive (rm -rf family)? Hydra's sandbox asks y/n first; run none of it inside a retry loop.
- Installing software? Never silently - surface the command to the user instead.
