/** Side sheet that tests an installed tool as soon as it opens and shows the tools it offers (or what went wrong). */
import { useEffect, useRef, useState } from 'react'
import { Activity } from 'lucide-react'
import type { CatalogServer, InstalledServer, TestResult } from '@shared/types'
import { Button, ServerIcon, Sheet, Spinner } from '@renderer/components/ui'
import { core, errorMessage } from '@renderer/lib/api'
import { refLabel } from '../discover/lib/targets'
import { TestResultView } from '../discover/common/TestResultView'

export interface TestSheetProps {
  server: InstalledServer | null
  label: string
  catalog?: CatalogServer | null
  onClose: () => void
}

/** Connection test for one installed tool. */
export function TestSheet({ server, label, catalog, onClose }: TestSheetProps) {
  const [result, setResult] = useState<TestResult | null>(null)
  const [running, setRunning] = useState(false)
  const runId = useRef(0)

  const run = async (target: InstalledServer): Promise<void> => {
    const id = ++runId.current
    setRunning(true)
    setResult(null)
    try {
      const res = await core.servers.testInstalled(target.name, target.target)
      if (id === runId.current) setResult(res)
    } catch (err) {
      if (id === runId.current) {
        setResult({ ok: false, kind: 'error', ms: 0, tools: [], error: errorMessage(err), hint: 'The test couldn’t run. Try again in a moment.' })
      }
    } finally {
      if (id === runId.current) setRunning(false)
    }
  }

  useEffect(() => {
    if (server) void run(server)
    else runId.current++
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server])

  return (
    <Sheet
      open={!!server}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={`Testing ${label}`}
      description={server ? refLabel(server.target) : undefined}
      media={server ? <ServerIcon src={catalog?.iconUrl} name={label} seed={server.catalogId ?? server.name} size="lg" /> : undefined}
      footer={
        server ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button leftIcon={Activity} loading={running} onClick={() => void run(server)}>
              Test again
            </Button>
          </>
        ) : undefined
      }
    >
      {running || !result ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center" role="status">
          <Spinner size="lg" className="text-accent" label={null} />
          <p className="text-sm font-medium text-fg">Starting {label}…</p>
          <p className="max-w-xs text-[13px] text-fg-muted">This checks that Claude can talk to it. The first run can take up to a minute.</p>
        </div>
      ) : (
        <TestResultView result={result} name={label} maxTools={40} />
      )}
    </Sheet>
  )
}
