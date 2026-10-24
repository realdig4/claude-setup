/**
 * "See what it can do": starts a catalog server for a moment (without adding it anywhere) and lists its tools.
 * Only offered when the server needs no key.
 */
import { useState } from 'react'
import { Play } from 'lucide-react'
import type { CatalogServer, InstallOption, TestResult } from '@shared/types'
import { Button, Spinner } from '@renderer/components/ui'
import { core, errorMessage } from '@renderer/lib/api'
import { joinList } from '@renderer/lib/format'
import { TestResultView } from './common/TestResultView'
import { humanizeName } from './lib/installForm'

type Phase = { kind: 'idle' } | { kind: 'running' } | { kind: 'needs'; missing: string[] } | { kind: 'done'; result: TestResult }

function failure(kind: TestResult['kind'], error: string, hint: string): TestResult {
  return { ok: false, kind, ms: 0, tools: [], error, hint }
}

export interface ServerToolsProps {
  server: CatalogServer
  option: InstallOption
}

/** Try-it panel for the details sheet. */
export function ServerTools({ server, option }: ServerToolsProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const run = async (): Promise<void> => {
    setPhase({ kind: 'running' })
    try {
      const preview = await core.servers.preview({ catalogId: server.id, optionId: option.id, targets: [] })
      if (preview.missingValues.length) return setPhase({ kind: 'needs', missing: preview.missingValues })
      if (preview.config.type === 'stdio' && !preview.config.command) {
        return setPhase({
          kind: 'done',
          result: failure('invalid-config', preview.warnings.join(' '), preview.warnings[0] ?? 'It can’t be started from here.')
        })
      }
      const result = await core.servers.test(preview.config, { timeoutMs: 60_000 })
      setPhase({ kind: 'done', result })
    } catch (err) {
      setPhase({ kind: 'done', result: failure('error', errorMessage(err), 'It couldn’t be started right now. Try again in a moment.') })
    }
  }

  if (phase.kind === 'running') {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-2/40 px-4 py-3.5" role="status">
        <Spinner size="sm" className="text-accent" label={null} />
        <span className="text-[13px] text-fg-muted">Starting {server.name}… the first run can take a minute.</span>
      </div>
    )
  }

  if (phase.kind === 'done') {
    return (
      <div className="space-y-3 rounded-xl border border-line bg-surface-2/40 p-4">
        <TestResultView result={phase.result} name={server.name} maxTools={10} />
        <Button size="sm" variant="ghost" leftIcon={Play} onClick={() => void run()}>
          Try again
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-2/40 px-4 py-3.5">
      <p className="min-w-0 flex-1 text-[13px] leading-5 text-fg-muted">
        {phase.kind === 'needs'
          ? `It needs ${joinList(phase.missing.map(humanizeName))} before it can start — add it to try it out.`
          : 'Start it for a moment to see the tools it gives Claude. Nothing is added to your apps.'}
      </p>
      {phase.kind === 'idle' ? (
        <Button size="sm" variant="outline" leftIcon={Play} onClick={() => void run()}>
          Show its tools
        </Button>
      ) : null}
    </div>
  )
}
