# Claude Setup — Architecture & Contributor Contract

Claude Setup is a cross-platform (Windows / macOS / Linux) desktop app that sets up Claude:

1. **Discover & install MCP servers** from every public registry into Claude Desktop, Claude Code (terminal +
   VS Code/JetBrains extensions), VS Code native MCP, Cursor and Windsurf.
2. **Use other models** (Kimi, DeepSeek, GLM, MiniMax, Qwen, OpenRouter, Ollama, …) in Claude Code / VS Code via
   Anthropic-compatible endpoints, plus a built-in **translation proxy** for OpenAI-only providers (OpenAI, Gemini,
   Groq, Cerebras, any OpenAI-compatible server).
3. **Extensions**: plugins & marketplaces, skills, subagents, slash commands, hooks, status lines, CLAUDE.md.
4. **Doctor**: health checks with one-click fixes. **Backups** of every file before it is changed.
5. **Simple mode** (big friendly cards, wizards) and **Advanced mode** (raw JSON, scopes, env, proxy, backups).
6. **Claude Setup is itself an MCP server**, so Claude can search/install servers by asking.

## Surfaces (all share one core)

```
src/
  shared/          PURE TYPES + API CONTRACT (no Node/Electron imports). Used by everything incl. renderer.
    types.ts       domain types                     ← contract (owner: lead)
    api.ts         CoreApi / UiApi / IPC allow-list ← contract (owner: lead)
  core/            Node-only business logic. NEVER import 'electron' here.
    index.ts       createCore() facade              ← lead
    context.ts     CoreContext (state, secrets, backups, events, log) ← lead
    events.ts      typed event bus                  ← lead
    state.ts       state.json store                 ← lead
    http.ts        fetchJson/fetchText with timeouts ← lead
    fs/json.ts     readJson / writeJsonAtomic / editJsonc ← lead
    fs/backups.ts  BackupManager + BackupsApi       ← FOUNDATION
    platform/paths.ts   OS paths                    ← lead
    platform/exec.ts    run/which/fixPath/cleanEnv  ← FOUNDATION
    platform/runtimes.ts detect/install node,uv,docker,claude… ← FOUNDATION
    secrets.ts     SecretStore (DPAPI/Keychain/libsecret/file) ← FOUNDATION
    app.ts         AppApi                           ← FOUNDATION
    registry/      CatalogApi (all registries, cache, search, seed) ← REGISTRY
    targets/       TargetsApi + per-app config adapters + Desktop process control ← TARGETS
    servers/       ServersApi (install/remove/enable/copy/test) + tester ← TARGETS
    models/        ModelsApi (provider presets, profiles, apply/reset, list/test) ← MODELS
    doctor/        DoctorApi                         ← MODELS (doctor)
    proxy/         ProxyApi + Anthropic⇄OpenAI translation server ← PROXY
    extensions/    ExtensionsApi                     ← EXTENSIONS
    self/          SelfApi (register own MCP server, CLI shim) ← ENTRYPOINTS
  main/            Electron main process: window, tray, IPC dispatcher, UiApi ← ENTRYPOINTS
  preload/         contextBridge → window.api (PreloadApi) ← ENTRYPOINTS
  mcp/             stdio MCP server entry (claude-setup-mcp) ← ENTRYPOINTS
  cli/             terminal command entry (claude-setup) ← ENTRYPOINTS
  renderer/        React 19 + Tailwind 4 UI      ← UI-A (shell, design system, home, discover, installed)
                                                  ← UI-B (models, proxy, extensions, doctor, settings, backups)
bin/               node shims for npm bin entries ← ENTRYPOINTS
resources/         icons, bundled catalog seed   ← ENTRYPOINTS / REGISTRY
test/              vitest, one folder per module (test/<module>/*.test.ts)
```

Build: `electron-vite` builds `out/main/{index,mcp,cli}.js`, `out/preload/index.js`, `out/renderer/*`.
`npm run typecheck`, `npm test`, `npm run build`, `npm run dev`.

## Hard rules (every agent)

1. **Never touch the real user's config files in tests or experiments.** This dev machine has real Claude Desktop,
   Claude Code and VS Code installs. Tests MUST use `test/helpers/sandbox.ts` (`withSandbox`) which redirects
   HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG_CONFIG_HOME/CLAUDE_CONFIG_DIR/CLAUDE_SETUP_DATA_DIR to a temp dir.
   If you run the `claude` CLI for experiments, set `CLAUDE_CONFIG_DIR` to a temp dir.
2. **Do not edit files you don't own.** Contract files (`src/shared/*`, `src/core/{index,context,events,state,http}.ts`,
   `src/core/fs/json.ts`, `src/core/platform/paths.ts`, `package.json`, configs) belong to the lead. If you need a change
   (new dependency, new type field, API change), put it in your final report under "CONTRACT CHANGE REQUESTS" — and
   work around it locally meanwhile (e.g. a local type) so your code still compiles.
3. **No `console.log` in `src/core` or `src/mcp`** — stdout is the MCP JSON-RPC channel. Use `ctx.log.info(scope, msg)`.
   The CLI may print to stdout.
4. **Back up before writing any config file**: `await ctx.backups.snapshot('reason', [path1, path2])`, then write.
   Record the returned `id` in results (`backupId`).
5. **Writes are atomic** (`writeJsonAtomic` / `writeTextAtomic` / `editJsonc`). Claude files are **strict JSON**
   (no comments). VS Code-family settings are **JSONC** → use `editJsonc` to preserve comments.
6. **Preserve unknown keys** when rewriting someone else's config (read → modify → write). Never drop
   `preferences` in claude_desktop_config.json, never drop `projects` in ~/.claude.json.
7. **Server names** must match `^[A-Za-z0-9_-]{1,64}$` (Claude Desktop log file names, Claude Code rules).
8. **Secrets** never go into state.json. Store with `ctx.secrets.set(ref, value)`; keep only the `ref`.
9. **All CoreApi methods are JSON-serializable** (they cross IPC). Return `OpResult`/result objects with friendly
   `message`s instead of throwing for expected failures. Throw only for programmer errors.
10. **Spawn processes only via `run()` / `spawnDetached()`** from `platform/exec.ts` (cross-spawn, cleaned env).
11. Code style: TypeScript strict, ES modules, **no semicolons, single quotes, 2-space indent**, ~130 cols,
    small focused files, JSDoc on exported functions. Match the existing files.
12. Path aliases: `@shared/*` and `@core/*` (renderer: `@shared/*`, `@renderer/*`). Renderer must never import `@core`.
13. Keep the renderer free of Node APIs; it talks only through `window.api` (see `src/shared/api.ts` → `PreloadApi`).

## Testing & checking your work

- Tests: `npx vitest run test/<module>` (Node env). Use `withSandbox` for anything touching the filesystem/env.
  Network: unit tests must not depend on the internet — use fixtures/mocked `fetch` (`vi.stubGlobal('fetch', …)`).
  You may run optional live checks manually while developing.
- Typecheck: `npx tsc --noEmit -p tsconfig.node.json` (core/main/cli/mcp) and `-p tsconfig.web.json` (renderer).
  Other agents are working in parallel, so ignore errors in files you don't own; yours must be clean.
- TypeScript 7 (Go port) is used for typechecking; Vite/oxc builds. `baseUrl` is not allowed; use the aliases.

## Research (verified facts, 2026-10-23) — READ the ones relevant to your module

`C:\Users\Dig\AppData\Local\Temp\claude\c--Users-Dig-Downloads-wad\372edc90-5cee-44b3-81a4-ea237a9bba2f\scratchpad\research\`
- `research_desktop.md` — Claude Desktop config paths (MSIX!), schema, restart, 3P, logs, policies
- `research_code.md` — Claude Code MCP scopes, settings.json, env vars, VS Code extension settings, auth conflicts
- `research_registries.md` — official/Anthropic/GitHub/Smithery/Docker/Cline/awesome APIs, dedupe, seed
- `research_providers.md` — every third-party provider: base URLs, auth, models, list-models, connection test
- `research_proxy.md` — exact Claude Code requests + Anthropic⇄OpenAI mapping + tested reference proxy
  (`…\scratchpad\scripts\proxy.mjs`)
- `research_skills.md` — skills/agents/commands/plugins/marketplaces/hooks/statusline/output styles/CLAUDE.md
- `research_stack.md` — MCP SDK v2 server/client code, Electron 45 patterns, PATH fixing, packaging, runtimes

## Critic corrections (override the research files where they conflict) — see `research_critic.md`

- **Desktop 3P mode** is active only if `deploymentMode: "3p"` is set in the 3P profile's own
  `claude_desktop_config.json` (Windows `%LOCALAPPDATA%\Claude-3p\`, else `<userData>-3p/`) or a managed policy forces
  it. Folder existence means nothing (they exist empty on this machine). Write MCP servers to the 3P file only when 3P is
  active; always preserve `deploymentMode`.
- **Desktop logs on Windows**: `%LOCALAPPDATA%\Claude\logs` for current builds (check `%APPDATA%\Claude\logs` and the
  MSIX LocalCache logs too). Source of truth for the config path = newest `Reading claude_desktop_config.json from` line.
- **`cmd /c npx` is not needed** by Desktop 3.x or Claude Code ≥ 2.1.119. Write bare `npx`. Because `.cmd` shims run
  through cmd.exe, put values containing spaces or `& | < > ^ %` in `env`, not `args`.
- **`.mcpb` install on Windows**: run `%LOCALAPPDATA%\Microsoft\WindowsApps\claude-desktop.exe "<file>"` (one file per
  launch); no file association exists. macOS `open -a Claude <file>`, Linux `xdg-open`.
- **Claude Desktop exists for Linux** (official beta, apt repo) — not "macOS/Windows only".
- **Kimi Code** base URL: intl `https://api.kimi.ai/coding/`, China `https://api.kimi.com/coding/`, `ANTHROPIC_API_KEY`.
  Never route coding-plan keys through the proxy.
- **Do not rename models with a `claude-` prefix** in the proxy; use `modelPicker` (user settings) or
  `ANTHROPIC_DEFAULT_*_MODEL_NAME` labels.
- **`[1m]`** only for models with ≥ 1M context. For 256K models omit `[1m]` and set `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.
- `allowedMarketplaces` is a policy gate, NOT an alias of `extraKnownMarketplaces` (alias is `additionalMarketplaces`).
- `claudeCode.selectedModel` does not exist — never write it.
- Retired model IDs must not appear in presets: `kimi-k2.5`, `deepseek-chat`, `deepseek-reasoner`, `kimi-k2p5`.
  Kimi K2 series retires by end of Dec 2026 (new accounts lose access 2026-10-31) → Haiku default `kimi-k3` for safety.
- **Bedrock**: pin Sonnet and Haiku explicitly (`us.anthropic.claude-sonnet-5-5`, `us.anthropic.claude-haiku-5-5`),
  otherwise they resolve to Sonnet 4.5.
- **Windsurf** config moved: `~/.config/devin/mcp_config.json` (Windows `%APPDATA%\devin\mcp_config.json`); older builds
  used `~/.codeium/windsurf/mcp_config.json` — detect both, prefer the one that exists.
- **VS Code native MCP** alternative writer: `code --add-mcp '{"name":…,"type":"stdio",…}'` (user profile).
- **Proxy lifetime**: the proxy dies when the app quits. Offer "Start Claude Setup at login (hidden in tray)" via
  `app.setLoginItemSettings({openAtLogin, args:['--hidden']})` on Windows/macOS and a `~/.config/autostart/*.desktop` file
  on Linux.
- `mcp-remote` lives at punkpeye/mcp-remote (npm `mcp-remote@0.15.2`).

## Key product decisions

- **Third-party models only for Claude Code (CLI + VS Code extension)**. Claude Desktop deliberately rejects
  non-Claude model IDs; we do NOT disguise models. Desktop gets MCP servers only (and guidance for its official
  3P/gateway mode with Claude models).
- Model config is written to **user** `~/.claude/settings.json` `env` (all slots: ANTHROPIC_MODEL +
  ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL + CLAUDE_CODE_SUBAGENT_MODEL, exactly one credential var)
  and, for VS Code, `claudeCode.environmentVariables` + `claudeCode.disableLoginPrompt` in VS Code user settings.
  We own a fixed key set and remove it cleanly on reset.
- Show Anthropic's caveat wherever third-party models are configured: Anthropic doesn't support routing Claude Code
  to non-Claude models.
- Claude Desktop rewrites its config from memory while running → quit Desktop before writing, or warn + offer
  restart. Desktop config supports only stdio (`command` required); remote servers are bridged with `mcp-remote`.
- Claude Code MCP: write directly to `~/.claude.json` (user/local scope) or `.mcp.json` (project) with
  read-modify-atomic-write and backups (CLI `claude mcp add-json` is an optional path when available).
- Proxy listens on 127.0.0.1 only, requires the local auth token, never forwards it upstream.
- The app is **unofficial** — not affiliated with Anthropic. No Anthropic logos. Say "for Claude".
