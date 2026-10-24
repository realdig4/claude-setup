import { Code2, ShieldAlert, SquareTerminal, Waypoints } from 'lucide-react'
import type { ModelTarget, ProviderPreset } from '@shared/types'
import {
  AdvancedOnly,
  Badge,
  Callout,
  CodeBlock,
  Disclosure,
  Field,
  Input,
  OptionCard,
  OptionCardGroup
} from '@renderer/components/ui'
import { CAVEAT, TARGET_LABELS, isThirdParty, usesProxy } from '../logic'
import type { WizardDraft } from './draft'

export interface StepApplyProps {
  preset: ProviderPreset
  draft: WizardDraft
  onChange: (patch: Partial<WizardDraft>) => void
  errors: Partial<Record<'name' | 'targets', string>>
  vscodeInstalled: boolean
  /** Shown above the form when saving failed. */
  saveError: string | null
  busy: boolean
  /** Editing the setup Claude Code uses right now. */
  active: boolean
  /** The profile that will be saved (key masked), for the Advanced JSON preview. */
  preview: unknown
}

const TARGET_ICONS: Record<ModelTarget, typeof SquareTerminal> = { 'claude-code': SquareTerminal, vscode: Code2 }

/** Step 4: choose where to use the setup and how to name it. */
export function StepApply({ preset, draft, onChange, errors, vscodeInstalled, saveError, busy, active, preview }: StepApplyProps) {
  const toggle = (target: ModelTarget, on: boolean): void => {
    const set = new Set(draft.targets)
    if (on) set.add(target)
    else set.delete(target)
    onChange({ targets: (['claude-code', 'vscode'] as const).filter((t) => set.has(t)) })
  }

  return (
    <div className="flex flex-col gap-6">
      {saveError ? (
        <Callout tone="danger" title="Couldn’t save this setup" role="alert">
          {saveError}
        </Callout>
      ) : null}

      {active ? (
        <Callout tone="info" title="This setup is in use right now">
          Choose “Save and use” to update Claude Code too. “Save only” keeps the old settings until you use it again.
        </Callout>
      ) : null}

      <div className="flex flex-col gap-2.5">
        <span className="text-[13px] font-medium text-fg">Where should Claude Code use it?</span>
        <OptionCardGroup label="Where to use this setup" type="checkbox" columns={2}>
          {(['claude-code', 'vscode'] as const).map((target) => (
            <OptionCard
              key={target}
              type="checkbox"
              size="lg"
              icon={TARGET_ICONS[target]}
              title={TARGET_LABELS[target].title}
              description={TARGET_LABELS[target].description}
              badge={target === 'vscode' && !vscodeInstalled ? <Badge size="sm">Not found</Badge> : undefined}
              checked={draft.targets.includes(target)}
              onCheckedChange={(on) => toggle(target, on)}
              disabled={busy}
            />
          ))}
        </OptionCardGroup>
        {errors.targets ? (
          <p className="text-[12.5px] text-danger-text" role="alert">
            {errors.targets}
          </p>
        ) : (
          <p className="text-[12.5px] leading-5 text-fg-muted">
            Claude Desktop keeps using Claude — it only works with Claude models.
          </p>
        )}
      </div>

      <Field label="Name" hint="So you can find it again under your saved setups." error={errors.name} required>
        <Input value={draft.name} onValueChange={(name) => onChange({ name, nameTouched: true })} maxLength={80} disabled={busy} />
      </Field>

      {usesProxy(preset) ? (
        <Callout tone="accent" icon={Waypoints} title="Claude Setup will run a small translator for you">
          {preset.name} speaks a different language than Claude Code, so Claude Setup starts its local proxy. It must keep
          running while
          you use Claude Code — closing the window keeps Claude Setup in the tray.
        </Callout>
      ) : null}

      <AdvancedOnly>
        <Disclosure title="Show the profile as JSON" description="Saved by Claude Setup; the key stays in secure storage">
          <CodeBlock code={preview} maxHeight={260} />
        </Disclosure>
      </AdvancedOnly>

      {isThirdParty(preset) ? (
        <p className="flex items-start gap-2 text-xs leading-5 text-fg-subtle">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{CAVEAT} A backup of each settings file is made first.</span>
        </p>
      ) : (
        <p className="text-xs leading-5 text-fg-subtle">A backup of each settings file is made first.</p>
      )}
    </div>
  )
}
