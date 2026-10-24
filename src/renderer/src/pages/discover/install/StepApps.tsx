/** Wizard step 1: choose the apps (and, in Advanced mode, where in them) to add the tool to. */
import { CircleAlert } from 'lucide-react'
import type { TargetInfo, TargetRef } from '@shared/types'
import { Badge, Callout, Checkbox, ErrorState, ExternalLink, OptionCard, OptionCardGroup, Skeleton } from '@renderer/components/ui'
import { APP_BLURBS, APP_GET_URLS, AppIcon } from '../common/apps'
import { orderRefs, sortTargets, userRef } from '../lib/targets'
import { ScopeRows } from './ScopeRows'

export interface StepAppsProps {
  targets: TargetInfo[]
  ready: boolean
  error: string | null
  onRetry: () => void
  selected: TargetRef[]
  onChange: (refs: TargetRef[]) => void
  advanced: boolean
  recentProjects: readonly string[]
  /** Problem to show (after the person pressed Next). */
  problem: string | null
  showErrors: boolean
  /** Offer "remember these apps" (selection differs from the saved defaults). */
  canRemember: boolean
  remember: boolean
  onRememberChange: (value: boolean) => void
  /** The chosen way to run it is online (Claude Desktop bridges it). */
  remote: boolean
}

/** App picker with big friendly cards. */
export function StepApps(props: StepAppsProps) {
  const { targets, ready, error, onRetry, selected, onChange, advanced, recentProjects, problem, showErrors } = props

  if (!ready && error) return <ErrorState size="sm" title="Couldn’t check your apps" error={error} onRetry={onRetry} />
  if (!ready) {
    return (
      <div className="@container" aria-busy="true" aria-label="Looking for your apps">
        <div className="grid grid-cols-1 gap-3 @md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[84px] rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  const toggle = (target: TargetInfo, checked: boolean): void => {
    if (checked) onChange(orderRefs([...selected.filter((r) => r.target !== target.id), userRef(target.id)]))
    else onChange(selected.filter((r) => r.target !== target.id))
  }

  const noneInstalled = targets.length > 0 && targets.every((t) => !t.installed)

  return (
    <div className="space-y-5">
      {noneInstalled ? (
        <Callout tone="warn" title="No Claude apps found on this computer">
          Install Claude Desktop or Claude Code first, then come back — your tool will be one click away.{' '}
          <span className="mt-1 flex flex-wrap gap-x-4">
            <ExternalLink href={APP_GET_URLS['claude-desktop']}>Get Claude Desktop</ExternalLink>
            <ExternalLink href={APP_GET_URLS['claude-code']}>Install Claude Code</ExternalLink>
          </span>
        </Callout>
      ) : null}
      <OptionCardGroup label="Apps to add the tool to" type="checkbox" columns={2}>
        {sortTargets(targets).map((target) => {
          const checked = selected.some((r) => r.target === target.id)
          return (
            <OptionCard
              key={target.id}
              type="checkbox"
              checked={checked}
              disabled={!target.installed}
              onCheckedChange={(next) => toggle(target, next)}
              icon={<AppIcon target={target.id} tone={checked ? 'accent' : 'neutral'} />}
              title={target.label}
              description={target.installed ? describe(target, props.remote) : 'Not installed on this computer'}
              badge={
                !target.installed ? (
                  <Badge size="sm" tone="neutral">
                    Not installed
                  </Badge>
                ) : target.primary ? null : advanced && target.version ? (
                  <Badge size="sm" variant="outline">
                    {target.version}
                  </Badge>
                ) : null
              }
            />
          )
        })}
      </OptionCardGroup>

      {advanced ? (
        <ScopeRows refs={selected} targets={targets} onChange={onChange} recentProjects={recentProjects} showErrors={showErrors} />
      ) : null}

      {props.canRemember ? (
        <Checkbox
          checked={props.remember}
          onCheckedChange={props.onRememberChange}
          label="Use these apps next time too"
          description="They’ll be picked for you when you add another tool."
        />
      ) : null}

      {showErrors && problem ? (
        <p role="alert" className="flex items-center gap-1.5 text-[13px] text-danger-text">
          <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
          {problem}
        </p>
      ) : null}
    </div>
  )
}

function describe(target: TargetInfo, remote: boolean): string {
  if (target.id === 'claude-desktop' && remote) return `${APP_BLURBS[target.id]} · connects through a small helper`
  if (target.id === 'claude-desktop' && target.running) return `${APP_BLURBS[target.id]} · open now`
  return APP_BLURBS[target.id]
}
