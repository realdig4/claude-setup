/** Wizard step 4: live progress while adding, then per-app results, restart hint and an optional connection test. */
import { motion } from 'motion/react'
import { Activity, Check, CircleCheck, CircleX, TriangleAlert } from 'lucide-react'
import type { InstallResult, TestResult } from '@shared/types'
import { Button, Callout, IconTile, LoadingState, ProgressBar, Spinner } from '@renderer/components/ui'
import type { ProgressState } from '@renderer/lib/hooks'
import { joinList } from '@renderer/lib/format'
import { EASE_OUT } from '@renderer/lib/motion'
import { AppIcon } from '../common/apps'
import { RestartDesktopButton, useRestartPending } from '../common/restart'
import { TestResultView } from '../common/TestResultView'
import { TARGET_NAMES, refLabel } from '../lib/targets'

export interface StepResultProps {
  displayName: string
  installing: boolean
  progress: ProgressState | null
  result: InstallResult | null
  /** Unexpected error (the call itself failed). */
  error: string | null
  advanced: boolean
  testing: boolean
  testResult: TestResult | null
  onTest: () => void
}

/** Progress + outcome of the install. */
export function StepResult(props: StepResultProps) {
  const { displayName, installing, progress, result, error, advanced } = props
  const restartPending = useRestartPending()

  if (installing) {
    return (
      <div className="flex flex-col items-center gap-4 py-8 text-center" aria-busy="true">
        <Spinner size="lg" className="text-accent" label={null} />
        <div>
          <p className="text-[15px] font-semibold text-fg">Adding {displayName}…</p>
          <p className="mt-1 text-[13px] text-fg-muted" aria-live="polite">
            {progress?.message ?? 'Making a backup and saving the settings.'}
          </p>
        </div>
        <ProgressBar value={progress?.pct} label={`Adding ${displayName}`} className="w-full max-w-sm" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <IconTile icon={TriangleAlert} tone="danger" size="xl" />
        <p className="text-[15px] font-semibold text-fg">Couldn’t add {displayName}</p>
        <p className="max-w-md text-[13.5px] leading-6 text-fg-muted">{error}</p>
      </div>
    )
  }

  if (!result) return <LoadingState size="sm" label="Getting ready…" />

  const ok = result.results.filter((r) => r.ok)
  const failed = result.results.filter((r) => !r.ok)
  const apps = joinList([...new Set(ok.map((r) => TARGET_NAMES[r.target.target]))])
  const firstProblem = failed[0]?.message ?? result.warnings[0] ?? 'Something went wrong while saving the settings.'

  return (
    <div className="space-y-5">
      {result.ok ? (
        <div className="flex flex-col items-center gap-3 pt-2 pb-1 text-center">
          <SuccessMark />
          <div>
            <p className="text-[17px] font-semibold tracking-[-0.01em] text-fg">{displayName} is ready</p>
            <p className="mt-1 text-[13.5px] text-fg-muted">Claude can now use it in {apps}.</p>
          </div>
        </div>
      ) : ok.length ? (
        <div className="flex items-start gap-3">
          <IconTile icon={TriangleAlert} tone="warn" size="lg" />
          <div>
            <p className="text-[15px] font-semibold text-fg">Added to {apps} — but not everywhere</p>
            <p className="mt-0.5 text-[13px] text-fg-muted">See what happened below.</p>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <IconTile icon={TriangleAlert} tone="danger" size="lg" />
          <div className="min-w-0">
            <p className="text-[15px] font-semibold text-fg">Couldn’t add {displayName}</p>
            <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">{firstProblem}</p>
          </div>
        </div>
      )}

      {result.results.length > 1 || failed.length || advanced ? (
        <ul aria-label="Results" className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {result.results.map((r) => (
            <li key={`${r.target.target}|${r.target.scope ?? ''}|${r.target.projectPath ?? ''}`} className="flex items-start gap-3 px-4 py-3">
              <AppIcon target={r.target.target} size="sm" className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg">{advanced ? refLabel(r.target) : TARGET_NAMES[r.target.target]}</span>
                  {r.ok ? (
                    <CircleCheck className="size-4 text-success-text" aria-label="Added" role="img" />
                  ) : (
                    <CircleX className="size-4 text-danger-text" aria-label="Not added" role="img" />
                  )}
                </div>
                <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">{r.message}</p>
                {advanced && (r.backupId || r.configPath) ? (
                  <p className="mt-1 font-mono text-[11.5px] break-all text-fg-subtle">
                    {r.configPath}
                    {r.backupId ? ` · backup ${r.backupId}` : ''}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {restartPending && ok.some((r) => r.target.target === 'claude-desktop') ? (
        <Callout
          tone="warn"
          title="One more step: restart Claude Desktop"
          action={<RestartDesktopButton size="sm" variant="outline">Restart now</RestartDesktopButton>}
        >
          Claude Desktop loads tools when it starts.
        </Callout>
      ) : null}

      {result.warnings.length && ok.length ? (
        <ul className="space-y-1 text-[12.5px] leading-5 text-fg-muted">
          {result.warnings.map((w) => (
            <li key={w}>• {w}</li>
          ))}
        </ul>
      ) : null}

      {ok.length ? (
        <div className="rounded-xl border border-line bg-surface-2/40 p-4">
          {props.testResult && !props.testing ? (
            <div className="space-y-3">
              <TestResultView result={props.testResult} name={displayName} maxTools={8} />
              <Button size="sm" variant="ghost" leftIcon={Activity} onClick={props.onTest}>
                Test again
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">Check that it works</p>
                <p className="text-[12.5px] text-fg-muted">
                  {props.testing ? 'Starting it up… the first run can take a minute.' : 'Starts the tool for a moment and lists what it can do.'}
                </p>
              </div>
              <Button size="sm" variant="outline" leftIcon={Activity} loading={props.testing} onClick={props.onTest}>
                {props.testing ? 'Testing…' : 'Test connection'}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

const SPARKS = [0, 60, 120, 180, 240, 300]

/** Animated check mark with a soft burst — a small, calm celebration. */
function SuccessMark() {
  return (
    <div className="relative grid size-20 place-items-center" aria-hidden="true">
      <motion.span
        className="absolute inset-2 rounded-full bg-success/25"
        initial={{ scale: 0.7, opacity: 0.9 }}
        animate={{ scale: 1.9, opacity: 0 }}
        transition={{ duration: 1, ease: EASE_OUT, delay: 0.1 }}
      />
      {SPARKS.map((deg, i) => (
        <motion.span
          key={deg}
          className={i % 2 ? 'absolute size-1.5 rounded-full bg-accent' : 'absolute size-1.5 rounded-full bg-success'}
          initial={{ x: 0, y: 0, opacity: 0, scale: 0.4 }}
          animate={{
            x: Math.cos((deg * Math.PI) / 180) * 38,
            y: Math.sin((deg * Math.PI) / 180) * 38,
            opacity: [0, 1, 0],
            scale: [0.4, 1, 0.6]
          }}
          transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.15 }}
        />
      ))}
      <motion.span
        className="relative grid size-14 place-items-center rounded-full bg-success-soft text-success-text ring-1 ring-success-line"
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 420, damping: 20 }}
      >
        <Check className="size-7" strokeWidth={2.5} />
      </motion.span>
    </div>
  )
}
