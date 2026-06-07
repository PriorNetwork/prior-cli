# Prior CLI

[![npm version](https://img.shields.io/npm/v/prior-cli?color=00ffcc&label=prior-cli)](https://www.npmjs.com/package/prior-cli)
[![npm downloads](https://img.shields.io/npm/dw/prior-cli?color=8DE0FC)](https://www.npmjs.com/package/prior-cli)
[![license](https://img.shields.io/npm/l/prior-cli)](./LICENSE)
[![node](https://img.shields.io/node/v/prior-cli)](https://nodejs.org)

**Prior** is an AI assistant for your terminal — built on the Prior Network platform.

```
  ██████╗ ██████╗ ██╗ ██████╗ ██████╗
  ██╔══██╗██╔══██╗██║██╔═══██╗██╔══██╗
  ██████╔╝██████╔╝██║██║   ██║██████╔╝
  ██╔═══╝ ██╔══██╗██║██║   ██║██╔══██╗
  ██║     ██║  ██║██║╚██████╔╝██║  ██║
  ╚═╝     ╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝  ╚═╝
```

## Install

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

Starts an interactive chat session. Prior can read and write files, run shell commands, search the web, check the weather, generate images, and interact with the Prior Network — all from a single prompt.

## What Prior can do

| Capability | Example prompt |
|---|---|
| **Files** | `read the file package.json` |
| **Shell** | `what node version am i on` |
| **Web search** | `what is the latest news in the philippines` |
| **Weather** | `what's the weather in tokyo` |
| **Image generation** | `generate a sunset over the ocean` |
| **Clipboard** | `read my clipboard` |
| **Prior Network** | `show my prior profile` |
| **Coding** | `write a python script that prints fibonacci numbers` |

## Agent mode

Prior runs as an autonomous agent — it can chain multiple tool calls together to complete complex tasks without you having to break things down step by step.

```
> find all .js files in this project and tell me which one is the largest
```

Prior will list the directory, check file sizes, and report back — all in one go.

## Slash commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/clear` | Clear the conversation |
| `/save <name>` | Save the current session |
| `/load <name>` | Load a saved session |
| `/saves` | List all saved sessions |
| `/delete <name>` | Delete a saved session |
| `/timer <duration>` | Start a countdown timer (e.g. `30s`, `5m`, `1m30s`) |
| `/update` | Check for updates and install if behind |
| `/uncensored` | Load Prior Uncensored model |
| `/censored` | Load Prior Standard model |
| `/exit` | Exit the CLI |

## Tips

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
