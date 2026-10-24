import { useState } from 'react'
import { motion } from 'motion/react'
import { CircleCheck, OctagonAlert, Play, RefreshCw, Stethoscope, TriangleAlert } from 'lucide-react'
import type { DoctorReport } from '@shared/types'
import { Badge, Button, Card, ErrorState, IconTile, ProgressBar } from '@renderer/components/ui'
import { formatRelativeTime } from '@renderer/lib/format'
import { useInterval, type ProgressState } from '@renderer/lib/hooks'
import { CATEGORY_META, CATEGORY_ORDER, reportHeadline } from './meta'

export interface RunHeroProps {
  report: DoctorReport | null
  running: boolean
  progress: ProgressState | null
  error: string | null
  onRun: () => void
  advanced: boolean
}

const RUNNING_STEPS = CATEGORY_ORDER.map((c) => CATEGORY_META[c].running)

function Pulse() {
  return (
    <div className="relative grid size-24 place-items-center" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="absolute inset-0 rounded-full border border-accent/40 bg-accent/10"
          initial={{ scale: 0.55, opacity: 0.8 }}
          animate={{ scale: 1.45, opacity: 0 }}
          transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.8, ease: 'easeOut' }}
        />
      ))}
      <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}>
        <IconTile icon={Stethoscope} tone="accent" size="xl" />
      </motion.div>
    </div>
  )
}

/** The top of the Health Check page: a big "Run check" button, an animated progress state, then the summary. */
export function RunHero({ report, running, progress, error, onRun, advanced }: RunHeroProps) {
  const [tick, setTick] = useState(0)
  useInterval(() => setTick((t) => t + 1), running && !progress ? 900 : null)
  const message = progress?.message || RUNNING_STEPS[tick % RUNNING_STEPS.length]

  if (!report) {
    if (running) {
      return (
        <Card variant="hero" className="flex flex-col items-center gap-5 px-8 py-12 text-center" role="status" aria-live="polite">
          <Pulse />
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold tracking-[-0.01em] text-fg">Checking your setup…</h2>
            <p className="text-sm text-fg-muted">{message}</p>
          </div>
          <ProgressBar label="Running the health check" value={progress?.pct} className="w-72" />
        </Card>
      )
    }
    if (error) {
      return (
        <Card>
          <ErrorState title="The health check couldn’t run" error={error} onRetry={onRun} />
        </Card>
      )
    }
    return (
      <Card variant="hero" className="relative overflow-hidden px-8 py-12">
        <div
          aria-hidden="true"
          className="dot-grid pointer-events-none absolute inset-0 opacity-50 [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]"
        />
        <div className="relative flex flex-col items-center gap-5 text-center">
          <IconTile icon={Stethoscope} tone="accent" size="xl" />
          <div className="max-w-lg space-y-2">
            <h2 className="text-xl font-semibold tracking-[-0.015em] text-fg">Check your setup</h2>
            <p className="text-[15px] leading-6 text-fg-muted">
              Claude Setup looks for missing programs, broken settings and conflicts — and fixes most of them with one click.
              It takes a few
              seconds and changes nothing on its own.
            </p>
          </div>
          <Button variant="primary" size="lg" leftIcon={Play} onClick={onRun}>
            Run check
          </Button>
          <ul className="flex flex-wrap justify-center gap-1.5" aria-label="What gets checked">
            {CATEGORY_ORDER.map((c) => (
              <li key={c}>
                <Badge size="sm" variant="outline">
                  {advanced ? CATEGORY_META[c].title : CATEGORY_META[c].simple}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      </Card>
    )
  }

  const headline = reportHeadline(report)
  const icon = headline.tone === 'success' ? CircleCheck : headline.tone === 'warn' ? TriangleAlert : OctagonAlert
  const { summary } = report

  return (
    <Card variant={headline.tone === 'success' ? 'hero' : 'default'} className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-5 p-6">
        <motion.div
          key={report.ranAt}
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 380, damping: 22 }}
        >
          <IconTile icon={icon} tone={headline.tone} size="xl" />
        </motion.div>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl leading-7 font-semibold tracking-[-0.015em] text-fg">{headline.title}</h2>
          <p className="text-[13.5px] leading-5 text-fg-muted">{headline.subtitle}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Badge tone="success" dot>
              {summary.ok} OK
            </Badge>
            <Badge tone={summary.warn ? 'warn' : 'neutral'} dot>
              {summary.warn} {summary.warn === 1 ? 'warning' : 'warnings'}
            </Badge>
            <Badge tone={summary.error ? 'danger' : 'neutral'} dot>
              {summary.error} {summary.error === 1 ? 'problem' : 'problems'}
            </Badge>
            {advanced && summary.info ? (
              <Badge tone="info" dot>
                {summary.info} {summary.info === 1 ? 'note' : 'notes'}
              </Badge>
            ) : null}
            {advanced && summary.skip ? <Badge dot>{summary.skip} skipped</Badge> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Button leftIcon={RefreshCw} loading={running} onClick={onRun}>
            {running ? 'Checking…' : 'Run again'}
          </Button>
          <span className="text-xs text-fg-subtle">Checked {formatRelativeTime(report.ranAt)}</span>
        </div>
      </div>
      {running ? (
        <div className="border-t border-line px-6 py-3" role="status" aria-live="polite">
          <div className="mb-1.5 text-xs text-fg-muted">{message}</div>
          <ProgressBar size="sm" label="Running the health check" value={progress?.pct} />
        </div>
      ) : null}
    </Card>
  )
}
