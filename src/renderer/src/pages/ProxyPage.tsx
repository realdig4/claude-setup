import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { KeyRound, Plus, RefreshCw, Waypoints } from 'lucide-react'
import type { ModelTarget, ProxyLogEntry, ProxyUpstream } from '@shared/types'
import {
  Button,
  Callout,
  Card,
  CardContent,
  CodeBlock,
  CopyButton,
  Disclosure,
  ErrorState,
  Field,
  Input,
  PageHeader,
  SecretInput,
  Section,
  SkeletonCard,
  Tooltip,
  confirmAction,
  toast,
  toastError
} from '@renderer/components/ui'
import { core, errorMessage, useCoreEvent } from '@renderer/lib/api'
import { useAsync, useInterval, useLatest } from '@renderer/lib/hooks'
import { maskSecret } from '@renderer/lib/format'
import { getPage, type PageProps } from '@renderer/lib/nav'
import { EASE_OUT } from '@renderer/lib/motion'
import { AdvancedGate } from './backups/AdvancedGate'
import { LogTable } from './proxy/LogTable'
import { ProxyExplainer, ProxyStatusCard } from './proxy/ProxyStatusCard'
import { RoutesEditor } from './proxy/RoutesEditor'
import { UpstreamDialog } from './proxy/UpstreamDialog'
import { UpstreamList } from './proxy/UpstreamList'
import {
  configFromDraft,
  draftFromConfig,
  draftIssues,
  isDraftDirty,
  issueCount,
  removeUpstream,
  renameUpstream,
  routesUsing,
  type LogFilter,
  type ProxyDraft
} from './proxy/logic'

const page = getPage('proxy')

/** A new random local access token in the core's format (cs- + 32 hex characters). */
function newToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `cs-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

function isLoopback(url: string | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
  } catch {
    return false
  }
}

interface DialogState {
  key: number
  open: boolean
  upstream?: ProxyUpstream
}

interface ReapplyState {
  profileId: string
  name: string
  targets: ModelTarget[]
}

function ProxyWorkspace() {
  const status = useAsync(() => core.proxy.status(), [])
  const config = useAsync(() => core.proxy.getConfig(), [])
  const logs = useAsync(() => core.proxy.logs(200), [])
  const providers = useAsync(() => core.models.providers(), [])
  const profiles = useAsync(() => core.models.profiles(), [])
  const [draft, setDraft] = useState<ProxyDraft | null>(null)
  const [entries, setEntries] = useState<ProxyLogEntry[] | undefined>(undefined)
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState<LogFilter>('all')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savingAutoStart, setSavingAutoStart] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [keys, setKeys] = useState<Record<string, boolean>>({})
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [reapply, setReapply] = useState<ReapplyState | null>(null)
  const [reapplying, setReapplying] = useState(false)
  const buffer = useRef<ProxyLogEntry[]>([])
  const pausedRef = useLatest(paused)
  const statusTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (config.data && !draft) setDraft(draftFromConfig(config.data))
  }, [config.data, draft])

  useEffect(() => {
    if (!logs.data) return
    buffer.current = logs.data
    setEntries(logs.data)
  }, [logs.data])

  useEffect(() => () => window.clearTimeout(statusTimer.current), [])

  useInterval(() => void status.reload(), 5000)

  useCoreEvent('proxy', (entry) => {
    buffer.current = [entry, ...buffer.current].slice(0, 500)
    if (!pausedRef.current) setEntries(buffer.current)
    // Counters change with every request: refresh the status soon (coalesced).
    window.clearTimeout(statusTimer.current)
    statusTimer.current = window.setTimeout(() => void status.reload(), 400)
  })

  // Which upstream keys are saved (checked once per key reference).
  const refs = useMemo(
    () => [...new Set((draft?.upstreams ?? []).map((u) => u.keyRef).filter((r): r is string => !!r))],
    [draft?.upstreams]
  )
  useEffect(() => {
    const missing = refs.filter((ref) => !(ref in keys))
    if (!missing.length) return
    let cancelled = false
    void Promise.all(missing.map(async (ref) => [ref, await core.app.hasSecret(ref).catch(() => false)] as const)).then((pairs) => {
      if (!cancelled) setKeys((current) => ({ ...current, ...Object.fromEntries(pairs) }))
    })
    return () => {
      cancelled = true
    }
  }, [refs, keys])

  const presets = useMemo(() => (providers.data ?? []).filter((p) => p.kind === 'openai-proxy'), [providers.data])
  const issues = useMemo(() => (draft ? draftIssues(draft) : null), [draft])
  const dirty = !!draft && !!config.data && isDraftDirty(draft, config.data)
  const problems = issues ? issueCount(issues) : 0
  const shownIssues = attempted && issues ? issues : { upstreams: {}, routes: {} }
  const patch = (changes: Partial<ProxyDraft>): void => setDraft((d) => (d ? { ...d, ...changes } : d))

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await core.proxy.start()
      status.setData(next)
      if (next.running) toast.success('The proxy is running', { description: next.url })
      else {
        toast.error('The proxy didn’t start', {
          description: next.lastError ?? 'Check that the port is free and try again.',
          duration: 8000
        })
      }
    } catch (err) {
      toastError(err, 'Couldn’t start the proxy')
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    const ok = await confirmAction({
      title: 'Stop the proxy?',
      description: 'Claude Code can’t use OpenAI-style providers until you start it again.',
      confirmLabel: 'Stop proxy',
      tone: 'danger'
    })
    if (!ok) return
    setBusy(true)
    try {
      status.setData(await core.proxy.stop())
      toast.success('The proxy is stopped')
    } catch (err) {
      toastError(err, 'Couldn’t stop the proxy')
    } finally {
      setBusy(false)
    }
  }

  const setAutoStart = async (on: boolean): Promise<void> => {
    if (!config.data) return
    setSavingAutoStart(true)
    try {
      const saved = await core.proxy.saveConfig({ ...config.data, autoStart: on })
      config.setData(saved)
      setDraft((d) => (d ? { ...d, autoStart: saved.autoStart } : d))
      toast.success(on ? 'The proxy starts with Claude Setup' : 'The proxy won’t start on its own')
    } catch (err) {
      toastError(err, 'Couldn’t change that setting')
    } finally {
      setSavingAutoStart(false)
    }
  }

  /** After a port or token change, Claude Code still points at the old address/token: offer to update it. */
  const offerReapply = async (): Promise<void> => {
    const models = await core.models.status().catch(() => null)
    if (!models || models.mode !== 'custom' || !models.profileId || !isLoopback(models.baseUrl)) return
    const profile = profiles.data?.find((p) => p.id === models.profileId)
    setReapply({
      profileId: models.profileId,
      name: profile?.name ?? models.providerName ?? 'your model setup',
      targets: models.vscodeConfigured ? ['claude-code', 'vscode'] : ['claude-code']
    })
  }

  const save = async (): Promise<void> => {
    if (!draft || !config.data || !issues) return
    setAttempted(true)
    if (problems > 0) {
      toast.error(problems === 1 ? 'One thing needs fixing first' : `${problems} things need fixing first`, {
        description: 'Look for the red messages.'
      })
      return
    }
    setSaving(true)
    setSaveError(null)
    const before = config.data
    try {
      const saved = await core.proxy.saveConfig(configFromDraft(draft, before))
      config.setData(saved)
      setDraft(draftFromConfig(saved))
      setAttempted(false)
      toast.success('Proxy settings saved', {
        description: status.data?.running ? 'They apply to new requests right away.' : undefined
      })
      // Keys that belonged only to removed upstreams are no longer needed.
      const kept = new Set(saved.upstreams.map((u) => u.keyRef))
      for (const u of before.upstreams) {
        if (u.keyRef?.startsWith('proxy:') && !kept.has(u.keyRef)) void core.app.setSecret(u.keyRef, null).catch(() => undefined)
      }
      if (saved.port !== before.port || saved.authToken !== before.authToken) await offerReapply()
      void status.reload()
    } catch (err) {
      setSaveError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const discard = (): void => {
    if (!config.data) return
    setDraft(draftFromConfig(config.data))
    setAttempted(false)
    setSaveError(null)
  }

  const regenerateToken = async (): Promise<void> => {
    const ok = await confirmAction({
      title: 'Make a new access token?',
      description: 'The old token stops working when you save. Claude Setup can update Claude Code for you afterwards.',
      confirmLabel: 'Make new token',
      icon: KeyRound
    })
    if (ok) patch({ authToken: newToken() })
  }

  const reapplyNow = async (): Promise<void> => {
    if (!reapply) return
    setReapplying(true)
    try {
      const result = await core.models.apply({ profileId: reapply.profileId, targets: reapply.targets })
      if (result.ok) {
        toast.success('Claude Code is up to date', { description: 'Restart Claude Code so it uses the new settings.' })
        setReapply(null)
      } else {
        toast.error('Couldn’t update Claude Code', {
          description: result.results.find((r) => !r.ok)?.message ?? result.warnings[0],
          duration: 8000
        })
      }
    } catch (err) {
      toastError(err, 'Couldn’t update Claude Code')
    } finally {
      setReapplying(false)
    }
  }

  const onUpstreamSaved = (upstream: ProxyUpstream, previousId?: string): void => {
    setDraft((d) => {
      if (!d) return d
      const renamed = previousId && previousId !== upstream.id ? renameUpstream(d, previousId, upstream.id) : d
      const exists = previousId !== undefined && renamed.upstreams.some((u) => u.id === previousId)
      const upstreams = exists ? renamed.upstreams.map((u) => (u.id === previousId ? upstream : u)) : [...renamed.upstreams, upstream]
      return { ...renamed, upstreams }
    })
    const ref = upstream.keyRef
    if (ref) {
      setKeys((current) => {
        const next = { ...current }
        delete next[ref]
        return next
      })
    }
  }

  const removeOne = async (upstream: ProxyUpstream): Promise<void> => {
    if (!draft) return
    const used = routesUsing(draft, upstream.id)
    const profile = profiles.data?.find((p) => p.id === upstream.id)
    const ok = await confirmAction({
      title: `Remove ${upstream.name || upstream.id}?`,
      description: [
        used ? `${used === 1 ? 'One route points' : `${used} routes point`} to it and will be removed too.` : '',
        profile
          ? `It belongs to the model setup “${profile.name}” — Claude Code stops working with that setup until you use it again.`
          : '',
        'Nothing changes until you save.'
      ]
        .filter(Boolean)
        .join(' '),
      tone: 'danger',
      confirmLabel: 'Remove'
    })
    if (ok) setDraft((d) => (d ? removeUpstream(d, upstream.id) : d))
  }

  if (!draft) {
    return config.error ? (
      <ErrorState framed title="Couldn’t load the proxy settings" error={config.error} onRetry={() => void config.reload()} />
    ) : (
      <div className="space-y-4" aria-busy="true">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    )
  }

  const editing = dialog?.upstream
  return (
    <div className="space-y-10 pb-4">
      <div className="space-y-4">
        <ProxyStatusCard
          status={status.data}
          error={status.error}
          onRetry={() => void status.reload()}
          onStart={() => void start()}
          onStop={() => void stop()}
          busy={busy}
          autoStart={config.data?.autoStart}
          onAutoStartChange={(on) => void setAutoStart(on)}
          savingAutoStart={savingAutoStart}
          hasUpstreams={(config.data?.upstreams.length ?? 0) > 0}
        />
        {reapply ? (
          <Callout
            tone="warn"
            title="Claude Code still uses the old address or token"
            onDismiss={() => setReapply(null)}
            action={
              <Button size="sm" loading={reapplying} onClick={() => void reapplyNow()}>
                Update Claude Code
              </Button>
            }
          >
            Use “{reapply.name}” again so Claude Code connects with the new proxy settings.
          </Callout>
        ) : null}
        <ProxyExplainer />
      </div>

      <Section title="Connection" description="Where the proxy listens and the token Claude Code uses to talk to it.">
        <Card>
          <CardContent className="grid gap-5 pt-5 sm:grid-cols-[200px_minmax(0,1fr)]">
            <Field label="Port" error={shownIssues.port} hint="On 127.0.0.1 only.">
              <Input mono inputMode="numeric" value={draft.port} onValueChange={(port) => patch({ port })} />
            </Field>
            <Field
              label="Access token"
              error={shownIssues.authToken}
              hint="Claude Setup writes it into Claude Code’s settings when you use a model setup."
              labelAction={
                <span className="-my-2 flex items-center gap-1">
                  <CopyButton text={draft.authToken} label="Copy token" />
                  <Button size="sm" variant="link" onClick={() => void regenerateToken()}>
                    New token
                  </Button>
                </span>
              }
            >
              <SecretInput value={draft.authToken} onValueChange={(authToken) => patch({ authToken })} allowPaste={false} />
            </Field>
          </CardContent>
        </Card>
      </Section>

      <Section
        title="Upstreams"
        description="OpenAI-style servers the proxy forwards to. Keys are stored in your system’s secure storage."
        actions={
          <Button size="sm" leftIcon={Plus} onClick={() => setDialog({ key: Date.now(), open: true })}>
            Add upstream
          </Button>
        }
      >
        <UpstreamList
          upstreams={draft.upstreams}
          presets={presets}
          profiles={profiles.data}
          keys={keys}
          issues={shownIssues.upstreams}
          onAdd={() => setDialog({ key: Date.now(), open: true })}
          onEdit={(upstream) => setDialog({ key: Date.now(), open: true, upstream })}
          onRemove={(upstream) => void removeOne(upstream)}
        />
      </Section>

      <Section title="Routes" description="Which upstream model answers each model name Claude Code asks for.">
        <RoutesEditor draft={draft} upstreams={draft.upstreams} issues={shownIssues} onChange={patch} />
      </Section>

      {config.data ? (
        <Disclosure variant="card" title="Raw configuration" description="The proxy settings as JSON, with the access token hidden">
          <CodeBlock code={{ ...configFromDraft(draft, config.data), authToken: maskSecret(draft.authToken) }} maxHeight={320} />
        </Disclosure>
      ) : null}

      <Section
        title="Live log"
        description="The newest requests first. Keys and message contents are never logged."
        actions={
          <Tooltip content="Reload the log">
            <Button size="icon-sm" variant="ghost" aria-label="Reload the log" onClick={() => void logs.reload()}>
              <RefreshCw />
            </Button>
          </Tooltip>
        }
      >
        <LogTable
          entries={entries}
          loading={logs.loading}
          error={logs.error}
          onRetry={() => void logs.reload()}
          filter={filter}
          onFilterChange={setFilter}
          paused={paused}
          onPauseChange={(next) => {
            setPaused(next)
            if (!next) setEntries(buffer.current)
          }}
          onClear={() => {
            buffer.current = []
            setEntries([])
          }}
        />
      </Section>

      <AnimatePresence>
        {dirty || saveError ? (
          <motion.div
            key="savebar"
            className="sticky bottom-4 z-10"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
          >
            <Card className="flex flex-wrap items-center gap-3 border-line-strong px-5 py-3 shadow-lg">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">
                  {saveError ? 'Couldn’t save the proxy settings' : 'You have unsaved changes'}
                </p>
                <p className={saveError ? 'text-[13px] text-danger-text' : 'text-[13px] text-fg-muted'}>
                  {saveError ??
                    (attempted && problems
                      ? `${problems === 1 ? 'One thing needs' : `${problems} things need`} fixing.`
                      : 'Save to apply them to the proxy.')}
                </p>
              </div>
              <Button variant="ghost" onClick={discard} disabled={saving}>
                Discard
              </Button>
              <Button variant="primary" loading={saving} onClick={() => void save()}>
                Save changes
              </Button>
            </Card>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {dialog ? (
        <UpstreamDialog
          key={dialog.key}
          open={dialog.open}
          onOpenChange={(open) => setDialog((d) => (d ? { ...d, open } : d))}
          upstream={editing}
          takenIds={draft.upstreams.filter((u) => u.id !== editing?.id).map((u) => u.id)}
          presets={presets}
          hasKey={!!editing?.keyRef && keys[editing.keyRef] === true}
          managedBy={editing ? profiles.data?.find((p) => p.id === editing.id)?.name : undefined}
          onSave={onUpstreamSaved}
        />
      ) : null}
    </div>
  )
}

/** Proxy (Advanced): status, start/stop, connection, upstreams, routes and a live request log. */
export default function ProxyPage(_props: PageProps) {
  return (
    <>
      <PageHeader
        icon={page.icon}
        title={page.label}
        subtitle="A local translator that lets Claude Code talk to OpenAI-style providers."
      />
      <AdvancedGate
        icon={Waypoints}
        title="The proxy is part of Advanced mode"
        description="Claude Setup runs it for you when a model needs it. Turn on Advanced mode to see its status, settings and log."
      >
        <ProxyWorkspace />
      </AdvancedGate>
    </>
  )
}
