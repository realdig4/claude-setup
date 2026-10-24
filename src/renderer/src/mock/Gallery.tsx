/**
 * Live component gallery (browser preview only): open the dev server with ?gallery=1.
 * Every design-system component in one place — useful for page authors and for visual QA.
 */
import { useState } from 'react'
import {
  Activity,
  Blocks,
  BrainCircuit,
  Copy,
  Download,
  Ellipsis,
  FolderOpen,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Wrench
} from 'lucide-react'
import {
  AdvancedOnly,
  Badge,
  Button,
  Callout,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardGrid,
  CardHeader,
  CardTitle,
  Checkbox,
  Chip,
  CodeBlock,
  CopyButton,
  Dialog,
  Disclosure,
  EmptyState,
  ErrorState,
  ExternalLink,
  FadeIn,
  Field,
  IconTile,
  Input,
  Kbd,
  KeyValue,
  List,
  ListItem,
  LoadingState,
  Menu,
  Monogram,
  OptionCard,
  OptionCardGroup,
  PageHeader,
  PathText,
  ProgressBar,
  SearchInput,
  SecretInput,
  Section,
  Segmented,
  Select,
  ServerIcon,
  Sheet,
  Shortcut,
  SimpleOnly,
  Skeleton,
  SkeletonCard,
  Spinner,
  Stagger,
  StaggerItem,
  Stat,
  StatusDot,
  Stepper,
  Switch,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  Tabs,
  Textarea,
  Tooltip,
  confirmAction,
  toast,
  toastResult,
  type ButtonVariant,
  type Tone
} from '../components/ui'
import { ErrorBoundary } from '../components/layout/ErrorBoundary'
import { useAppStore } from '../lib/store'

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'outline', 'ghost', 'danger', 'link']
const TONES: Tone[] = ['neutral', 'accent', 'success', 'warn', 'danger', 'info']

/** Throws while rendering — used to preview the error boundary. */
function Crash(): never {
  throw new Error('Simulated render error (gallery crash test)')
}

const SAMPLE_CONFIG = {
  mcpServers: {
    github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } },
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\you\\Projects'], enabled: true, retries: 3 }
  }
}

/** The gallery page content (rendered inside the normal app shell). */
export default function Gallery() {
  const [tab, setTab] = useState('all')
  const [pill, setPill] = useState('week')
  const [seg, setSeg] = useState<'simple' | 'advanced'>('simple')
  const [apps, setApps] = useState({ desktop: true, code: true, vscode: false })
  const [provider, setProvider] = useState('kimi')
  const [on, setOn] = useState(true)
  const [check, setCheck] = useState(true)
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [region, setRegion] = useState('intl')
  const [dialog, setDialog] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [loading, setLoading] = useState(false)
  const [chip, setChip] = useState('all')
  const [crash, setCrash] = useState(false)
  const setCommandOpen = useAppStore((s) => s.setCommandOpen)

  return (
    <div className="space-y-12">
      <PageHeader
        icon={Sparkles}
        eyebrow="Design system"
        title="Component gallery"
        subtitle="Everything page authors can use, in both themes. Toggle Simple/Advanced and the theme in the sidebar."
        actions={
          <>
            <Button leftIcon={Search} onClick={() => setCommandOpen(true)}>
              Command palette
            </Button>
            <Button variant="primary" leftIcon={Plus} onClick={() => setDialog(true)}>
              Open dialog
            </Button>
          </>
        }
      >
        <Tabs
          value={tab}
          onValueChange={setTab}
          aria-label="Gallery sections"
          items={[
            { value: 'all', label: 'All', count: 42 },
            { value: 'inputs', label: 'Inputs', icon: Pencil },
            { value: 'feedback', label: 'Feedback', icon: Activity, count: 7 },
            { value: 'disabled', label: 'Disabled', disabled: true }
          ]}
        />
      </PageHeader>

      <Section title="Buttons" description="One primary action per view. Icons via leftIcon / rightIcon.">
        <div className="flex flex-col gap-4">
          {(['lg', 'md', 'sm'] as const).map((size) => (
            <div key={size} className="flex flex-wrap items-center gap-2">
              {VARIANTS.map((variant) => (
                <Button key={variant} variant={variant} size={size} leftIcon={variant === 'primary' ? Plus : undefined}>
                  {variant[0]?.toUpperCase() + variant.slice(1)}
                </Button>
              ))}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" loading={loading} onClick={() => { setLoading(true); window.setTimeout(() => setLoading(false), 1800) }}>
              {loading ? 'Installing…' : 'Install (click me)'}
            </Button>
            <Button disabled>Disabled</Button>
            <Tooltip content="Refresh the list">
              <Button size="icon" variant="outline" aria-label="Refresh">
                <RefreshCw />
              </Button>
            </Tooltip>
            <Tooltip content="More actions" side="bottom">
              <Button size="icon-sm" variant="ghost" aria-label="More actions">
                <Ellipsis />
              </Button>
            </Tooltip>
            <Menu
              label="Tool actions"
              trigger={
                <Button variant="outline" rightIcon={Ellipsis}>
                  Menu
                </Button>
              }
              items={[
                { type: 'label', label: 'GitHub' },
                { label: 'Test connection', icon: Activity, onSelect: () => toast.success('Connected — 8 tools available') },
                { label: 'Copy config', icon: Copy, shortcut: 'mod+c', onSelect: () => toast('Copied') },
                { label: 'Open config file', icon: FolderOpen, description: 'Shows it in File Explorer', onSelect: () => {} },
                { type: 'separator' },
                { label: 'Turn off', icon: Power, onSelect: () => {} },
                {
                  label: 'Remove',
                  icon: Trash2,
                  tone: 'danger',
                  onSelect: () => void confirmAction({ title: 'Remove GitHub?', description: 'Claude will no longer be able to use it.', tone: 'danger', confirmLabel: 'Remove' })
                }
              ]}
            />
          </div>
        </div>
      </Section>

      <Section title="Badges, status & keys">
        <div className="flex flex-col gap-3">
          {(['soft', 'outline', 'solid'] as const).map((variant) => (
            <div key={variant} className="flex flex-wrap items-center gap-2">
              {TONES.map((tone) => (
                <Badge key={tone} tone={tone} variant={variant} dot={variant === 'soft'}>
                  {tone}
                </Badge>
              ))}
              <Badge tone="accent" size="sm" variant={variant}>
                small
              </Badge>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-5 text-[13px] text-fg-muted">
            {(['ok', 'warn', 'error', 'idle', 'busy'] as const).map((s) => (
              <span key={s} className="flex items-center gap-2">
                <StatusDot status={s} label={null} /> {s}
              </span>
            ))}
            <span className="flex items-center gap-2">
              <Spinner size="xs" /> <Spinner size="sm" /> <Spinner size="md" />
            </span>
            <span className="flex items-center gap-2">
              <Shortcut keys="mod+k" /> <Kbd>Esc</Kbd> <Shortcut keys="shift+/" />
            </span>
          </div>
        </div>
      </Section>

      <Section title="Forms" description="Field wires label, hint and error to the control automatically.">
        <Card>
          <CardContent className="grid gap-5 pt-5 md:grid-cols-2">
            <Field label="Tool name" hint="Letters, numbers, - and _ only." required>
              <Input placeholder="my-tool" value={name} onValueChange={setName} />
            </Field>
            <Field label="API key" labelAction={<ExternalLink href="https://platform.kimi.ai/console/api-keys">Get a key</ExternalLink>} error={name === 'bad' ? 'That key was rejected.' : undefined}>
              <SecretInput placeholder="sk-…" />
            </Field>
            <Field label="Region" optional>
              <Select
                value={region}
                onValueChange={setRegion}
                options={[
                  { value: 'intl', label: 'International' },
                  { value: 'cn', label: 'China' }
                ]}
              />
            </Field>
            <Field label="Search">
              <SearchInput value={query} onValueChange={setQuery} placeholder="Search tools…" shortcut="/" />
            </Field>
            <Field label="Raw JSON" className="md:col-span-2" hint="Advanced users can paste a config here.">
              <Textarea mono rows={4} defaultValue={JSON.stringify(SAMPLE_CONFIG.mcpServers.github, null, 2)} />
            </Field>
            <Switch checked={on} onCheckedChange={setOn} label="Restart Claude Desktop automatically" description="Applies new tools right away." />
            <div className="flex flex-col gap-3">
              <Checkbox checked={check} onCheckedChange={setCheck} label="Also add to VS Code" description="Uses the same settings." />
              <Checkbox checked={false} indeterminate label="Some apps selected" />
            </div>
            <div className="flex flex-wrap items-center gap-3 md:col-span-2">
              <Segmented aria-label="Mode" value={seg} onValueChange={setSeg} options={[{ value: 'simple', label: 'Simple' }, { value: 'advanced', label: 'Advanced' }]} />
              <Tabs
                variant="pill"
                value={pill}
                onValueChange={setPill}
                aria-label="Range"
                items={[
                  { value: 'day', label: 'Day' },
                  { value: 'week', label: 'Week' },
                  { value: 'month', label: 'Month' }
                ]}
              />
              <div className="flex flex-wrap gap-2">
                {[
                  ['all', 'All', 29],
                  ['dev', 'Developer tools', 9],
                  ['db', 'Databases', 4],
                  ['search', 'Search', 3]
                ].map(([id, label, count]) => (
                  <Chip key={id as string} selected={chip === id} count={count as number} onClick={() => setChip(id as string)}>
                    {label}
                  </Chip>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section title="Option cards" description="Big friendly choices for Simple mode.">
        <OptionCardGroup label="Apps" type="checkbox" columns={3}>
          <OptionCard
            type="checkbox"
            icon={<Monogram text="Claude Desktop" letters="CD" color="#D97757" />}
            title="Claude Desktop"
            description="The Claude chat app."
            badge={<Badge tone="success" size="sm">Running</Badge>}
            checked={apps.desktop}
            onCheckedChange={(v) => setApps((a) => ({ ...a, desktop: v }))}
          />
          <OptionCard
            type="checkbox"
            icon={<Monogram text="Claude Code" letters="CC" color="#2B2724" />}
            title="Claude Code"
            description="Terminal and VS Code extension."
            checked={apps.code}
            onCheckedChange={(v) => setApps((a) => ({ ...a, code: v }))}
          />
          <OptionCard
            type="checkbox"
            icon={<Monogram text="VS Code" color="#2F80ED" />}
            title="VS Code"
            description="Copilot agent mode."
            checked={apps.vscode}
            onCheckedChange={(v) => setApps((a) => ({ ...a, vscode: v }))}
          />
        </OptionCardGroup>
        <OptionCardGroup label="Provider" columns={2}>
          {[
            ['kimi', 'Kimi', 'K', '#16191E', 'Kimi K3, 1M context. Pay as you go.'],
            ['deepseek', 'DeepSeek', 'DS', '#4D6BFE', 'Very low cost. Off-peak is half price.']
          ].map(([id, title, letters, color, description]) => (
            <OptionCard
              key={id}
              size="lg"
              icon={<Monogram text={title as string} letters={letters} color={color} size="lg" />}
              title={title}
              description={description}
              badge={id === 'kimi' ? <Badge tone="accent" size="sm">Popular</Badge> : undefined}
              checked={provider === id}
              onCheckedChange={() => setProvider(id as string)}
            />
          ))}
        </OptionCardGroup>
      </Section>

      <Section title="Cards & stats">
        <div className="grid gap-4 md:grid-cols-4">
          <Stat icon={Blocks} label="Tools installed" value={8} hint="across 3 apps" onClick={() => {}} />
          <Stat icon={BrainCircuit} label="Model" value="Claude" hint="default" tone="info" />
          <Stat icon={Activity} label="Health" value="2 issues" hint="1 can be fixed" tone="warn" />
          <Stat icon={Wrench} label="Extensions" value={3} tone="success" />
        </div>
        <CardGrid minItemWidth={300}>
          <Card variant="hero">
            <CardHeader actions={<Badge tone="accent">New</Badge>}>
              <CardTitle>Give Claude new abilities</CardTitle>
              <CardDescription>Browse 57,000+ tools and add them in two clicks.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="primary" rightIcon={Sparkles}>
                Start here
              </Button>
            </CardContent>
          </Card>
          <Card interactive onClick={() => toast('Card clicked')}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <ServerIcon src="https://github.com/github.png?size=96" name="GitHub" size="lg" />
                <div>
                  <CardTitle>GitHub</CardTitle>
                  <CardDescription>Repos, issues and pull requests</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardFooter>
              <Badge tone="success" dot>
                Installed
              </Badge>
              <span className="ml-auto text-xs text-fg-subtle">Interactive card</span>
            </CardFooter>
          </Card>
          <Card variant="muted">
            <CardHeader>
              <CardTitle>Muted card</CardTitle>
              <CardDescription>Secondary information without elevation.</CardDescription>
            </CardHeader>
          </Card>
        </CardGrid>
      </Section>

      <Section title="Messages">
        <div className="grid gap-3">
          <Callout tone="info" title="Tip">Tools run on your computer — nothing is uploaded.</Callout>
          <Callout tone="success" title="All set">GitHub was added to Claude Code.</Callout>
          <Callout tone="warn" title="Restart needed" action={<Button size="sm" leftIcon={RotateCw}>Restart now</Button>}>
            Claude Desktop loads new tools when it starts.
          </Callout>
          <Callout tone="danger" title="Couldn’t start the tool" onDismiss={() => {}}>
            npx exited with code 1. Check your internet connection and try again.
          </Callout>
          <Callout tone="accent">
            <SimpleOnly fallback="Advanced mode: raw JSON is shown below.">Simple mode: we hide the technical details.</SimpleOnly>
          </Callout>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => toast.success('Added GitHub to 2 apps', { description: 'Restart Claude Desktop to use it.' })}>Success toast</Button>
            <Button onClick={() => toast.error('Couldn’t install', { description: 'Docker isn’t running.' })}>Error toast</Button>
            <Button onClick={() => toast.info('Catalog updated')}>Info toast</Button>
            <Button onClick={() => toastResult({ ok: false, message: 'Fill in BRAVE_API_KEY first.' })}>toastResult()</Button>
            <Button onClick={() => toast.success('Removed GitHub', { action: { label: 'Undo', onClick: () => {} } })}>With action</Button>
          </div>
        </div>
      </Section>

      <Section title="Data display">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="space-y-5 pt-5">
              <KeyValue
                items={[
                  { label: 'Version', value: '2.1.309' },
                  { label: 'Config file', value: 'C:\\Users\\you\\.claude.json', mono: true, copy: 'C:\\Users\\you\\.claude.json' },
                  { label: 'Scope', value: <Badge size="sm">User</Badge>, hint: 'Available in every project' }
                ]}
              />
              <ProgressBar label="Installing" value={64} showValue />
              <ProgressBar label="Refreshing" />
              <Stepper
                steps={[
                  { id: 'apps', label: 'Choose apps' },
                  { id: 'setup', label: 'Settings' },
                  { id: 'done', label: 'Done' }
                ]}
                current={1}
              />
            </CardContent>
          </Card>
          <div className="space-y-4">
            <CodeBlock title="claude_desktop_config.json" code={SAMPLE_CONFIG} maxHeight={220} />
            <AdvancedOnly fallback={<CodeBlock code="$ claude mcp add --transport http notion https://mcp.notion.com/mcp" language="shell" />}>
              <CodeBlock code={'# Advanced only\n$ claude mcp list'} language="shell" />
            </AdvancedOnly>
          </div>
        </div>
      </Section>

      <Section title="Lists & tables" description="Rows for settings and installed tools; tables for dense Advanced data.">
        <div className="grid gap-4 lg:grid-cols-2">
          <List aria-label="Installed tools" header="Claude Code · user">
            <ListItem
              media={<ServerIcon src="https://github.com/github.png?size=96" name="GitHub" />}
              title="GitHub"
              description="Remote · api.githubcopilot.com"
              meta="3 days ago"
              actions={<Switch checked={on} onCheckedChange={setOn} aria-label="Enable GitHub" size="sm" />}
            />
            <ListItem media={<Monogram text="Context7" />} title="Context7" description="Remote · mcp.context7.com" onClick={() => toast('Row clicked')} />
            <ListItem media={<Monogram text="Memory" />} title="Memory" description="Turned off" muted actions={<Badge size="sm">Off</Badge>} />
          </List>
          <div className="space-y-4">
            <Table>
              <THead>
                <TR>
                  <TH>Time</TH>
                  <TH>Route</TH>
                  <TH align="right">Status</TH>
                  <TH align="right">ms</TH>
                </TR>
              </THead>
              <TBody>
                {[
                  ['21:41:07', 'groq/openai/gpt-oss-120b', 200, 1840],
                  ['21:40:52', 'groq/openai/gpt-oss-20b', 200, 402],
                  ['21:40:31', 'groq/openai/gpt-oss-120b', 429, 312]
                ].map(([t, route, status, ms]) => (
                  <TR key={t as string}>
                    <TD className="text-fg-muted tabular-nums">{t}</TD>
                    <TD mono>{route}</TD>
                    <TD align="right">
                      <Badge size="sm" tone={status === 200 ? 'success' : 'warn'}>
                        {status}
                      </Badge>
                    </TD>
                    <TD align="right">{ms}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Card>
              <CardContent className="space-y-2 pt-5">
                <PathText path={String.raw`C:\Users\you\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`} copy reveal />
                <PathText path={String.raw`C:\Users\you\.claude.json`} copy />
              </CardContent>
            </Card>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <ErrorState size="sm" error="Couldn’t reach the registry. Check your internet connection." onRetry={() => toast('Retrying…')} />
          </Card>
          <Card>
            <LoadingState size="sm" label="Checking your apps…" />
          </Card>
        </div>
      </Section>

      <Section title="Avatars & icons">
        <div className="flex flex-wrap items-end gap-3">
          {(['xs', 'sm', 'md', 'lg', 'xl'] as const).map((size) => (
            <Monogram key={size} text="Brave Search" size={size} />
          ))}
          {['Filesystem', 'Postgres', 'Obsidian', 'Home Assistant', 'Kubernetes', 'Time'].map((n) => (
            <Monogram key={n} text={n} />
          ))}
          <ServerIcon src="https://github.com/microsoft.png?size=96" name="Playwright" />
          <ServerIcon src="https://invalid.example/broken.png" name="Broken Icon" />
          {(['neutral', 'accent', 'success', 'warn', 'danger', 'info'] as const).map((tone) => (
            <IconTile key={tone} icon={Settings} tone={tone} />
          ))}
        </div>
      </Section>

      <Section title="Loading & empty">
        <div className="grid gap-4 md:grid-cols-3">
          <SkeletonCard />
          <Card>
            <CardContent className="space-y-3 pt-5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-4/5" />
            </CardContent>
          </Card>
          <Card>
            <EmptyState size="sm" icon={Download} title="No tools yet" description="Add your first tool from Discover." actions={<Button size="sm" variant="primary">Browse</Button>} />
          </Card>
        </div>
        <Disclosure title="Advanced options" description="Arguments, environment and scope" variant="card">
          <p className="text-sm text-fg-muted">Hidden by default in Simple mode — power users open it.</p>
        </Disclosure>
      </Section>

      <Section title="Motion">
        <Stagger className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <StaggerItem key={i} index={i}>
              <div className="rounded-xl border border-line bg-surface p-4 text-sm shadow-xs">Item {i + 1}</div>
            </StaggerItem>
          ))}
        </Stagger>
        <FadeIn delay={0.2}>
          <p className="text-sm text-fg-muted">FadeIn with a small delay.</p>
        </FadeIn>
        <div className="flex gap-2">
          <Button onClick={() => setSheet(true)}>Open sheet</Button>
          <Button
            variant="danger"
            leftIcon={Trash2}
            onClick={() =>
              void confirmAction({
                title: 'Delete this backup?',
                description: 'You won’t be able to restore these files from it.',
                tone: 'danger',
                confirmLabel: 'Delete backup',
                onConfirm: () => new Promise((r) => setTimeout(r, 1200))
              })
            }
          >
            Confirm (async)
          </Button>
        </div>
      </Section>

      <Section title="Error boundary" description="Every page is wrapped; a crash shows this friendly recovery card.">
        <ErrorBoundary onReset={() => setCrash(false)}>
          {crash ? <Crash /> : <Button onClick={() => setCrash(true)}>Simulate a crash</Button>}
        </ErrorBoundary>
      </Section>

      <Dialog
        open={dialog}
        onOpenChange={setDialog}
        icon={Plus}
        title="Add a custom tool"
        description="Paste the command from the tool’s instructions. We’ll check it before saving."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setDialog(false)}>
              Add tool
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name" required>
            <Input placeholder="my-tool" data-autofocus />
          </Field>
          <Field label="Command" hint="For example: npx -y @modelcontextprotocol/server-memory">
            <Input mono placeholder="npx -y …" />
          </Field>
        </div>
      </Dialog>

      <Sheet
        open={sheet}
        onOpenChange={setSheet}
        media={<ServerIcon src="https://github.com/github.png?size=96" name="GitHub" size="lg" />}
        title="GitHub"
        description="by GitHub · Developer tools"
        headerExtra={
          <div className="flex gap-1.5">
            <Badge tone="success" size="sm" dot>
              Official
            </Badge>
            <Badge size="sm">Remote</Badge>
          </div>
        }
        footer={
          <>
            <CopyButton text="claude mcp add github" variant="outline">
              Copy command
            </CopyButton>
            <Button variant="primary" leftIcon={Plus}>
              Add to Claude
            </Button>
          </>
        }
      >
        <div className="space-y-5 text-sm text-fg-muted">
          <p>Work with repositories, issues, pull requests and code reviews on GitHub.</p>
          <CodeBlock code={SAMPLE_CONFIG.mcpServers.github} />
        </div>
      </Sheet>
    </div>
  )
}
