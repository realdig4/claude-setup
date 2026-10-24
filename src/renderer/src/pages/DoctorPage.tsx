import { useEffect, useMemo, useRef, useState } from 'react'
import { RotateCw, SearchX } from 'lucide-react'
import type { CheckStatus, DoctorCheck, DoctorReport } from '@shared/types'
import {
  Button,
  Callout,
  Chip,
  CopyButton,
  Disclosure,
  EmptyState,
  FadeIn,
  List,
  PageHeader,
  Section,
  confirmAction,
  toastError,
  toastResult
} from '@renderer/components/ui'
import { core, errorMessage } from '@renderer/lib/api'
import { refreshTargets, useAsync, useProgress } from '@renderer/lib/hooks'
import { getPage, type PageProps } from '@renderer/lib/nav'
import { useIsAdvanced } from '@renderer/lib/store'
import { CheckRow } from './doctor/CheckRow'
import { RunHero } from './doctor/RunHero'
import { RuntimesSection } from './doctor/RuntimesSection'
import { CATEGORY_META, attentionChecks, fixImpact, groupChecks, otherChecks } from './doctor/meta'

const page = getPage('doctor')

/** The last report of this session, so coming back to the page shows it right away. */
let lastReport: DoctorReport | null = null

type Filter = 'all' | 'error' | 'warn' | 'ok' | 'other'

const FILTERS: Array<{ id: Filter; label: string; match: (s: CheckStatus) => boolean }> = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'error', label: 'Problems', match: (s) => s === 'error' },
  { id: 'warn', label: 'Warnings', match: (s) => s === 'warn' },
  { id: 'ok', label: 'OK', match: (s) => s === 'ok' },
  { id: 'other', label: 'Notes & skipped', match: (s) => s === 'info' || s === 'skip' }
]

/** Health Check: run the doctor, fix problems with one click, and see which programs are installed. */
export default function DoctorPage({ params }: PageProps) {
  const advanced = useIsAdvanced()
  const [report, setReport] = useState<DoctorReport | null>(lastReport)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fixing, setFixing] = useState<string[]>([])
  const [restartNeeded, setRestartNeeded] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const { progress, reset } = useProgress('doctor')
  const runtimes = useAsync(() => core.runtimes.detect(), [])
  const runSeq = useRef(0)

  const run = async (): Promise<void> => {
    const id = ++runSeq.current
    reset()
    setRunning(true)
    setError(null)
    try {
      const next = await core.doctor.run()
      if (id !== runSeq.current) return
      lastReport = next
      setReport(next)
    } catch (err) {
      if (id === runSeq.current) setError(errorMessage(err))
    } finally {
      if (id === runSeq.current) setRunning(false)
    }
  }

  // Deep link: navigate('doctor', { run: true }) starts a check right away.
  useEffect(() => {
    if (params.run === true) void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.run])

  const applyFix = async (check: DoctorCheck): Promise<void> => {
    const fix = check.fix
    if (!fix) return
    const impact = fixImpact(fix.id, fix.label)
    if (impact.confirm) {
      const ok = await confirmAction({
        title: impact.title,
        description: (
          <>
            <span className="font-medium text-fg">{check.title}.</span> {impact.description}
          </>
        ),
        confirmLabel: fix.label
      })
      if (!ok) return
    }
    setFixing((ids) => [...ids, fix.id])
    try {
      const result = await core.doctor.fix(fix.id)
      toastResult(result)
      if (result.needsRestart) setRestartNeeded(true)
      if (result.ok) {
        if (impact.kind === 'install') void runtimes.reload()
        void refreshTargets()
        await run()
      }
    } catch (err) {
      toastError(err, 'Couldn’t apply the fix')
    } finally {
      setFixing((ids) => ids.filter((id) => id !== fix.id))
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

  const attention = useMemo(() => (report ? attentionChecks(report.checks) : []), [report])
  const others = useMemo(() => (report ? otherChecks(report.checks) : []), [report])
  const activeFilter = FILTERS.find((f) => f.id === filter) ?? FILTERS[0]
  const filtered = useMemo(() => (report ? report.checks.filter((c) => activeFilter?.match(c.status)) : []), [report, activeFilter])
  const groups = useMemo(() => groupChecks(filtered), [filtered])

  const row = (check: DoctorCheck, opts: { explain?: boolean; compact?: boolean } = {}) => (
    <CheckRow
      key={check.id}
      check={check}
      onFix={(c) => void applyFix(c)}
      fixing={!!check.fix && fixing.includes(check.fix.id)}
      advanced={advanced}
      explain={opts.explain}
      compact={opts.compact}
    />
  )

  return (
    <>
      <PageHeader icon={page.icon} title={page.label} subtitle="Find and fix common problems with one click." />

      <div className="space-y-10">
        <div className="space-y-4">
          <RunHero
            report={report}
            running={running}
            progress={progress}
            error={report ? null : error}
            onRun={() => void run()}
            advanced={advanced}
          />
          {report && error ? (
            <Callout tone="danger" title="The last check didn’t finish" onDismiss={() => setError(null)}>
              {error}
            </Callout>
          ) : null}
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
              Claude Desktop reads its settings when it starts.
            </Callout>
          ) : null}
        </div>

        {report && !advanced ? (
          <FadeIn key={report.ranAt}>
            <div className="space-y-6">
              {attention.length > 0 ? (
                <Section title="Needs your attention" description="Worst first. Most can be fixed with one click.">
                  <List aria-label="Checks that need attention">{attention.map((check) => row(check, { explain: true }))}</List>
                </Section>
              ) : null}
              {others.length > 0 ? (
                <Disclosure
                  variant="card"
                  title={attention.length ? 'Everything else' : 'See every check'}
                  description={`${others.length} ${others.length === 1 ? 'check' : 'checks'}`}
                >
                  <div className="space-y-5">
                    {groupChecks(others).map((group) => (
                      <section key={group.category} aria-label={CATEGORY_META[group.category].simple}>
                        <h3 className="mb-1 px-1 text-xs font-semibold tracking-wide text-fg-muted uppercase">
                          {CATEGORY_META[group.category].simple}
                        </h3>
                        <ul className="divide-y divide-line">{group.checks.map((check) => row(check, { compact: true }))}</ul>
                      </section>
                    ))}
                  </div>
                </Disclosure>
              ) : null}
            </div>
          </FadeIn>
        ) : null}

        {report && advanced ? (
          <FadeIn key={report.ranAt}>
            <Section
              title="Checks"
              description={`${report.checks.length} checks in ${groupChecks(report.checks).length} areas.`}
              actions={
                <div className="flex flex-wrap items-center justify-end gap-1.5" role="group" aria-label="Filter checks">
                  <CopyButton text={JSON.stringify(report, null, 2)} label="Copy report as JSON" toast="Report copied" />
                  {FILTERS.map((f) => (
                    <Chip
                      key={f.id}
                      size="sm"
                      selected={filter === f.id}
                      count={report.checks.filter((c) => f.match(c.status)).length}
                      onClick={() => setFilter(f.id)}
                    >
                      {f.label}
                    </Chip>
                  ))}
                </div>
              }
            >
              {groups.length === 0 ? (
                <EmptyState
                  framed
                  size="sm"
                  icon={SearchX}
                  title="No checks match this filter"
                  actions={
                    <Button size="sm" onClick={() => setFilter('all')}>
                      Show all
                    </Button>
                  }
                />
              ) : (
                <div className="space-y-6">
                  {groups.map((group) => (
                    <div key={group.category} className="space-y-2">
                      <div className="flex items-baseline gap-2 px-1">
                        <h3 className="text-sm font-semibold text-fg">{CATEGORY_META[group.category].title}</h3>
                        <span className="text-[13px] text-fg-muted">{CATEGORY_META[group.category].description}</span>
                      </div>
                      <List aria-label={CATEGORY_META[group.category].title}>
                        {group.checks.map((check) => row(check, { compact: check.status === 'ok' }))}
                      </List>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </FadeIn>
        ) : null}

        <Section
          title={advanced ? 'Runtimes' : 'Programs tools need'}
          description={
            advanced
              ? 'Detected on this computer, with versions and paths.'
              : 'Some tools need one of these programs to run. Claude Setup can install most of them for you.'
          }
          actions={
            <Button
              size="sm"
              variant="ghost"
              leftIcon={RotateCw}
              loading={runtimes.loading && !!runtimes.data}
              onClick={() => void runtimes.reload()}
            >
              Check again
            </Button>
          }
        >
          <RuntimesSection
            runtimes={runtimes.data}
            loading={runtimes.loading}
            error={runtimes.error}
            onRetry={() => void runtimes.reload()}
            onInstalled={() => {
              void runtimes.reload()
              if (report) void run()
            }}
            advanced={advanced}
          />
        </Section>
      </div>
    </>
  )
}
