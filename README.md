# Prior CLI

[![npm version](https://img.shields.io/npm/v/prior-cli?color=00ffcc&label=prior-cli)](https://www.npmjs.com/package/prior-cli)
[![npm downloads](https://img.shields.io/npm/dw/prior-cli?color=8DE0FC)](https://www.npmjs.com/package/prior-cli)
[![license](https://img.shields.io/npm/l/prior-cli)](./LICENSE)
[![node](https://img.shields.io/node/v/prior-cli)](https://nodejs.org)

**Prior** is an agentic AI assistant for your terminal — it can write and edit code, search your
codebase, research the web, run commands, generate images, and automate Prior services. Built on
the Prior Network platform.

```
  ██████╗ ██████╗ ██╗ ██████╗ ██████╗
  ██╔══██╗██╔══██╗██║██╔═══██╗██╔══██╗
  ██████╔╝██████╔╝██║██║   ██║██████╔╝
  ██╔═══╝ ██╔══██╗██║██║   ██║██╔══██╗
  ██║     ██║  ██║██║╚██████╔╝██║  ██║
  ╚═╝     ╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝  ╚═╝
```

## Install

**Windows — no Node.js needed:** [download `prior.exe`](https://github.com/PriorNetwork/prior-cli/releases/latest/download/prior.exe) from the latest release and run it.

**Cross-platform (npm):**

```bash
npm install -g prior-cli
```

## Login

```bash
prior login
```

Opens a browser window to sign in with your Prior Network account.

## Usage

```bash
prior chat
```

Starts an interactive chat session. Prior is an agentic AI — it can read, write, and edit files, search your codebase, run shell commands, research the web, generate images, and automate Prior services, chaining tools together to finish a task from a single prompt.

## What Prior can do

| Capability | Example prompt |
|---|---|
| **Read / write files** | `read package.json` |
| **Edit code (surgical)** | `in server.js change the port to 4000` |
| **Search the codebase** | `find every place we call fetchUser` |
| **Coding** | `write a python script that prints fibonacci numbers` |
| **Shell** | `what node version am i on` |
| **Web research** | `what is the latest news in the philippines` |
| **Weather** | `what's the weather in tokyo` |
| **Image generation** | `generate a sunset over the ocean` |
| **Prior Network** | `show my prior profile` |

## Agent mode

Prior runs as an autonomous agent — it chains multiple tool calls together to complete complex tasks without you breaking them down step by step.

```
> find where generate_image is defined, then change its default steps to 25
```

Prior locates the file, searches for the code, reads it, and makes a surgical edit — all in one go.

## Attach files with `@`

Type `@` to pull a file into the conversation as context — an interactive picker appears (↑/↓ to select, Tab/Enter to insert).

```
> summarize @src/server.js and suggest improvements
```

## One-shot mode

Run a single prompt and exit — scriptable and pipe-able, no chat session.

```bash
prior run "explain what this project does"
cat error.log | prior run "what's causing this error?"
prior run --yes "in config.js bump the timeout to 30s"   # --yes auto-approves edits
```

## Slash commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/clear` | Clear the conversation |
| `/save <name>` | Save the current session |
| `/load <name>` | Load a saved session |
| `/saves` | List all saved sessions |
| `/delete <name>` | Delete a saved session |
| `/compact` | Compress the conversation to free up context |
| `/learn` | Scan the current directory into a `prior.md` project context |
| `/usage` | Show today's token usage |
| `/timer <duration>` | Start a countdown timer (e.g. `30s`, `5m`, `1m30s`) |
| `/update` | Check for updates and install if behind (works for npm and the exe) |
| `/uncensored` | Load Prior Uncensored model |
| `/censored` | Load Prior Standard model |
| `/exit` | Exit the CLI |

## Tips

- **Attach files** — type `@` for an interactive file picker that adds a file's contents as context
- **Multiline input** — end a line with `\` and press Enter to continue on the next line
- **Clipboard images** — press `Alt+V` to attach an image from your clipboard
- **Cancel** — press `Ctrl+C` to cancel a running response

## Requirements

- Node.js 16+ (npm install), **or** the standalone `prior.exe` — no Node needed
- A [Prior Network](https://priornetwork.com) account

## Maintainers

See **[guide.md](guide.md)** for the release process — versioning, publishing to npm,
building/attaching the standalone `prior.exe`, the self-updater, and the CI workflows.

## License

MIT
