import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, ArrowRight, RotateCcw } from 'lucide-react'
import type { ApplyModelResult, ModelPreset, ModelProfile, ModelProfileInput, ModelTarget, ProviderPreset } from '@shared/types'
import { Button, Dialog, Monogram, ProgressBar, Stepper, confirmAction, toast, toastError } from '@renderer/components/ui'
import { core, errorMessage } from '@renderer/lib/api'
import { useLatest } from '@renderer/lib/hooks'
import { maskSecret, pluralize } from '@renderer/lib/format'
import { EASE_OUT } from '@renderer/lib/motion'
import { useIsAdvanced } from '@renderer/lib/store'
import { ApplyResultView } from '../ApplyResultView'
import { findModel, isThirdParty, mergeModels, usesProxy } from '../logic'
import {
  STEP_ORDER,
  accountErrors,
  accountStepLabel,
  applyErrors,
  buildProfileInput,
  connectionInput,
  initialDraft,
  isValid,
  modelErrors,
  testSkipReason,
  withMainModel,
  type StepId,
  type WizardDraft
} from './draft'
import { StepAccount } from './StepAccount'
import { StepApply } from './StepApply'
import { StepModels } from './StepModels'
import { StepTest, type TestState } from './StepTest'

export interface ProviderWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  preset: ProviderPreset
  /** Edit this profile instead of creating a new one. */
  profile?: ModelProfile
  /** Names of the other saved setups (to suggest a unique name). */
  existingNames: string[]
  /** Pre-selected apps on the last step. */
  defaultTargets: ModelTarget[]
  vscodeInstalled: boolean
  /** The edited profile is the one Claude Code uses right now. */
  active?: boolean
  /** Called after a profile was saved (and possibly applied) so the page can refresh. */
  onSaved: () => void
}

/** The profile input with the key masked (never show a key in the UI). */
function profilePreview(input: ModelProfileInput): ModelProfileInput {
  return input.apiKey ? { ...input, apiKey: maskSecret(input.apiKey) } : input
}

interface Outcome {
  profile: ModelProfile
  result?: ApplyModelResult
  error?: string
}

/**
 * Provider setup wizard (Dialog + Stepper): 1) key / region / address, 2) models, 3) connection test, 4) where to use it,
 * then saves the profile and applies it to Claude Code and/or VS Code.
 */
export function ProviderWizard(props: ProviderWizardProps) {
  const { open, onOpenChange, preset, profile, existingNames, defaultTargets, vscodeInstalled, active, onSaved } = props
  const advanced = useIsAdvanced()
  const [step, setStep] = useState<StepId>('account')
  const [draft, setDraft] = useState<WizardDraft>(() => initialDraft(preset, { profile, existingNames, defaultTargets }))
  const [models, setModels] = useState<ModelPreset[]>(preset.models)
  const [loadingModels, setLoadingModels] = useState(false)
  const [test, setTest] = useState<TestState>({ status: 'idle' })
  const [attempted, setAttempted] = useState<Partial<Record<StepId, boolean>>>({})
  const [busy, setBusy] = useState<'save' | 'apply' | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  /** Id of the saved profile (editing, or after the first save) so later saves update it. */
  const [savedId, setSavedId] = useState<string | undefined>(profile?.id)
  const [savedHasKey, setSavedHasKey] = useState(!!profile?.hasKey && profile.providerId === preset.id)
  const bodyRef = useRef<HTMLDivElement>(null)
  const panelMounted = useRef(false)

  const stepIndex = STEP_ORDER.indexOf(step)
  const patch = (changes: Partial<WizardDraft>): void => setDraft((d) => ({ ...d, ...changes }))
  const accErrors = useMemo(() => accountErrors(preset, draft, savedHasKey), [preset, draft, savedHasKey])
  const modErrors = useMemo(() => modelErrors(draft), [draft])
  const appErrors = useMemo(() => applyErrors(draft, true), [draft])
  const skipReason = testSkipReason(preset, draft, savedHasKey)
  const testInput = connectionInput(preset, draft, savedId)
  const testKey = JSON.stringify(testInput)
  const hasKey = !!draft.apiKey.trim() || savedHasKey
  const dirty = !outcome && (draft.apiKey.trim() !== '' || stepIndex > 0)

  const runTest = async (): Promise<void> => {
    const input = connectionInput(preset, draft, savedId)
    const key = JSON.stringify(input)
    setTest({ status: 'running', key })
    try {
      const result = await core.models.testConnection(input)
      setTest((current) => (current.status === 'running' && current.key === key ? { status: 'done', key, result } : current))
    } catch (err) {
      const error = errorMessage(err)
      setTest((current) => (current.status === 'running' && current.key === key ? { status: 'failed', key, error } : current))
    }
  }
  const runTestRef = useLatest(runTest)

  // Entering the test step runs the test, unless the same inputs were already tested (or it's skipped by default).
  useEffect(() => {
    if (step !== 'test' || outcome) return
    if (test.status !== 'idle' && test.key === testKey) return
    if (test.status === 'idle' && skipReason) return
    void runTestRef.current()
    // Only react to step changes; the inputs are read fresh inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // Move focus into each new step once it mounts (after the previous one animated out), for keyboard and
  // screen-reader users. The first panel is left to the dialog's own initial focus.
  const focusPanel = useCallback((panel: HTMLDivElement | null) => {
    if (!panel) return
    if (!panelMounted.current) {
      panelMounted.current = true
      return
    }
    window.requestAnimationFrame(() => {
      const target = panel.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled])')
      ;(target ?? panel).focus({ preventScroll: true })
    })
  }, [])

  const focusFirstError = (): void => {
    window.requestAnimationFrame(() => bodyRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
  }

  const loadModels = async (): Promise<void> => {
    setLoadingModels(true)
    try {
      const list = await core.models.listModels(connectionInput(preset, draft, savedId))
      setModels((current) => mergeModels(current, list))
      if (list.length) toast.success(`Found ${pluralize(list.length, 'model')}`, { description: 'Pick one from the lists.' })
      else toast.info('No models found', { description: `${preset.name} didn’t list any models. You can still type a name.` })
    } catch (err) {
      toastError(err, 'Couldn’t load the models')
    } finally {
      setLoadingModels(false)
    }
  }

  const goNext = (): void => {
    if (step === 'account') {
      setAttempted((a) => ({ ...a, account: true }))
      if (!isValid(accErrors)) return focusFirstError()
      setStep('models')
    } else if (step === 'models') {
      setAttempted((a) => ({ ...a, models: true }))
      if (!isValid(modErrors)) return focusFirstError()
      setStep('test')
    } else if (step === 'test') {
      setStep('apply')
    }
  }

  const goBack = (): void => {
    if (stepIndex > 0) setStep(STEP_ORDER[stepIndex - 1] ?? 'account')
  }

  const requestClose = (): void => {
    if (busy) return
    if (!dirty) {
      onOpenChange(false)
      return
    }
    void confirmAction({
      title: 'Discard this setup?',
      description: 'Nothing has been saved yet.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      tone: 'danger'
    }).then((ok) => {
      if (ok) onOpenChange(false)
    })
  }

  const applySaved = async (saved: ModelProfile): Promise<void> => {
    setBusy('apply')
    try {
      const result = await core.models.apply({ profileId: saved.id, targets: draft.targets })
      setOutcome({ profile: saved, result })
    } catch (err) {
      setOutcome({ profile: saved, error: errorMessage(err) })
    } finally {
      setBusy(null)
      onSaved()
    }
  }

  const save = async (apply: boolean): Promise<void> => {
    setAttempted((a) => ({ ...a, apply: true }))
    if (!isValid(applyErrors(draft, apply))) return focusFirstError()
    setBusy(apply ? 'apply' : 'save')
    setSaveError(null)
    let saved: ModelProfile
    try {
      saved = await core.models.saveProfile(buildProfileInput(preset, draft, savedId))
    } catch (err) {
      setSaveError(errorMessage(err))
      setBusy(null)
      return
    }
    // The key now lives in the secret store only — drop it from memory.
    setDraft((d) => ({ ...d, apiKey: '' }))
    setSavedId(saved.id)
    setSavedHasKey(saved.hasKey)
    if (!apply) {
      setBusy(null)
      onSaved()
      toast.success(`Saved “${saved.name}”`, { description: 'Use it any time from your saved setups.' })
      onOpenChange(false)
      return
    }
    await applySaved(saved)
  }

  const steps = [
    { id: 'account', label: accountStepLabel(preset) },
    { id: 'models', label: 'Models' },
    { id: 'test', label: 'Test' },
    { id: 'apply', label: 'Use it' }
  ]

  const failedOutcome = !!outcome && (!!outcome.error || !outcome.result?.ok)

  let content: ReactNode
  if (outcome) {
    content = outcome.result ? (
      <ApplyResultView result={outcome.result} thirdParty={isThirdParty(preset)} proxy={usesProxy(preset)} />
    ) : (
      <ApplyResultView
        title="Saved, but not in use yet"
        result={{
          ok: false,
          results: [],
          warnings: [`“${outcome.profile.name}” was saved, but applying it failed: ${outcome.error ?? 'unknown error'}`]
        }}
      />
    )
  } else if (step === 'account') {
    content = (
      <StepAccount
        preset={preset}
        draft={draft}
        onChange={patch}
        errors={attempted.account ? accErrors : {}}
        hasStoredKey={savedHasKey}
        advanced={advanced}
      />
    )
  } else if (step === 'models') {
    content = (
      <StepModels
        preset={preset}
        draft={draft}
        onChange={patch}
        onMainChange={(main) => setDraft((d) => withMainModel(d, preset, main, existingNames))}
        models={models}
        loadingModels={loadingModels}
        onLoadModels={() => void loadModels()}
        errors={attempted.models ? modErrors : {}}
        hasKey={hasKey}
        advanced={advanced}
      />
    )
  } else if (step === 'test') {
    content = (
      <StepTest
        preset={preset}
        state={test.status !== 'idle' && test.key !== testKey ? { status: 'idle' } : test}
        skipReason={skipReason}
        onRun={() => void runTest()}
        onGoTo={(target) => setStep(target)}
        onLoadModels={() => {
          setStep('models')
          void loadModels()
        }}
      />
    )
  } else {
    content = (
      <StepApply
        preset={preset}
        draft={draft}
        onChange={patch}
        errors={attempted.apply ? appErrors : {}}
        vscodeInstalled={vscodeInstalled}
        saveError={saveError}
        busy={!!busy}
        active={!!active}
        preview={profilePreview(buildProfileInput(preset, draft, savedId))}
      />
    )
  }

  const testOk = test.status === 'done' && test.key === testKey && test.result.verdict === 'ok'
  const testRunning = test.status === 'running' && test.key === testKey

  const footer = outcome ? (
    <>
      {failedOutcome ? (
        <>
          <Button
            variant="ghost"
            leftIcon={ArrowLeft}
            onClick={() => {
              setOutcome(null)
              setStep('account')
            }}
            disabled={!!busy}
          >
            Change settings
          </Button>
          <div className="flex-1" />
          <Button leftIcon={RotateCcw} loading={busy === 'apply'} onClick={() => void applySaved(outcome.profile)}>
            Try again
          </Button>
        </>
      ) : null}
      <Button variant="primary" onClick={() => onOpenChange(false)} disabled={!!busy}>
        Done
      </Button>
    </>
  ) : (
    <>
      {stepIndex === 0 ? (
        <Button variant="ghost" onClick={requestClose} disabled={!!busy}>
          Cancel
        </Button>
      ) : (
        <Button variant="ghost" leftIcon={ArrowLeft} onClick={goBack} disabled={!!busy}>
          Back
        </Button>
      )}
      <div className="flex-1" />
      {step === 'apply' ? (
        <>
          <Button onClick={() => void save(false)} loading={busy === 'save'} disabled={!!busy}>
            Save only
          </Button>
          <Button variant="primary" onClick={() => void save(true)} loading={busy === 'apply'} disabled={!!busy}>
            {savedId ? 'Save and use' : `Use ${findModel(models, draft.main)?.label ?? 'it'}`}
          </Button>
        </>
      ) : step === 'test' ? (
        testOk || (test.status === 'idle' && skipReason) ? (
          <Button variant="primary" rightIcon={ArrowRight} onClick={goNext}>
            Continue
          </Button>
        ) : (
          <Button rightIcon={ArrowRight} onClick={goNext}>
            {testRunning ? 'Skip the test' : 'Continue anyway'}
          </Button>
        )
      ) : (
        <Button variant="primary" rightIcon={ArrowRight} onClick={goNext}>
          Continue
        </Button>
      )}
    </>
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose()
      }}
      size="lg"
      dismissible={!busy}
      title={
        <span className="flex items-center gap-3">
          <Monogram text={preset.name} letters={preset.monogram} color={preset.color} size="md" />
          <span className="min-w-0 truncate">{profile ? `Edit “${profile.name}”` : `Set up ${preset.name}`}</span>
        </span>
      }
      description={profile ? `${preset.name} · ${preset.vendor}` : preset.description}
      footer={footer}
    >
      <div ref={bodyRef} className="flex flex-col gap-6">
        <Stepper
          steps={steps}
          current={outcome ? STEP_ORDER.length : stepIndex}
          onStepClick={busy || outcome ? undefined : (index) => setStep(STEP_ORDER[index] ?? 'account')}
        />
        <p className="sr-only" aria-live="polite">
          {outcome ? 'Finished' : `Step ${stepIndex + 1} of ${STEP_ORDER.length}: ${steps[stepIndex]?.label ?? ''}`}
        </p>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={outcome ? 'outcome' : step}
            ref={focusPanel}
            data-step-panel
            tabIndex={-1}
            className="min-h-[18rem] outline-none"
            initial={{ opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -14 }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
          >
            {content}
          </motion.div>
        </AnimatePresence>
        {busy ? <ProgressBar size="sm" label={busy === 'save' ? 'Saving' : 'Saving and applying'} /> : null}
      </div>
    </Dialog>
  )
}
