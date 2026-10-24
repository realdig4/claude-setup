import { useState } from 'react'
import { Bot, Check, MessageSquareQuote, Plus, RotateCw, SquareTerminal } from 'lucide-react'
import type { TargetId, TargetRef } from '@shared/types'
import {
  AdvancedOnly,
  Badge,
  Button,
  Callout,
  Card,
  CardContent,
  CodeBlock,
  ErrorState,
  IconTile,
  List,
  ListItem,
  PathText,
  Skeleton,
  confirmAction,
  toast,
  toastError,
  toastResult
} from '@renderer/components/ui'
import { core } from '@renderer/lib/api'
import { joinList } from '@renderer/lib/format'
import { refreshTargets, useAsync, useTargets } from '@renderer/lib/hooks'
import { APP_BLURBS, APP_ICONS, APP_ORDER } from './apps'

const EXAMPLES = [
  '“Find a tool for my Postgres database and add it.”',
  '“Why isn’t my GitHub tool working?”',
  '“Switch Claude Code to DeepSeek.”'
]

function refFor(target: TargetId): TargetRef {
  return target === 'claude-code' || target === 'vscode' ? { target, scope: 'user' } : { target }
}

/** "Let Claude manage its own setup": register Claude Setup's MCP server in your apps, plus the terminal command. */
export function SelfSection() {
  const status = useAsync(() => core.self.mcpStatus(), [])
  const info = useAsync(() => core.app.info(), [])
  const { targets, byId, ready } = useTargets()
  const [busy, setBusy] = useState<TargetId | 'all' | null>(null)
  const [restartNeeded, setRestartNeeded] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [installingCli, setInstallingCli] = useState(false)

  const registered = (id: TargetId): boolean => !!status.data?.find((s) => s.target === id)?.registered
  const installedApps = APP_ORDER.filter((id) => byId(id)?.installed)
  const missing = installedApps.filter((id) => !registered(id))

  const register = async (ids: TargetId[], key: TargetId | 'all'): Promise<void> => {
    if (!ids.length) return
    setBusy(key)
    try {
      const result = await core.self.registerMcp(ids.map(refFor))
      const ok = result.results.filter((r) => r.ok)
      const failed = result.results.filter((r) => !r.ok)
      const names = (list: typeof ok): string => joinList(list.map((r) => byId(r.target.target)?.label ?? r.target.target))
      if (ok.length) {
        toast.success(`Claude can now manage your setup in ${names(ok)}`, { description: 'Start a new chat and ask Claude for help.' })
      }
      for (const r of failed) {
        const label = byId(r.target.target)?.label ?? r.target.target
        toast.error(`Couldn’t add Claude Setup to ${label}`, { description: r.message, duration: 8000 })
      }
      if (result.results.some((r) => r.ok && r.needsRestart)) setRestartNeeded(true)
    } catch (err) {
      toastError(err, 'Couldn’t add Claude Setup to your apps')
    } finally {
      setBusy(null)
      void status.reload()
      void refreshTargets()
    }
  }

  const unregister = async (id: TargetId): Promise<void> => {
    const label = byId(id)?.label ?? id
    const ok = await confirmAction({
      title: `Remove Claude Setup from ${label}?`,
      description: 'Claude won’t be able to manage your setup there anymore. Your other tools stay as they are. A backup is made first.',
      tone: 'danger',
      confirmLabel: 'Remove'
    })
    if (!ok) return
    setBusy(id)
    try {
      const [result] = await core.self.unregisterMcp([refFor(id)])
      if (result) toastResult(result)
      if (result?.needsRestart) setRestartNeeded(true)
    } catch (err) {
      toastError(err, `Couldn’t remove Claude Setup from ${label}`)
    } finally {
      setBusy(null)
      void status.reload()
      void refreshTargets()
    }
  }

  const restartDesktop = async (): Promise<void> => {
    setRestarting(true)
    try {
      const result = await core.targets.restartDesktop()
      toastResult(result)
      if (result.ok) setRestartNeeded(false)
    } catch (err) {
      toastError(err, 'Couldn’t restart Claude Desktop')
    } finally {
      setRestarting(false)
    }
  }

  const installCli = async (): Promise<void> => {
    setInstallingCli(true)
    try {
      toastResult(await core.self.installCli())
    } catch (err) {
      toastError(err, 'Couldn’t install the terminal command')
    } finally {
      setInstallingCli(false)
    }
  }

  const loading = (status.loading && !status.data) || !ready

  return (
    <div className="space-y-4">
      <Card variant="hero" className="overflow-hidden">
        <CardContent className="flex flex-wrap items-start gap-5 pt-6">
          <IconTile icon={Bot} tone="accent" size="lg" />
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <h3 className="text-base font-semibold tracking-[-0.01em] text-fg">Let Claude manage its own setup</h3>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-fg-muted">
                Add Claude Setup as a tool in your Claude apps. Then just ask Claude to find and add tools, switch models or fix problems —
                it uses the same safe steps as this app, with backups.
              </p>
            </div>
            <ul className="flex flex-wrap gap-2" aria-label="Things you can ask">
              {EXAMPLES.map((example) => (
                <li
                  key={example}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/80 px-3 py-1 text-[13px] text-fg-muted"
                >
                  <MessageSquareQuote className="size-3.5 text-accent-text" aria-hidden="true" />
                  {example}
                </li>
              ))}
            </ul>
          </div>
          <Button
            variant="primary"
            leftIcon={Plus}
            loading={busy === 'all'}
            disabled={loading || missing.length === 0 || !!busy}
            onClick={() => void register(missing, 'all')}
          >
            {missing.length === 0 && !loading ? 'Added everywhere' : 'Add to my apps'}
          </Button>
        </CardContent>

        {status.error && !status.data ? (
          <div className="border-t border-line">
            <ErrorState
              size="sm"
              title="Couldn’t check where Claude Setup is added"
              error={status.error}
              onRetry={() => void status.reload()}
            />
          </div>
        ) : (
          <List variant="plain" aria-label="Apps" className="border-t border-line">
            {APP_ORDER.map((id) => {
              const target = byId(id)
              const entry = status.data?.find((s) => s.target === id)
              const installed = !!target?.installed
              const isRegistered = !!entry?.registered
              return (
                <ListItem
                  key={id}
                  media={<IconTile icon={APP_ICONS[id]} tone={isRegistered ? 'success' : 'neutral'} size="md" />}
                  title={target?.label ?? id}
                  description={installed ? APP_BLURBS[id] : 'Not installed on this computer'}
                  muted={!installed && !isRegistered}
                  actions={
                    loading ? (
                      <Skeleton className="h-8 w-20 rounded-lg" />
                    ) : isRegistered ? (
                      <>
                        <Badge tone="success" icon={Check}>
                          Added
                        </Badge>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busy === id}
                          disabled={!!busy && busy !== id}
                          onClick={() => void unregister(id)}
                        >
                          Remove
                        </Button>
                      </>
                    ) : installed ? (
                      <Button
                        size="sm"
                        leftIcon={Plus}
                        loading={busy === id}
                        disabled={!!busy && busy !== id}
                        onClick={() => void register([id], id)}
                      >
                        Add
                      </Button>
                    ) : (
                      <Badge>Not installed</Badge>
                    )
                  }
                >
                  {entry?.configPath && (isRegistered || installed) ? (
                    <AdvancedOnly>
                      <div className="pl-[50px]">
                        <PathText path={entry.configPath} copy reveal />
                      </div>
                    </AdvancedOnly>
                  ) : null}
                </ListItem>
              )
            })}
          </List>
        )}
      </Card>

      {restartNeeded ? (
        <Callout
          tone="warn"
          title="Restart Claude Desktop to finish"
          action={
            <Button size="sm" leftIcon={RotateCw} loading={restarting} onClick={() => void restartDesktop()}>
              Restart now
            </Button>
          }
        >
          Claude Desktop loads new tools when it starts.
        </Callout>
      ) : null}

      <AdvancedOnly>
        {info.data?.selfMcpConfig ? (
          <CodeBlock title="What gets added" code={{ mcpServers: { 'claude-setup': info.data.selfMcpConfig } }} maxHeight={220} />
        ) : null}
      </AdvancedOnly>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 pt-5">
          <IconTile icon={SquareTerminal} tone="neutral" size="md" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-fg">Terminal command</h3>
            <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
              Adds a <code className="rounded bg-surface-3/70 px-1 font-mono text-xs text-fg">claude-setup</code> command you can run in any
              terminal. Claude Code also uses it to read model keys without storing them in its settings.
            </p>
          </div>
          <Button loading={installingCli} onClick={() => void installCli()}>
            Install the command
          </Button>
        </CardContent>
      </Card>
      {targets.length === 0 && ready ? <p className="text-xs text-fg-subtle">No apps were found on this computer.</p> : null}
    </div>
  )
}
