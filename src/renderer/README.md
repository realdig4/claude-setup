# Claude Setup — Renderer UI guide

This is the guide for everyone building pages. Read it once before writing UI, and use the
**live gallery** while you work. If something you need is missing, ask the shell owner (UI-A) instead of
building a one-off.

```
npx electron-vite dev --rendererOnly      # renderer dev server → open http://localhost:5173 in a browser (mock data)
http://localhost:5173/?gallery=1           # every component, live
http://localhost:5173/?page=discover&theme=dark&mode=advanced
```

`--rendererOnly` may still start the Electron window from a previous build — just close it, or set
`ELECTRON_RUN_AS_NODE=1` for that command so only the browser preview runs. Any plain Vite config with
`root: src/renderer`, `@vitejs/plugin-react`, `@tailwindcss/vite` and the `@shared` / `@renderer` aliases works
too (keep such configs outside `src/renderer`). Inside Electron the same UI runs against the real core
(`npm run dev`).

---

## 1. Where things live

```
src/renderer/
  index.html                 CSP: default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:
  src/main.tsx               boot: fonts, styles, cached theme, browser mock, <App/> + root error boundary
  src/App.tsx                theme sync, shell, router (animated), command palette, confirm host, toaster, onboarding
  src/styles/                theme.css (tokens), base.css (dark theme + element defaults), vendor.css (sonner)
  src/components/ui/         the design system — import everything from '@renderer/components/ui'
  src/components/layout/     AppShell, TitleBar, Sidebar, CommandPalette, ErrorBoundary, Brand
  src/lib/                   api.ts (contract — core/ui/useCoreEvent), store, hooks, nav, format, cn, color, keys, motion, theme, layers
  src/pages/                 one file per page (+ optional folder per area)
  src/mock/                  browser mock of window.api, one file per domain, + Gallery.tsx
```

**Page owners**: replace `pages/<Name>Page.tsx` (keep the default export) and put helpers in
`pages/<area>/…` (e.g. `pages/discover/ServerCard.tsx`). Extend the mock for your domain in
`mock/<domain>.ts`. Don't edit `components/ui`, `components/layout`, `lib`, `styles` or `App.tsx` — ask.

| Page id      | File                 | Label         | Notes                                                    |
| ------------ | -------------------- | ------------- | -------------------------------------------------------- |
| `home`       | `HomePage.tsx`       | Home          |                                                          |
| `discover`   | `DiscoverPage.tsx`   | Discover      | wide layout · receives `params.server` (catalog id) and `params.q` (search text) from the command palette |
| `installed`  | `InstalledPage.tsx`  | My Tools      |                                                          |
| `models`     | `ModelsPage.tsx`     | Models        |                                                          |
| `extensions` | `ExtensionsPage.tsx` | Extensions    |                                                          |
| `proxy`      | `ProxyPage.tsx`      | Proxy         | Advanced only                                            |
| `doctor`     | `DoctorPage.tsx`     | Health Check  | receives `params.run === true` → start a check right away |
| `backups`    | `BackupsPage.tsx`    | Backups       | Advanced only                                            |
| `settings`   | `SettingsPage.tsx`   | Settings      | must show "Unofficial — not affiliated with Anthropic" in an About section |

A page is a default-exported component receiving `PageProps`:

```tsx
import { Compass } from 'lucide-react'
import { PageHeader, Section } from '@renderer/components/ui'
import type { PageProps } from '@renderer/lib/nav'

export default function DiscoverPage({ params }: PageProps) {
  const serverId = typeof params.server === 'string' ? params.server : undefined
  return (
    <>
      <PageHeader icon={Compass} title="Discover" subtitle="Find tools that give Claude new abilities." />
      <div className="space-y-10">
        <Section title="Featured">…</Section>
      </div>
    </>
  )
}
```

The shell gives every page: scroll container, centered max-width (1120px, or 1320px for `wide` pages),
padding, page transition, an error boundary and a loading skeleton. **Don't add your own outer padding,
max-width or scroll container.**

---

## 2. Design principles

**Calm, warm, premium.** Paper-like neutrals, one terracotta accent, generous spacing, hairline borders,
soft shadows. Let whitespace do the work; avoid boxes inside boxes inside boxes.

**Simple mode** (default) is for people who have never edited a config file:

- Big, friendly choices (`OptionCard`), short wizards (`Stepper` in a `Dialog`), plain words.
- Say what will happen and why it matters ("Claude will be able to read files in these folders").
- Hide jargon and machinery: no JSON, env var names, scopes, paths, ports, model slot names.
  Translate: *MCP server → tool*, *target → app*, *API key/token → key*, *scope user → "everywhere"*,
  *project scope → "just this project"*.
- Pick sensible defaults so the happy path is 1–2 clicks. Put optional knobs in a `Disclosure`
  ("More options").

**Advanced mode** reveals everything: raw JSON (`CodeBlock`), scopes, env/args editors, paths
(`PathText`), proxy, backups, logs. Use `<AdvancedOnly>` / `<SimpleOnly>` or `useIsAdvanced()`.
Advanced must never be *required* to finish a common task.

**One primary action per view** (`variant="primary"`). Everything else is `outline`, `secondary` or `ghost`.
Destructive actions use `danger` and always go through `confirmAction` (with a backup mention when relevant).

**Never leave people stuck.** Every async view has loading (skeleton), empty (`EmptyState` with a next step),
and error (`ErrorState` with retry) states. Every failure message says what to do next.

---

## 3. Design tokens (Tailwind classes)

The default Tailwind color palette is **disabled** — `bg-gray-100`, `text-red-600` etc. do nothing. Use the
semantic tokens below; they switch automatically between light and dark (`<html data-theme>`), so you
almost never need `dark:` variants.

| Purpose | Classes |
| --- | --- |
| Backgrounds | `bg-canvas` (page panel) · `bg-surface` (cards, inputs) · `bg-surface-2` (hover/subtle fill) · `bg-surface-3` (pressed, tracks) · `bg-elevated` (dialogs, menus) · `bg-sidebar` |
| Text | `text-fg` (primary) · `text-fg-muted` (secondary) · `text-fg-subtle` (meta, placeholders) |
| Borders | `border-line` (hairline) · `border-line-strong` (hover / emphasis) — `divide-line` for lists |
| Accent (terracotta) | `text-accent-text` (links, accent icons) · `bg-accent-soft` + `border-accent-line` (selected) · `bg-accent-solid` + `text-accent-fg` (primary) · `bg-accent` (decorative: dots, bars, glows) · scale `accent-50…950` |
| Status | `success`, `warn`, `danger`, `info`, each with `-text`, `-soft`, `-line` (e.g. `bg-success-soft text-success-text border-success-line`); `bg-danger-solid` for destructive buttons |
| Inverse | `bg-inverse text-fg-inverse` (tooltips, selected chips) |
| Focus | `ring-ring` / `outline-ring` (the global `:focus-visible` outline already applies everywhere) |

Opacity modifiers work: `bg-surface-2/60`, `border-line/70`.

**Typography** — Inter Variable (with optical sizing) for UI, JetBrains Mono Variable for code (`font-mono`).
Body is 14px. Scale: `text-2xs` 11 · `text-xs` 12 · `text-[13px]` secondary · `text-sm` 14 body ·
`text-[15px]` lead · `text-base` 16 section titles · `text-lg/xl` · page title is `PageHeader` (26px).
Use `tabular-nums` for changing numbers.

**Radius** — `rounded-lg` controls & buttons, `rounded-xl` cards, `rounded-2xl` dialogs/hero.
**Shadows** — `shadow-xs` (cards at rest), `shadow-sm`, `shadow-md` (hover), `shadow-lg` (popovers),
`shadow-xl/2xl` (dialogs). They are theme-aware.

**Utilities** — `hero-glow` (warm radial glow), `dot-grid` (faint dotted texture), `skeleton-shimmer`,
`drag-region` / `no-drag` (window dragging), `scrollbar-none`, `focus-ring`.

Tailwind v4 is CSS-first (`styles/theme.css`, no `tailwind.config.js`). Class names must appear
**literally** in source (no `bg-${tone}`) — use lookup objects, like the components do. Container
queries are available (`@container`, `@md:grid-cols-2`) and preferred inside cards/dialogs.

---

## 4. Talking to the core

The renderer never touches Node. Everything goes through the typed client in `lib/api.ts`:

```ts
import { core, ui, useCoreEvent, errorMessage, platform } from '@renderer/lib/api'

const page = await core.catalog.search({ query: 'github', limit: 24 })   // fully typed (src/shared/api.ts)
await ui.openExternal('https://…')                                       // GUI helpers (main process)
useCoreEvent('progress', (p) => …)                                       // 'log' | 'catalog' | 'progress' | 'proxy' | 'state'
```

Data loading — use `useAsync` (`lib/hooks.ts`):

```tsx
const { data, error, loading, reload, setData } = useAsync(() => core.servers.list(), [])

if (loading && !data) return <SkeletonCard />
if (error && !data) return <ErrorState error={error} onRetry={reload} />
if (data?.length === 0) return <EmptyState icon={Blocks} title="No tools yet" description="…" actions={…} />
```

- `deps` re-run it; stale responses are ignored; data is kept while reloading (pass `{ keepPreviousData: false }`
  for detail views); `{ enabled: false }` skips until ready; `setData` for optimistic updates.
- Errors are already friendly strings (IPC prefixes stripped). For thrown errors elsewhere use
  `errorMessage(err)` or `toastError(err, 'Couldn’t install the tool')`.
- Most mutations return `OpResult` / `TargetChangeResult` (`{ ok, message, details?, backupId?, needsRestart? }`)
  instead of throwing → show them with `toastResult(result)`. If `needsRestart`, offer
  `core.targets.restartDesktop()` (Callout with a "Restart now" button).
- Long operations emit `progress` events: `const { progress, reset } = useProgress('install')`.
- Shared, cached data: `useSettings()` (`settings`, `update(patch)` optimistic) and `useTargets()`
  (`targets`, `ready`, `reload`, `byId`). After installs/removals call `refreshTargets()`.
- Secrets: send keys only to the core (`core.app.setSecret`, `ModelProfileInput.apiKey`); never keep them in
  React state longer than the form needs, never log or display them (`maskSecret()` for hints).

---

## 5. Navigation, mode and theme (`lib/store.ts`)

```ts
const navigate = useNavigate()          // navigate('discover', { server: id })  — pushes history
navigate('doctor', { run: true })       // params: string | number | boolean
const { page, params } = useRoute()
useAppStore.getState().replaceParams({ q: 'git' })   // update params without a history entry (filters)
useAppStore.getState().back()           // the title bar shows a Back button automatically
navigate(...)                           // also exported as a plain function for non-React code

const mode = useMode()                  // 'simple' | 'advanced'   (useIsAdvanced() → boolean)
useAppStore.getState().setMode('advanced')
useAppStore.getState().setTheme('dark') // 'system' | 'light' | 'dark'
useAppStore.getState().setCommandOpen(true)
```

Mode and theme are saved to the core settings (optimistic, re-synced on failure).

---

## 6. Feedback

**Toasts** (themed, bottom-right; the `<Toaster/>` is already mounted):

```ts
import { toast, toastResult, toastError } from '@renderer/components/ui'
toast.success('Added GitHub to 2 apps', { description: 'Restart Claude Desktop to use it.' })
toast.error('Couldn’t install', { description: message })
toast.promise(core.catalog.refresh({ force: true }), { loading: 'Refreshing…', success: 'Up to date', error: (e) => errorMessage(e) })
toast.success('Removed GitHub', { action: { label: 'Undo', onClick: restore } })
toastResult(await core.servers.setEnabled(name, target, false))
```

Toast for outcomes of actions; `Callout` for persistent page-level information; inline `Field` errors for forms.

**Confirm dialogs** — promise based, anywhere:

```ts
import { confirmAction } from '@renderer/components/ui'   // or const confirm = useConfirm()
if (await confirmAction({ title: 'Remove GitHub?', description: 'Claude won’t be able to use it anymore. A backup is made first.', tone: 'danger', confirmLabel: 'Remove' })) { … }

// Keep the dialog open with a spinner while the work runs (errors become a toast, dialog stays):
await confirmAction({ title: 'Restore this backup?', confirmLabel: 'Restore', onConfirm: () => core.backups.restore(id) })
```

---

## 7. Component catalog

All from `@renderer/components/ui`. Icons are lucide components (`import { Plus } from 'lucide-react'`);
props typed `IconProp` accept a lucide component **or** an element (`<Monogram …/>`). Every component
spreads unknown props onto its root element unless noted.

### Actions
| Component | Key props | Example |
| --- | --- | --- |
| `Button` | `variant` primary·secondary·outline (default)·ghost·danger·link · `size` sm·md·lg·icon·icon-sm·icon-lg · `loading` · `leftIcon` · `rightIcon` · `fullWidth` | `<Button variant="primary" leftIcon={Plus} loading={busy}>Add tool</Button>` · icon-only: `<Button size="icon" variant="ghost" aria-label="More"><Ellipsis /></Button>` |
| `Menu` | `trigger` (element) · `items` (`{ label, icon, onSelect, tone:'danger', disabled, shortcut, description }` · `{type:'separator'}` · `{type:'label', label}`) · `align` · `label` | `<Menu label="Tool actions" trigger={<Button size="icon-sm" variant="ghost" aria-label="More"><Ellipsis /></Button>} items={[…]} />` |
| `CopyButton` | `text` · `label` · children (labeled) · `toast` | `<CopyButton text={json} label="Copy config" />` |
| `ExternalLink` | `href` · `showIcon` · `tone` accent·muted | `<ExternalLink href={preset.keyUrl}>Get a key</ExternalLink>` (opens the system browser; also `openExternal(url)`) |
| `Chip` | `selected` · `count` · `icon` · `size` | filter pills (`aria-pressed`) |

### Layout & content
| Component | Key props | Notes |
| --- | --- | --- |
| `PageHeader` | `title` · `subtitle` · `icon` · `actions` · `eyebrow` · `back` · children (tabs/filters under it) | top of every page |
| `Section` | `title` · `description` · `actions` | stack with `space-y-10` |
| `Card` (+`CardHeader actions`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`) | `variant` default·muted·outline·hero · `interactive` (+`onClick` → keyboard accessible) · `selected` | `CardContent` has no top padding — add `pt-5` when there is no header |
| `CardGrid` | `minItemWidth` (px) · `gap` | auto-fill responsive grid |
| `List` / `ListItem` | `media` · `title` · `description` · `meta` · `actions` · `onClick` · `muted` · children (details) | rows for settings / installed tools / checks |
| `Table` `THead` `TBody` `TR` `TH` `TD` | `align` · `mono` | dense Advanced data |
| `KeyValue` | `items: { label, value, mono, copy, hint }[]` | details panels |
| `Stat` | `label` · `value` · `icon` · `tone` · `hint` · `onClick` | dashboard tiles |
| `Separator` | `orientation` | hairline |
| `Disclosure` | `title` · `description` · `defaultOpen` / `open`+`onOpenChange` · `variant` plain·card | "More options" |
| `Tabs` (+`TabPanel`) | `items: { value, label, icon, count, disabled }[]` · `variant` underline·pill · `idBase` | controlled; render the active panel yourself |
| `Segmented` | `options` · `size` · `fullWidth` · `aria-label` (required) | small exclusive choices |
| `Stepper` | `steps: { id, label, description }[]` · `current` · `onStepClick` · `orientation` | wizard progress |

### Forms
Wrap controls in `Field` — it wires label, hint, error, `aria-describedby`, `aria-invalid` and `required`.

```tsx
<Field label="API key" hint="Starts with sk-" error={keyError} required labelAction={<ExternalLink href={url}>Get a key</ExternalLink>}>
  <SecretInput value={key} onValueChange={setKey} placeholder="sk-…" />
</Field>
```

| Component | Key props |
| --- | --- |
| `Input` | `size` sm·md·lg · `leftIcon` · `rightSlot` · `mono` · `invalid` · `onValueChange(value)` · `containerClassName` |
| `Textarea` | `mono` · `rows` · `onValueChange` |
| `SecretInput` | like Input + show/hide + paste buttons (`allowPaste`, `revealable`); pasted keys are trimmed |
| `Select` | `options: { value, label, disabled, group }[]` · `placeholder` · `onValueChange` (styled native select) |
| `SearchInput` | `value` · `onValueChange` (debounced, default 250 ms) · `shortcut` ('/' focuses it) · `loading` · `onSubmit`; Esc clears |
| `Switch` | `checked` · `onCheckedChange` · `label` · `description` · `size` (needs `aria-label` without `label`) |
| `Checkbox` | `checked` · `onCheckedChange` · `indeterminate` · `label` · `description` |
| `OptionCard` / `OptionCardGroup` | `title` · `description` · `icon` · `checked` · `onCheckedChange` · `type` radio·checkbox · `badge` · `size` md·lg · group: `label` · `type` · `columns` (arrow keys move focus). It is a `<button>`: **no interactive children** |

### Feedback & status
| Component | Key props |
| --- | --- |
| `Badge` | `tone` neutral·accent·success·warn·danger·info · `variant` soft·outline·solid · `size` sm·md · `icon` · `dot` |
| `StatusDot` | `status` ok·warn·error·idle·busy · `pulse` · `label` (sr text; `null` if a visible label exists) |
| `Callout` | `tone` info·success·warn·danger·neutral·accent · `title` · `action` · `icon` · `onDismiss` · `role` |
| `ProgressBar` | `value` (omit → indeterminate) · `label` (required) · `tone` · `size` · `showValue` |
| `Spinner` · `LoadingState` | small inline spinner · centered spinner + label |
| `Skeleton` · `SkeletonText` · `SkeletonCard` | size skeletons with classes; match the final layout |
| `EmptyState` · `ErrorState` | `icon` · `title` · `description` · `actions` · `size` sm·md·lg · `framed` · `ErrorState error onRetry` |
| `Tooltip` | `content` · `side` · `align` · `delay`. Child must accept a ref + pointer/focus handlers (DOM element or a ui component that spreads props, e.g. `Button`, `Badge`) — wrap others in a `<span>`. Disabled buttons don't fire events: wrap them. Never put essential info only in a tooltip. |
| `toast`, `toastResult`, `toastError` | see §6 |

### Overlays
| Component | Key props |
| --- | --- |
| `Dialog` | `open` · `onOpenChange` · `title` · `description` · `icon` · `tone` · `footer` · `size` sm·md·lg·xl · `dismissible` (false while saving) · `hideClose` · `initialFocus` (or put `data-autofocus` on an element) |
| `Sheet` | right drawer below the title bar: `open` · `onOpenChange` · `title` · `description` · `media` · `headerExtra` · `footer` · `size` sm·md·lg·xl |
| `confirmAction` / `useConfirm` / `ConfirmDialog` | see §6 |

All overlays: spring animation, focus trap, Escape (topmost layer only), focus restore, inert background,
window controls stay usable. Nested overlays work (e.g. confirm inside a sheet).

### Identity
| Component | Key props |
| --- | --- |
| `Monogram` | `text` · `letters` · `color` (brand hex → readable text) · `seed` · `size` xs·sm·md·lg·xl · `shape` · `label` |
| `ServerIcon` | `src` (https/data only) · `name` · `seed` · `size` — shows a Monogram until the image loads and if it fails |
| `IconTile` | `icon` · `tone` · `size` sm·md·lg·xl |
| `Kbd` · `Shortcut` | `<Shortcut keys="mod+k" />` → ⌘K on macOS, Ctrl K elsewhere |
| `PathText` | `path` · `max` · `copy` · `reveal` (show in folder) — Advanced views |

### Motion
`FadeIn` (`delay`, `y`), `Stagger` + `StaggerItem index={i}` (capped delays), presets in `lib/motion.ts`
(`transitions`, `listItem`, `EASE_OUT`). Keep motion subtle (≤ 300 ms). Reduced motion is handled globally
(`MotionConfig reducedMotion="user"`).

### Mode gates
`<AdvancedOnly fallback?>` · `<SimpleOnly fallback?>`.

---

## 8. Hooks & helpers

| Import | What |
| --- | --- |
| `lib/hooks` | `useAsync`, `useDebounced`, `useInterval` (pauses while hidden), `useSettings`, `useTargets`, `refreshTargets`, `useProgress`, `useHotkey('mod+r', fn, { allowInInputs, allowWhenModal })`, `useCopy` / `copyText`, `useMediaQuery`, `useResolvedTheme`, `useDocumentVisible`, `useLatest`, `isMac` |
| `lib/format` | `formatNumber`, `formatCompact` (12.3K), `formatTokens` (256K / 1M), `formatBytes`, `formatDuration`, `formatRelativeTime` ("5 min ago"), `formatDateTime`, `pluralize(n, 'tool')`, `joinList`, `truncateMiddle`, `maskSecret` |
| `lib/cn` | `cn(...)` = clsx + tailwind-merge |
| `lib/color` | `initials`, `monogramPalette`, `brandPalette`, `readableTextColor`, `contrastRatio` |
| `lib/nav` | `PAGES`, `getPage`, `isPageId`, `visiblePages(mode)`, types `PageId`, `Route`, `RouteParams`, `PageProps` |
| `lib/keys` | `parseHotkey`, `matchesHotkey`, `hotkeyLabels` |

Global shortcuts already taken: **Ctrl/⌘+K** (command palette). Use `/` for "focus search" on list pages
(`SearchInput shortcut="/"`).

---

## 9. Copywriting

- Friendly, short, concrete. Sentence case ("Add to Claude", not "Add To Claude"). Contractions are fine.
- Lead with the benefit: "Let Claude read files in folders you choose."
- Buttons are verbs that say what happens: "Add tool", "Restart Claude Desktop", "Remove". Not "OK"/"Submit".
- Errors: what happened + what to do. "Docker isn’t running. Start Docker Desktop and try again."
  Never show stack traces or raw codes in Simple mode (put them in a `Disclosure` "Technical details").
- Mention safety where people worry: "A backup is made first." "Your key stays on this computer."
- Product names: Claude Desktop, Claude Code, VS Code, Cursor, Windsurf. Say "for Claude", never imply
  Anthropic made this app. Show Anthropic's caveat wherever third-party models are configured:
  "Anthropic doesn't support using Claude Code with non-Claude models — some features may not work."
- Use typographic quotes and ellipses (’ “ ” …) in UI strings.

---

## 10. Accessibility checklist

- Everything works with the keyboard; visible focus comes for free — don't remove outlines.
- Icon-only buttons have `aria-label`. Decorative icons are already `aria-hidden`.
- Use `Field` for form labels; never placeholder-only inputs.
- Don't rely on color alone: pair `StatusDot`/badges with text.
- Text tokens meet WCAG AA on every surface (verified). Don't put `text-fg-subtle` on tinted backgrounds;
  use `-text` tokens on `-soft` backgrounds.
- Headings: the page title is the `h1` (PageHeader), sections `h2`, cards `h3`.
- Announce async results with toasts; live regions are built into Spinner/LoadingState/CopyButton.
- Respect reduced motion (automatic for motion/react and the built-in animations).

---

## 11. Mock data (browser preview)

Outside Electron, `main.tsx` installs `window.api = createMockApi()` (never inside Electron — there a broken
preload shows an error screen, not fake data). The mock implements **every** method in `CORE_METHODS` with
realistic data from the research notes: ~30 real catalog servers, 5 apps (Desktop running, Claude Code &
VS Code installed, Cursor & Windsurf missing), installed servers, 7 provider presets, a doctor report with
fixable problems, extensions & marketplaces, backups and a proxy that streams log events while running.
Calls are validated against the allow-list, deep-cloned like IPC, delayed 120–380 ms, and errors use
Electron's `Error invoking remote method…` shape.

URL options: `?theme=dark|light|system` · `?mode=simple|advanced` · `?onboarded=0` · `?platform=win32|darwin|linux`
· `?latency=0|fast` · `?page=<id>` · `?gallery=1` · `?refresh=0` (skip the startup catalog refresh).
Console helpers: `window.__mock.emit('progress', { op: 'install', message: '…', pct: 50 })`,
`window.__mock.setTargetInstalled('cursor', true)`, `window.__mock.core.<ns>.<method>(…)`.

Extend your domain's file (`mock/catalog.ts`, `servers.ts` (targets + servers), `models.ts`, `proxy.ts`,
`extensions.ts`, `doctor.ts` (doctor + runtimes), `misc.ts` (app settings/secrets, backups, self)). Each file
exports an object typed as the real API interface, so the mock must stay in sync with `src/shared` — the
typecheck tells you. Keep mock files free of DOM APIs (`test/renderer/mock.test.ts` runs them in Node).

---

## 12. First-run onboarding hook

Create `pages/onboarding/index.tsx` with a default export `({ onDone }: OnboardingProps) => JSX`
(`import type { OnboardingProps } from '@renderer/pages'`). App shows it full-window (with a drag strip and
the window controls) while `settings.onboarded === false`, and `onDone()` saves `onboarded: true`.
To show it again, `update({ onboarded: false })` from Settings.

---

## 13. Gotchas

- Window dragging: the title bar is a drag region; anything interactive placed there needs `no-drag`.
- No external resources: fonts are bundled; images only via `https:` (registry icons through `ServerIcon`).
- `lib/api.ts` reads `window.api.platform` at import: never import app modules from `main.tsx` statically.
- Never import from `@core` or Node built-ins in the renderer.
- Keep IPC arguments plain JSON (no functions, Dates or class instances) — the mock enforces this.
- Path strings with backslashes in JSX attributes are literal: write `path={'C:\\Users\\…'}`, not `path="C:\\Users"`.
