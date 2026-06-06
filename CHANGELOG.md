# Changelog

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
