import { ArrowRight, Code2, RotateCcw, SquareTerminal, Stethoscope, TriangleAlert } from 'lucide-react'
import type { ModelProfile, ModelStatus, ProviderPreset } from '@shared/types'
import { AdvancedOnly, Badge, Button, Card, ErrorState, KeyValue, Monogram, Skeleton, Tooltip } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { useNavigate } from '@renderer/lib/store'
import { statusHeadline } from './logic'

export interface ModelStatusCardProps {
  status: ModelStatus | undefined
  loading: boolean
  error: string | null
  onRetry: () => void
  providers: ProviderPreset[] | undefined
  profiles: ModelProfile[] | undefined
  onReset: () => void
  /** Apply the active setup to VS Code too (when it differs or is missing). */
  onSyncVsCode?: () => void
  syncing?: boolean
}

const AUTH_LABELS: Record<NonNullable<ModelStatus['authVar']>, string> = {
  ANTHROPIC_AUTH_TOKEN: 'Token (ANTHROPIC_AUTH_TOKEN)',
  ANTHROPIC_API_KEY: 'API key (ANTHROPIC_API_KEY)',
  apiKeyHelper: 'Key helper (apiKeyHelper)'
}

/** "Claude Code is using: …" banner with where it applies, problems and a way back to official Claude. */
export function ModelStatusCard(props: ModelStatusCardProps) {
  const { status, loading, error, onRetry, providers, profiles, onReset, onSyncVsCode, syncing } = props
  const navigate = useNavigate()

  if (!status) {
    if (error) {
      return (
        <Card>
          <ErrorState size="sm" title="Couldn’t check which model Claude Code uses" error={error} onRetry={onRetry} />
        </Card>
      )
    }
    return (
      <Card className="p-6" aria-busy={loading || undefined} aria-label="Loading the current model">
        <div className="flex items-center gap-4">
          <Skeleton className="size-14 rounded-2xl" />
          <div className="flex-1 space-y-2.5">
            <Skeleton className="h-3 w-36" />
            <Skeleton className="h-6 w-64 max-w-full" />
            <Skeleton className="h-3.5 w-80 max-w-full" />
          </div>
        </div>
      </Card>
    )
  }

  const preset = providers?.find((p) => p.id === status.providerId)
  const profile = profiles?.find((p) => p.id === status.profileId)
  const official = status.mode === 'anthropic'
  const headline = statusHeadline(status, preset, profile)
  const monogram = official
    ? { text: 'Claude', letters: 'C', color: '#D97757' }
    : { text: preset?.name ?? headline.title, letters: preset?.monogram, color: preset?.color }
  const vscodeDiffers = status.vscodeConfigured && !status.vscodeMatches
  const vscodeMissing = !official && !status.vscodeConfigured

  return (
    <Card variant={official ? 'default' : 'hero'} className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-5 p-6">
        <Monogram text={monogram.text} letters={monogram.letters} color={monogram.color} size="xl" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Claude Code is using</p>
          <h2 className="mt-0.5 truncate text-xl leading-7 font-semibold tracking-[-0.015em] text-fg">{headline.title}</h2>
          <p className="truncate text-[13.5px] leading-5 text-fg-muted">{headline.subtitle}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <Badge size="sm" tone="success" icon={SquareTerminal}>
              Terminal
            </Badge>
            {official ? (
              <Badge size="sm" tone={status.vscodeConfigured ? 'warn' : 'success'} icon={Code2}>
                {status.vscodeConfigured ? 'VS Code has other settings' : 'VS Code'}
              </Badge>
            ) : vscodeDiffers ? (
              <Badge size="sm" tone="warn" icon={Code2}>
                VS Code uses different settings
              </Badge>
            ) : status.vscodeConfigured ? (
              <Badge size="sm" tone="success" icon={Code2}>
                VS Code
              </Badge>
            ) : (
              <Tooltip content="The VS Code extension keeps using Claude until this setup is applied to it.">
                <Badge size="sm" icon={Code2}>
                  Not in VS Code
                </Badge>
              </Tooltip>
            )}
            {profile ? (
              <Badge size="sm" variant="outline">
                Setup: {profile.name}
              </Badge>
            ) : null}
          </div>
        </div>
        {!official ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button leftIcon={RotateCcw} onClick={onReset}>
              Switch back to Claude
            </Button>
          </div>
        ) : null}
      </div>

      {(vscodeDiffers || vscodeMissing) && onSyncVsCode && profile ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-line bg-surface-2/50 px-6 py-3">
          <Code2 className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-[13px] text-fg-muted">
            {vscodeDiffers
              ? 'The VS Code extension is set up differently from the terminal.'
              : 'Use the same model in the VS Code extension too — otherwise it keeps asking you to sign in to Claude.'}
          </p>
          <Button size="sm" onClick={onSyncVsCode} loading={syncing}>
            Use in VS Code too
          </Button>
        </div>
      ) : null}

      {status.problems.length > 0 ? (
        <div className={cn('border-t border-warn-line/70 bg-warn-soft/60 px-6 py-4')} role="status">
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 size-[18px] shrink-0 text-warn-text" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-fg">
                {status.problems.length === 1 ? 'One thing needs attention' : `${status.problems.length} things need attention`}
              </p>
              <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-[13px] leading-5 text-fg-muted marker:text-warn-text">
                {status.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
            <Button size="sm" leftIcon={Stethoscope} rightIcon={ArrowRight} onClick={() => navigate('doctor', { run: true })}>
              Fix with Health Check
            </Button>
          </div>
        </div>
      ) : null}

      <AdvancedOnly>
        {!official || status.shellOverrides.length > 0 ? (
          <div className="border-t border-line px-6 py-4">
            <KeyValue
              items={[
                status.providerName ? { label: 'Provider', value: status.providerName } : null,
                status.model ? { label: 'Model', value: status.model, mono: true, copy: status.model } : null,
                status.baseUrl ? { label: 'Address', value: status.baseUrl, mono: true, copy: status.baseUrl } : null,
                status.authVar ? { label: 'Sign-in', value: AUTH_LABELS[status.authVar] } : null,
                status.shellOverrides.length
                  ? {
                      label: 'Shell variables',
                      value: (
                        <span className="flex flex-wrap gap-1">
                          {status.shellOverrides.map((name) => (
                            <code key={name} className="rounded bg-surface-3/70 px-1.5 py-0.5 font-mono text-[11.5px] text-fg">
                              {name}
                            </code>
                          ))}
                        </span>
                      ),
                      hint: 'Set in your terminal’s environment. Values in Claude Code’s settings file win over them.'
                    }
                  : null
              ]}
            />
          </div>
        ) : null}
      </AdvancedOnly>
    </Card>
  )
}
