import { useState } from 'react'
import { ArrowUpRight, Download } from 'lucide-react'
import type { RuntimeInfo, RuntimeName } from '@shared/types'
import {
  AdvancedOnly,
  Badge,
  Button,
  CodeBlock,
  CopyButton,
  ErrorState,
  List,
  ListItem,
  Monogram,
  PathText,
  ProgressBar,
  Skeleton,
  confirmAction,
  openExternal,
  toastError,
  toastResult
} from '@renderer/components/ui'
import { core } from '@renderer/lib/api'
import { useProgress } from '@renderer/lib/hooks'
import { runtimeState, visibleRuntimes } from './meta'

export interface RuntimesSectionProps {
  runtimes: RuntimeInfo[] | undefined
  loading: boolean
  error: string | null
  onRetry: () => void
  /** A runtime was installed (refresh the list and the health report). */
  onInstalled: () => void
  advanced: boolean
}

const BRAND: Partial<Record<RuntimeName, { letters: string; color: string }>> = {
  node: { letters: 'N', color: '#5FA04E' },
  npx: { letters: 'nx', color: '#CB3837' },
  uv: { letters: 'uv', color: '#DE5FE9' },
  uvx: { letters: 'ux', color: '#B54FC0' },
  python: { letters: 'Py', color: '#3776AB' },
  docker: { letters: 'D', color: '#2496ED' },
  git: { letters: 'G', color: '#F05032' },
  claude: { letters: 'C', color: '#D97757' },
  code: { letters: 'VS', color: '#2F80ED' },
  winget: { letters: 'W', color: '#0078D4' },
  brew: { letters: 'B', color: '#FBB040' }
}

/** Programs that tools need (Node.js, uv, Docker…): status, version and one-click installs. */
export function RuntimesSection({ runtimes, loading, error, onRetry, onInstalled, advanced }: RuntimesSectionProps) {
  const [installing, setInstalling] = useState<RuntimeName | null>(null)
  const { progress, reset } = useProgress((op) => op === 'install-runtime' || op.startsWith('install-'))

  if (!runtimes) {
    if (error) return <ErrorState framed size="sm" title="Couldn’t check the installed programs" error={error} onRetry={onRetry} />
    return (
      <List aria-label="Loading programs" className={loading ? undefined : 'opacity-60'}>
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="flex items-center gap-3.5 px-4 py-3.5">
            <Skeleton className="size-9 rounded-[10px]" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3.5 w-72 max-w-full" />
            </div>
            <Skeleton className="h-6 w-20 rounded-lg" />
          </li>
        ))}
      </List>
    )
  }

  const install = async (runtime: RuntimeInfo): Promise<void> => {
    const command = runtime.install?.command
    const ok = await confirmAction({
      title: `Install ${runtime.label}?`,
      description:
        `${runtime.purpose} Claude Setup downloads it from the official source and installs it for you — ` +
        'it can take a minute or two.',
      details: advanced && command ? <CodeBlock code={`$ ${command}`} language="shell" copy={false} /> : undefined,
      confirmLabel: 'Install'
    })
    if (!ok) return
    reset()
    setInstalling(runtime.id)
    try {
      const result = await core.runtimes.install(runtime.id)
      toastResult(result)
      if (result.ok) onInstalled()
    } catch (err) {
      toastError(err, `Couldn’t install ${runtime.label}`)
    } finally {
      setInstalling(null)
    }
  }

  const list = visibleRuntimes(runtimes, advanced)

  return (
    <List aria-label="Programs tools need">
      {list.map((runtime) => {
        const state = runtimeState(runtime)
        const brand = BRAND[runtime.id]
        const busy = installing === runtime.id
        const canInstall = !!runtime.install?.canAutoInstall
        const showCommand = advanced && state !== 'ok' && !!runtime.install?.command
        return (
          <ListItem
            key={runtime.id}
            media={<Monogram text={runtime.label} letters={brand?.letters} color={brand?.color} />}
            title={
              <span className="flex items-center gap-2">
                <span>{runtime.label}</span>
                {runtime.version ? (
                  <Badge size="sm" variant="outline">
                    {runtime.version}
                  </Badge>
                ) : null}
              </span>
            }
            description={state === 'stopped' ? `${runtime.purpose} Start Docker Desktop to use it.` : runtime.purpose}
            muted={state === 'missing' && !canInstall && !runtime.install?.url}
            actions={
              state === 'ok' ? (
                <Badge tone="success" dot>
                  Installed
                </Badge>
              ) : state === 'stopped' ? (
                <Badge tone="warn" dot>
                  Not running
                </Badge>
              ) : canInstall ? (
                <>
                  {state === 'outdated' ? (
                    <Badge tone="warn" dot>
                      Update needed
                    </Badge>
                  ) : null}
                  <Button
                    size="sm"
                    leftIcon={Download}
                    loading={busy}
                    disabled={!!installing && !busy}
                    onClick={() => void install(runtime)}
                  >
                    {state === 'outdated' ? 'Update' : 'Install'}
                  </Button>
                </>
              ) : runtime.install?.url ? (
                <>
                  {state === 'outdated' ? (
                    <Badge tone="warn" dot>
                      Update needed
                    </Badge>
                  ) : (
                    <Badge dot>Not installed</Badge>
                  )}
                  <Button size="sm" rightIcon={ArrowUpRight} onClick={() => void openExternal(runtime.install?.url ?? '')}>
                    Download
                  </Button>
                </>
              ) : (
                <Badge dot>Not installed</Badge>
              )
            }
          >
            {busy ? (
              <div className="pl-[50px]">
                <ProgressBar size="sm" label={`Installing ${runtime.label}`} value={progress?.pct} />
                <p className="mt-1.5 text-xs text-fg-muted" aria-live="polite">
                  {progress?.message ?? `Installing ${runtime.label}…`}
                </p>
              </div>
            ) : advanced && (runtime.path || showCommand) ? (
              <AdvancedOnly>
                <div className="flex flex-col gap-1.5 pl-[50px]">
                  {runtime.path ? <PathText path={runtime.path} copy reveal /> : null}
                  {showCommand ? (
                    <span className="inline-flex max-w-full items-center gap-1.5">
                      <code className="min-w-0 truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-fg">
                        {runtime.install?.command}
                      </code>
                      <CopyButton text={runtime.install?.command ?? ''} label="Copy command" />
                    </span>
                  ) : null}
                </div>
              </AdvancedOnly>
            ) : null}
          </ListItem>
        )
      })}
    </List>
  )
}
