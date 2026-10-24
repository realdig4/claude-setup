import { motion } from 'motion/react'
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  CircleCheck,
  CircleX,
  Info,
  KeyRound,
  Link2,
  ListChecks,
  RotateCcw,
  TriangleAlert,
  Wallet
} from 'lucide-react'
import type { ConnectionTestResult, ProviderPreset } from '@shared/types'
import { AdvancedOnly, Badge, Button, Disclosure, IconTile, ProgressBar, openExternal, type IconProp } from '@renderer/components/ui'
import { formatDuration } from '@renderer/lib/format'
import { verdictInfo, type VerdictAction } from '../logic'

export type TestState =
  | { status: 'idle' }
  | { status: 'running'; key: string }
  | { status: 'done'; key: string; result: ConnectionTestResult }
  | { status: 'failed'; key: string; error: string }

export interface StepTestProps {
  preset: ProviderPreset
  state: TestState
  /** Why the test is skipped by default (cloud sign-in, Claude account), or null. */
  skipReason: string | null
  onRun: () => void
  onGoTo: (step: 'account' | 'models') => void
  onLoadModels: () => void
}

const VERDICT_ICONS: Record<ConnectionTestResult['verdict'], IconProp> = {
  ok: CircleCheck,
  'bad-key': KeyRound,
  'bad-model': ListChecks,
  'bad-url': Link2,
  quota: Wallet,
  network: CircleX,
  unknown: TriangleAlert
}

/** Pulsing rings around an icon while the test runs (respects reduced motion via MotionConfig). */
function Pulse() {
  return (
    <div className="relative grid size-20 place-items-center" aria-hidden="true">
      {[0, 1].map((i) => (
        <motion.span
          key={i}
          className="absolute inset-0 rounded-full bg-accent/25"
          initial={{ scale: 0.6, opacity: 0.7 }}
          animate={{ scale: 1.35, opacity: 0 }}
          transition={{ duration: 1.8, repeat: Infinity, delay: i * 0.9, ease: 'easeOut' }}
        />
      ))}
      <IconTile icon={Activity} tone="accent" size="xl" />
    </div>
  )
}

/** Step 3: send one tiny request and explain the verdict with helpful next steps. */
export function StepTest({ preset, state, skipReason, onRun, onGoTo, onLoadModels }: StepTestProps) {
  const name = preset.name.replace(/\s*\(.*\)$/, '')

  if (state.status === 'idle' && skipReason) {
    return (
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        <IconTile icon={Info} tone="info" size="xl" />
        <div className="max-w-md space-y-1.5">
          <h3 className="text-base font-semibold text-fg">No test needed</h3>
          <p className="text-sm leading-6 text-fg-muted">{skipReason}</p>
        </div>
        {preset.kind === 'cloud' ? (
          <Button size="sm" variant="ghost" leftIcon={Activity} onClick={onRun}>
            Test anyway
          </Button>
        ) : null}
      </div>
    )
  }

  if (state.status === 'idle' || state.status === 'running') {
    return (
      <div className="flex flex-col items-center gap-5 py-8 text-center" role="status" aria-live="polite">
        <Pulse />
        <div className="max-w-sm space-y-1.5">
          <h3 className="text-base font-semibold text-fg">Talking to {name}…</h3>
          <p className="text-sm leading-6 text-fg-muted">Sending one tiny test message. It costs a few tokens at most.</p>
        </div>
        <ProgressBar label={`Testing the connection to ${name}`} className="w-64" />
      </div>
    )
  }

  if (state.status === 'failed') {
    return (
      <div className="flex flex-col items-center gap-4 py-6 text-center" role="alert">
        <IconTile icon={TriangleAlert} tone="danger" size="xl" />
        <div className="max-w-md space-y-1.5">
          <h3 className="text-base font-semibold text-fg">The test couldn’t run</h3>
          <p className="text-sm leading-6 text-fg-muted">{state.error}</p>
        </div>
        <Button leftIcon={RotateCcw} onClick={onRun}>
          Test again
        </Button>
      </div>
    )
  }

  const { result } = state
  const info = verdictInfo(result, preset)
  const ok = result.verdict === 'ok'

  const actionButton = (action: VerdictAction | undefined) => {
    switch (action) {
      case 'key':
        return (
          <Button size="sm" leftIcon={ArrowLeft} onClick={() => onGoTo('account')}>
            Change the key
          </Button>
        )
      case 'models':
        return (
          <>
            <Button size="sm" leftIcon={ArrowLeft} onClick={() => onGoTo('models')}>
              Pick another model
            </Button>
            {preset.listModels ? (
              <Button size="sm" variant="ghost" onClick={onLoadModels}>
                Load models
              </Button>
            ) : null}
          </>
        )
      case 'address':
        return (
          <Button size="sm" leftIcon={ArrowLeft} onClick={() => onGoTo('account')}>
            Check the address
          </Button>
        )
      case 'billing':
        return preset.website ? (
          <Button size="sm" rightIcon={ArrowUpRight} onClick={() => void openExternal(preset.website ?? '')}>
            Open {preset.vendor}
          </Button>
        ) : null
      default:
        return null
    }
  }

  return (
    <div className="flex flex-col items-center gap-5 py-4 text-center" role={ok ? 'status' : 'alert'}>
      <motion.div
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 420, damping: 24 }}
      >
        <IconTile icon={VERDICT_ICONS[result.verdict]} tone={info.tone} size="xl" />
      </motion.div>
      <div className="max-w-md space-y-1.5">
        <h3 className="text-lg font-semibold tracking-[-0.01em] text-fg">{info.title}</h3>
        <p className="text-sm leading-6 text-fg-muted">{result.message}</p>
        <div className="flex flex-wrap items-center justify-center gap-1.5 pt-1">
          <Badge size="sm">{formatDuration(result.ms)}</Badge>
          <AdvancedOnly>{result.status ? <Badge size="sm">HTTP {result.status}</Badge> : null}</AdvancedOnly>
        </div>
      </div>

      {ok && result.sample ? (
        <figure className="max-w-md rounded-2xl rounded-tl-md border border-line bg-surface-2/70 px-4 py-3 text-left">
          <figcaption className="text-xs font-medium text-fg-subtle">{name} replied</figcaption>
          <blockquote className="mt-1 text-sm leading-6 text-fg">“{result.sample}”</blockquote>
        </figure>
      ) : null}

      {!ok ? (
        <div className="w-full max-w-md rounded-xl border border-line bg-surface px-4 py-3 text-left">
          <p className="text-xs font-semibold tracking-wide text-fg-muted uppercase">What to try</p>
          <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-[13px] leading-5 text-fg-muted marker:text-fg-subtle">
            {info.tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            {actionButton(info.action)}
            <Button size="sm" variant="ghost" leftIcon={RotateCcw} onClick={onRun}>
              Test again
            </Button>
          </div>
        </div>
      ) : null}

      {!ok ? (
        <AdvancedOnly>
          <Disclosure title="Technical details" className="w-full max-w-md text-left">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs text-fg-muted">
              <dt>verdict</dt>
              <dd className="text-fg">{result.verdict}</dd>
              <dt>status</dt>
              <dd className="text-fg">{result.status ?? '—'}</dd>
              <dt>time</dt>
              <dd className="text-fg">{result.ms} ms</dd>
            </dl>
          </Disclosure>
        </AdvancedOnly>
      ) : null}
    </div>
  )
}
