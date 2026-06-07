# Changelog

## [1.7.14] - 2026-06-07
- **Standalone Windows executable** — `prior.exe` is now available from GitHub Releases, so users can run Prior without installing Node.js
- **Self-updating exe** — `/update` (and `prior update`) detect when running as the standalone exe and update in place by downloading the latest release, instead of going through npm

## [1.7.13] - 2026-06-07
- **`@file` autocomplete is now a real interactive picker** — ↑/↓ moves a highlighted selection, Enter/Tab inserts the path, Esc dismisses, and typing filters live (it takes over the keyboard while open so arrow keys no longer fall through to shell history)
- Lists **files and folders together, alphabetically** (was folders-only when a directory had many subfolders); selecting a folder drills into it
- **Scrolling viewport** — shows 8 rows at a time with a position counter and scrolls through every match instead of capping the list
- Fixed the dropdown overlapping the input line when the prompt sits near the bottom of the terminal (now uses scroll-safe relative cursor positioning)

## [1.7.12] - 2026-06-07
- **`@file` live autocomplete** — typing `@` now shows a dropdown of matching files/folders (dirs first, skips node_modules/dotfiles) and Tab completes the path, mirroring the slash-command menu

## [1.7.11] - 2026-06-07
- **Surgical file edits** — new `file_edit` tool with an `<edit>` SEARCH/REPLACE tag, so the agent modifies parts of a file instead of rewriting the whole thing
- **Codebase search** — new `file_search` (grep across files, returns `path:line: match`) and `file_glob` (find files by `**/*.ext` pattern) tools
- **One-shot mode** — `prior run "your prompt"` prints the answer and exits; scriptable and pipe-able (`cat file | prior run "summarize"`), with `--yes`, `--quiet`, `-m` flags
- **`@file` attachments** — reference `@path/to/file` in any prompt to inline its contents as context, no separate read step

## [1.7.10] - 2026-06-07
- Updated repository URLs to the new `PriorNetwork/prior-cli` GitHub org (repo moved)

## [1.7.9] - 2026-06-07
- `generate_image` now pre-generates its caption before queuing the render (Ollama gets killed for VRAM right after), so the description appears immediately instead of waiting on the restart cycle
- `generate_image` falls back to the Downloads folder when the working directory needs elevated permissions (e.g. `C:\Windows\System32`) instead of failing with EPERM
- Declining a tool confirmation (y/n) now reliably stops the agent — it no longer retries or rephrases the same declined action

## [1.7.8] - 2026-04-07
- Updated all backend URLs to priornetwork.com (migrated from ngrok to Cloudflare Tunnel)


## [1.7.7] - 2026-04-07
- Added GitHub repository, LICENSE file, supply chain security improvements
- Pinned all dependency versions (no more `^`)
- Added `author`, `homepage`, `bugs` fields to package.json

## [1.7.6] - 2026-04-07
- Supply chain security improvements for Socket.dev score
- Added `repository`, `author`, `homepage`, `bugs` to package.json
- Pinned all dependency versions

## [1.7.5] - 2026-04-07
- Added `generate_image` keyword hint — "generate X", "draw X", "create an image of X" now reliably triggers image generation tool

## [1.7.4] - 2026-04-06
- Removed qwen/dolphin model name mentions from CLI descriptions
- `/censored` now shows "Load Prior Standard model"
- `/uncensored` now shows "Load Prior Uncensored model"

## [1.7.3] - 2026-04-06
- Added `/update` slash command — checks npm registry and auto-installs if behind

## [1.7.2] - 2026-04-06
- Added `/delete` command to remove saved sessions
- `/saves` now shows full directory path of save files

## [1.7.1] - 2026-04-06
- Added `/saves`, `/save`, `/load` commands for session persistence
- Sessions saved to `~/.prior/saves/{username}/` as JSON

## [1.7.0] - 2026-04-06
- Session save/load system foundation

## [1.6.6] - 2026-04-05
- Added `get_time` tool — "what time is it" now calls the tool instead of guessing

## [1.6.5] - 2026-04-05
- Fixed `ssl_check` incorrectly triggering `zap_scan`
- Fixed unclosed `<tool>` tag parsing in agent response parser

## [1.6.4] - 2026-04-05
- Added keyword hint injection (`injectToolHint`) for deterministic tool routing
- Fixed `ip_lookup`, `dns_lookup`, `ssl_check` not triggering reliably

## [1.6.3] - 2026-04-05
- Added `ip_lookup`, `dns_lookup`, `ssl_check` as auto-triggered tools

## [1.6.2] - 2026-04-05
- Added `/timer` slash command with countdown and progress bar

## [1.6.1] - 2026-04-05
- Fixed spinner timer resetting to 0s when thinking label cycles
