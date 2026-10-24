# Claude Setup

**One app to set up Claude** — find and install MCP servers, use other AI models in Claude Code, add skills and
plugins, and fix problems — without editing config files by hand.

> Unofficial community tool. Not affiliated with or endorsed by Anthropic. "Claude" is a trademark of Anthropic.

## What it does

| | |
|---|---|
| **Discover MCP servers** | Searches every public catalog at once — the official MCP Registry (~49k servers), Anthropic's Claude Connectors directory, the GitHub MCP Registry, Smithery, the Docker MCP Catalog, Cline's marketplace and the awesome-mcp-servers list — merged, de-duplicated and ranked. Works offline with a bundled starter catalog. |
| **One-click install** | Installs into **Claude Desktop**, **Claude Code** (terminal + the VS Code / JetBrains extensions), **VS Code** (Copilot MCP), **Cursor** and **Windsurf / Devin Desktop**. Asks only for what the server needs (API keys, folders), checks that Node / uv / Docker are present, and can test the server before you use it. |
| **Other models** | Use Kimi, DeepSeek, GLM, MiniMax, Qwen, MiMo, OpenRouter, Ollama, LM Studio and 20+ more providers in Claude Code and its VS Code extension. Saved profiles, one-click switching, connection test, and "switch back to Claude" at any time. OpenAI, Gemini, Groq and Cerebras work through the built-in translation proxy. |
| **Extensions** | Browse and install Claude Code plugins & marketplaces, skills, subagents, slash commands, hooks, status lines, output styles and CLAUDE.md templates. |
| **Health Check** | Finds broken configs, missing runtimes, login conflicts, servers that fail to start, and offers one-click fixes. |
| **Safe by design** | Every file is backed up before it changes (restore from the Backups page). API keys are kept in the OS key store (Windows DPAPI, macOS Keychain, Linux Secret Service). |
| **Simple & Advanced** | Simple mode uses plain words, big cards and step-by-step wizards. Advanced mode shows raw JSON, scopes, env vars, the proxy and backups. |
| **Claude can use it too** | Claude Setup is itself an MCP server: register it once and ask Claude *"find me a Postgres MCP server and install it"*. |

**Note on Claude Desktop and other models:** Claude Desktop only runs Claude models (it rejects other model IDs on
purpose), so third-party models are set up for Claude Code (terminal and VS Code). MCP servers work everywhere.

## Three ways to use it

1. **Desktop app** — Windows, macOS and Linux.
2. **Terminal** — `claude-setup search github`, `claude-setup install <id> --target desktop,code`,
   `claude-setup models use <profile>`, `claude-setup doctor --fix`… (`claude-setup --help`). Install the command from
   Settings → "Terminal command".
3. **MCP server** — Settings → "Let Claude manage its own setup", or
   `claude-setup mcp register --target code,desktop`.

## Development

Requirements: Node.js 22.12+ (24 recommended), npm 11.

```bash
npm install
npx install-electron        # Electron 42+ downloads its binary on first use
npm run dev                 # app with hot reload
npm test                    # unit tests (vitest)
npm run typecheck           # TypeScript (tsc 7)
npm run build               # production build → out/
npm run dist:win            # installers → dist/ (also dist:mac, dist:linux)
npm run cli -- --help       # terminal command from the build
npm run mcp                 # MCP server (stdio) from the build
```

The renderer can be previewed in a normal browser with a mock backend — see `src/renderer/README.md`.

## Project layout

```
src/shared/     types + the CoreApi contract shared by every surface
src/core/       all logic (Node only): registry, targets, servers, models, proxy, extensions, doctor, backups…
src/main/       Electron main process (window, tray, IPC)      src/preload/  contextBridge → window.api
src/renderer/   React 19 + Tailwind 4 UI                         src/cli/      terminal command
src/mcp/        MCP server (Claude Setup as a tool for Claude)  test/         vitest suites
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the contracts and rules.

## Where files are changed

| App | File |
|---|---|
| Claude Desktop | `claude_desktop_config.json` (Windows Store installs: inside `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude`) |
| Claude Code | `~/.claude.json` (user/local scope), `.mcp.json` (project), `~/.claude/settings.json` (models, plugins, hooks) |
| VS Code | `…/Code/User/mcp.json` (MCP), `…/Code/User/settings.json` (`claudeCode.environmentVariables`) |
| Cursor / Windsurf | `~/.cursor/mcp.json`, `~/.config/devin/mcp_config.json` or `~/.codeium/windsurf/mcp_config.json` |
| Claude Setup itself | `%APPDATA%\Claude Setup` · `~/Library/Application Support/Claude Setup` · `~/.config/Claude Setup` |

## License

MIT
