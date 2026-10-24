/** The three onboarding steps: welcome, what was found on this computer, and Simple vs Advanced. */
import { forwardRef } from 'react'
import { Blocks, BrainCircuit, Container, Cpu, ShieldCheck, SlidersHorizontal, Sparkles, Stethoscope, Terminal } from 'lucide-react'
import type { RuntimeInfo, RuntimeName, TargetInfo } from '@shared/types'
import { Badge, ErrorState, ExternalLink, IconTile, OptionCard, OptionCardGroup, Skeleton } from '@renderer/components/ui'
import { APP_BLURBS, APP_GET_URLS, AppIcon } from '../../discover/common/apps'
import { sortTargets } from '../../discover/lib/targets'
import { HelperRow, InstallButton } from './HelperRow'

/** Step heading (focused on step change so screen readers announce it). */
export const StepHeading = forwardRef<HTMLHeadingElement, { title: string; subtitle: string }>(function StepHeading({ title, subtitle }, ref) {
  return (
    <div className="mb-6">
      <h1 ref={ref} tabIndex={-1} className="text-[26px] leading-[34px] font-semibold tracking-[-0.022em] text-fg outline-none">
        {title}
      </h1>
      <p className="mt-1.5 text-[15px] leading-6 text-fg-muted">{subtitle}</p>
    </div>
  )
})

const FEATURES = [
  { icon: Blocks, title: 'Add tools to Claude', text: 'Let Claude read your files, search the web, work with GitHub and much more.' },
  { icon: BrainCircuit, title: 'Choose your AI model', text: 'Use Kimi, DeepSeek, GLM and others in Claude Code if you like.' },
  { icon: Stethoscope, title: 'Fix problems for you', text: 'Find common setup issues and fix them with one click.' }
]

/** Step 1: what Claude Setup does. */
export function WelcomeStep() {
  return (
    <div className="space-y-6">
      <ul className="space-y-3">
        {FEATURES.map((f) => (
          <li key={f.title} className="flex items-start gap-3.5 rounded-xl border border-line bg-surface p-4 shadow-xs">
            <IconTile icon={f.icon} tone="accent" size="md" />
            <div>
              <p className="text-sm font-semibold text-fg">{f.title}</p>
              <p className="mt-0.5 text-[13.5px] leading-5 text-fg-muted">{f.text}</p>
            </div>
          </li>
        ))}
      </ul>
      <div className="space-y-2 text-[13px] leading-5 text-fg-muted">
        <p className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success-text" aria-hidden="true" />
          Every settings file is backed up before it changes, so you can always undo.
        </p>
        <p className="pl-6 text-xs text-fg-subtle">
          Claude Setup is an unofficial helper made for Claude — it isn’t made by or affiliated with Anthropic.
        </p>
      </div>
    </div>
  )
}

const HELPERS: Array<{ id: RuntimeName; purpose: string; optional?: boolean; icon: typeof Cpu }> = [
  { id: 'node', purpose: 'Runs most tools. Needed for almost everything.', icon: Cpu },
  { id: 'uv', purpose: 'Runs tools written in Python.', icon: Terminal },
  { id: 'docker', purpose: 'Runs tools packaged as containers. Optional — only a few tools need it.', optional: true, icon: Container }
]

export interface DetectStepProps {
  targets: TargetInfo[]
  targetsReady: boolean
  targetsError: string | null
  onRetryTargets: () => void
  runtimes: RuntimeInfo[] | undefined
  runtimesError: string | null
  onRetryRuntimes: () => void
  onInstalled: (id: RuntimeName) => void
  advanced: boolean
}

/** Step 2: Claude apps and helper programs found on this computer. */
export function DetectStep(props: DetectStepProps) {
  const { targets, runtimes, advanced } = props
  const claude = runtimes?.find((r) => r.id === 'claude')
  return (
    <div className="space-y-7">
      <section aria-labelledby="onb-apps" className="space-y-2.5">
        <h2 id="onb-apps" className="text-[13px] font-semibold text-fg">
          Apps
        </h2>
        {!props.targetsReady && props.targetsError ? (
          <ErrorState size="sm" framed title="Couldn’t look for your apps" error={props.targetsError} onRetry={props.onRetryTargets} />
        ) : !props.targetsReady ? (
          <Skeleton className="h-56 rounded-xl" aria-label="Looking for your apps" />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
            {sortTargets(targets).map((t) => (
              <li key={t.id} className="flex items-center gap-3.5 px-4 py-3">
                <AppIcon target={t.id} size="md" tone={t.installed ? 'accent' : 'neutral'} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2">
                    <span className="text-sm font-medium text-fg">{t.label}</span>
                    {advanced && t.version ? <span className="font-mono text-xs text-fg-subtle">{t.version}</span> : null}
                  </div>
                  <p className="truncate text-[13px] text-fg-muted">{APP_BLURBS[t.id]}</p>
                </div>
                {t.installed ? (
                  <Badge size="sm" tone="success" dot>
                    Found
                  </Badge>
                ) : t.primary ? (
                  t.id === 'claude-code' && claude && !claude.found && claude.install?.canAutoInstall ? (
                    <InstallButton runtime={claude} label="Install" onInstalled={props.onInstalled} />
                  ) : (
                    <ExternalLink href={APP_GET_URLS[t.id]} className="text-[13px]">
                      {t.id === 'claude-desktop' ? 'Get it' : 'How to install'}
                    </ExternalLink>
                  )
                ) : (
                  <span className="text-xs text-fg-subtle">Not installed</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="onb-helpers" className="space-y-2.5">
        <div>
          <h2 id="onb-helpers" className="text-[13px] font-semibold text-fg">
            Helpers that tools need
          </h2>
          <p className="text-[12.5px] text-fg-muted">You can install these now or later — Claude Setup will remind you when a tool needs one.</p>
        </div>
        {!runtimes && props.runtimesError ? (
          <ErrorState size="sm" framed title="Couldn’t check the helpers" error={props.runtimesError} onRetry={props.onRetryRuntimes} />
        ) : !runtimes ? (
          <Skeleton className="h-44 rounded-xl" aria-label="Checking helpers" />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
            {HELPERS.map((h) => {
              const runtime = runtimes.find((r) => r.id === h.id)
              if (!runtime) return null
              return (
                <HelperRow
                  key={h.id}
                  runtime={runtime}
                  purpose={h.purpose}
                  optional={h.optional}
                  advanced={advanced}
                  icon={<IconTile icon={h.icon} tone={runtime.found ? 'success' : h.optional ? 'neutral' : 'warn'} size="md" />}
                  onInstalled={props.onInstalled}
                />
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

export interface StyleStepProps {
  mode: 'simple' | 'advanced'
  onChange: (mode: 'simple' | 'advanced') => void
}

/** Step 3: pick Simple or Advanced. */
export function StyleStep({ mode, onChange }: StyleStepProps) {
  return (
    <div className="space-y-4">
      <OptionCardGroup label="How Claude Setup should look" type="radio" columns={1}>
        <OptionCard
          size="lg"
          type="radio"
          checked={mode === 'simple'}
          onCheckedChange={() => onChange('simple')}
          icon={Sparkles}
          title="Simple"
          badge={
            <Badge size="sm" tone="accent">
              Recommended
            </Badge>
          }
          description="Plain words, big buttons and guided steps. Perfect if you’ve never edited a config file."
        />
        <OptionCard
          size="lg"
          type="radio"
          checked={mode === 'advanced'}
          onCheckedChange={() => onChange('advanced')}
          icon={SlidersHorizontal}
          title="Advanced"
          description="Everything in Simple, plus the raw config, where each tool is saved, environment variables, the proxy and backups."
        />
      </OptionCardGroup>
      <p className="text-[13px] text-fg-muted">You can switch any time at the bottom of the sidebar.</p>
    </div>
  )
}
