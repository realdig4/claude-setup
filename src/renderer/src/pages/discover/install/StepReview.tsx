/** Wizard step 3: what will happen in each app, missing helpers to install, and anything worth knowing. */
import { CircleCheck, CircleX, Info, SlidersHorizontal } from 'lucide-react'
import type { InstallPreview, TargetRef } from '@shared/types'
import { Button, Callout, Checkbox, CodeBlock, Disclosure, ErrorState, PathText, Skeleton } from '@renderer/components/ui'
import type { AsyncState } from '@renderer/lib/hooks'
import { joinList, maskSecret } from '@renderer/lib/format'
import { AppIcon } from '../common/apps'
import { RuntimeFix } from '../common/RuntimeFix'
import { humanizeName, maskSecrets } from '../lib/installForm'
import { TARGET_NAMES, refLabel } from '../lib/targets'

export interface StepReviewProps {
  preview: AsyncState<InstallPreview>
  displayName: string
  /** Config name that will be written. */
  name: string
  advanced: boolean
  /** Typed secrets to hide in snippets. */
  secrets: readonly string[]
  /** Selected places that already have a tool with this name. */
  conflicts: readonly TargetRef[]
  overwrite: boolean
  onOverwriteChange: (value: boolean) => void
  /** Jump back to the settings step (missing values). */
  onEditSettings?: () => void
  /** Simple mode: show the optional settings step. */
  onMoreOptions?: () => void
  /** Drop the places that already have the tool (offered when other places remain). */
  onSkipConflicts?: () => void
}

/** Review of the planned change. */
export function StepReview(props: StepReviewProps) {
  const { preview, advanced, secrets, conflicts } = props
  const data = preview.data
  const hide = (text: string): string => maskSecrets(text, secrets, (s) => maskSecret(s))

  if (preview.error && !data) {
    return <ErrorState size="sm" title="Couldn’t prepare the change" error={preview.error} onRetry={() => void preview.reload()} />
  }
  if (!data) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Preparing the change">
        <Skeleton className="h-[68px] rounded-xl" />
        <Skeleton className="h-[68px] rounded-xl" />
        <Skeleton className="h-12 rounded-xl" />
      </div>
    )
  }

  if (data.targets.length === 0) {
    return (
      <Callout
        tone="danger"
        title="This can’t be added yet"
        action={
          props.onEditSettings ? (
            <Button size="sm" onClick={props.onEditSettings}>
              Go back
            </Button>
          ) : undefined
        }
      >
        {data.warnings.join(' ') || 'Something in the settings isn’t right. Go back and check them.'}
      </Callout>
    )
  }

  const missing = data.missingValues
  // The conflict callout below already explains duplicates; don't repeat the core's note about them.
  const info = data.warnings.filter((w) => !!w && !(conflicts.length && w.includes(props.name) && /already/i.test(w)))

  return (
    <div className="space-y-4">
      <ul aria-label="What will happen" className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {data.targets.map((t) => (
          <li key={`${t.target.target}|${t.target.scope ?? ''}|${t.target.projectPath ?? ''}`} className="px-4 py-3.5">
            <div className="flex items-start gap-3">
              <AppIcon target={t.target.target} size="sm" tone={t.supported ? 'neutral' : 'danger'} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-sm font-medium text-fg">{advanced ? refLabel(t.target) : TARGET_NAMES[t.target.target]}</span>
                  {t.supported ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-success-text">
                      <CircleCheck className="size-3.5" aria-hidden="true" /> Ready to add
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-danger-text">
                      <CircleX className="size-3.5" aria-hidden="true" /> Can’t be added here
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
                  {t.note ?? (t.supported ? `Claude will be able to use ${props.displayName} in ${TARGET_NAMES[t.target.target]}.` : '')}
                </p>
                {advanced && t.configPath ? <PathText path={t.configPath} copy reveal className="mt-1.5" /> : null}
                {advanced && t.snippet ? (
                  <Disclosure title="Show the change" className="mt-1" defaultOpen={data.targets.length === 1}>
                    <CodeBlock code={hide(t.snippet)} language="json" maxHeight={220} />
                  </Disclosure>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {conflicts.length ? (
        <Callout tone="warn" title={`A tool named “${props.name}” is already there`}>
          <p>
            {joinList(conflicts.map(refLabel))} already {conflicts.length === 1 ? 'has' : 'have'} it.{' '}
            {advanced ? 'Replace it, or go back and change the name.' : 'Replace it with this one?'}
          </p>
          <Checkbox
            className="mt-2.5"
            checked={props.overwrite}
            onCheckedChange={props.onOverwriteChange}
            label="Replace the existing one"
            description="A backup is made first, so you can undo this."
          />
          {props.onSkipConflicts && !props.overwrite ? (
            <Button variant="link" size="sm" className="mt-2" onClick={props.onSkipConflicts}>
              Only add it to the other {data.targets.length - conflicts.length === 1 ? 'app' : 'apps'}
            </Button>
          ) : null}
        </Callout>
      ) : null}

      {data.missingRuntimes.map((runtime) => (
        <RuntimeFix key={runtime.id} runtime={runtime} onResolved={() => void preview.reload()} />
      ))}

      {missing.length ? (
        <Callout
          tone="danger"
          title="Some required settings are missing"
          action={props.onEditSettings ? <Button size="sm" onClick={props.onEditSettings}>Fill them in</Button> : undefined}
        >
          {joinList(missing.map((m) => (advanced ? m : humanizeName(m))))}
        </Callout>
      ) : null}

      {info.length ? (
        <Callout tone="info" icon={Info} title="Good to know">
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
            {info.map((w) => (
              <li key={w}>{hide(w)}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {advanced ? (
        <Disclosure title="Server settings" description="What every app will run">
          <CodeBlock code={hide(JSON.stringify(data.config, null, 2))} language="json" maxHeight={240} />
        </Disclosure>
      ) : null}

      {props.onMoreOptions ? (
        <Button variant="link" size="sm" leftIcon={SlidersHorizontal} onClick={props.onMoreOptions}>
          More options
        </Button>
      ) : null}
    </div>
  )
}
