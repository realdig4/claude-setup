/**
 * The install wizard (Dialog + Stepper): choose apps → settings → review → add. Works for catalog tools and,
 * in Advanced mode, custom tools (command or URL). Mount <InstallWizardHost/> once per page; open it with
 * openInstallWizard() / openCustomWizard() from ./store.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Blocks, Plus, Wrench } from 'lucide-react'
import type { CatalogServer, InstallRequest, InstallResult, TargetRef, TestResult } from '@shared/types'
import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  ExternalLink,
  IconTile,
  ServerIcon,
  Skeleton,
  Stepper,
  type StepItem
} from '@renderer/components/ui'
import { core, errorMessage } from '@renderer/lib/api'
import { useAsync, useProgress, useSettings, useTargets } from '@renderer/lib/hooks'
import { useIsAdvanced, useNavigate } from '@renderer/lib/store'
import { noteRestart } from '../common/restart'
import { bumpServers, useInstalledServers } from '../common/servers'
import { defaultOption, isInstallable, optionHasInputs, requiredInputCount } from '../lib/catalog'
import { draftErrors, draftToConfig, emptyDraft, nameProblem, recordFrom, suggestName, type CustomDraft } from '../lib/customServer'
import { formFields, initialValues, secretValues, toInstallValues, validateValues, type FormValues } from '../lib/installForm'
import { TARGET_NAMES, initialTargets, sameRef, sameRefSet, selectionProblem, userRef } from '../lib/targets'
import { StepApps } from './StepApps'
import { StepCustom } from './StepCustom'
import { StepResult } from './StepResult'
import { StepReview } from './StepReview'
import { StepSettings } from './StepSettings'
import { useInstallWizard, type WizardRequest } from './store'

type StepId = 'apps' | 'settings' | 'details' | 'review' | 'done'

const STEP_LABELS: Record<StepId, string> = {
  apps: 'Apps',
  settings: 'Settings',
  details: 'Details',
  review: 'Review',
  done: 'Add'
}

/** Renders the wizard for the current request (keeps the last one mounted while the dialog animates out). */
export function InstallWizardHost() {
  const request = useInstallWizard((s) => s.request)
  const close = useInstallWizard((s) => s.close)
  const [current, setCurrent] = useState<WizardRequest | null>(request)
  useEffect(() => {
    if (request) setCurrent(request)
  }, [request])
  if (!current) return null
  return <InstallWizard key={current.id} request={current} open={request?.id === current.id} onClose={close} />
}

interface InstallWizardProps {
  request: WizardRequest
  open: boolean
  onClose: () => void
}

function InstallWizard({ request, open, onClose }: InstallWizardProps) {
  const custom = !!request.custom
  const advanced = useIsAdvanced()
  const navigate = useNavigate()
  const { settings, update: updateSettings } = useSettings()
  const targetsState = useTargets()
  const installed = useInstalledServers()

  // ── The tool ────────────────────────────────────────────────────────────────
  const serverState = useAsync<CatalogServer | null>(
    async () => (request.catalogId ? ((await core.catalog.get(request.catalogId)) ?? request.server ?? null) : (request.server ?? null)),
    [request.id],
    { enabled: open && !custom, initialData: request.server }
  )
  const server = serverState.data ?? null

  // ── Step 1: apps ────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<TargetRef[]>([])
  const initialized = useRef(false)
  useEffect(() => {
    if (initialized.current || !targetsState.ready || !settings) return
    initialized.current = true
    const picked = initialTargets(settings.defaultTargets, targetsState.targets)
    // Simple mode always adds tools "everywhere" — never silently into a project saved as a default in Advanced mode.
    setSelected(advanced ? picked : picked.map((ref) => userRef(ref.target)))
  }, [targetsState.ready, targetsState.targets, settings, advanced])
  const [remember, setRemember] = useState(false)
  const canRemember = !!settings && selected.length > 0 && !sameRefSet(selected, settings.defaultTargets)

  // ── Step 2: settings / details ──────────────────────────────────────────────
  const [optionId, setOptionId] = useState<string | undefined>(undefined)
  const option = server ? (server.install.find((o) => o.id === optionId) ?? defaultOption(server)) : undefined
  const fields = useMemo(() => (option ? formFields(option) : []), [option])
  const [valuesByOption, setValuesByOption] = useState<Record<string, FormValues>>({})
  const values = option ? (valuesByOption[option.id] ?? initialValues(fields)) : {}
  const setValues = (next: FormValues): void => {
    if (option) setValuesByOption((prev) => ({ ...prev, [option.id]: next }))
  }
  const [customName, setCustomName] = useState<string | null>(null)
  const [extraArgs, setExtraArgs] = useState<string[]>([])
  const [draft, setDraft] = useState<CustomDraft>(emptyDraft)
  const [showMore, setShowMore] = useState(false)

  const defaultName = server ? suggestName(server.slug || server.name) : ''
  const name = custom ? draft.name.trim() : advanced && customName !== null ? customName.trim() : defaultName
  const displayName = custom ? draft.name.trim() || 'your tool' : (server?.name ?? 'this tool')

  // ── Steps ───────────────────────────────────────────────────────────────────
  const [stepId, setStepId] = useState<StepId>('apps')
  const [attempted, setAttempted] = useState<Partial<Record<StepId, boolean>>>({})
  const includeSettings =
    !custom && (advanced || showMore || stepId === 'settings' || (option ? requiredInputCount(option) > 0 : false))
  const steps: StepId[] = custom
    ? ['apps', 'details', 'review', 'done']
    : includeSettings
      ? ['apps', 'settings', 'review', 'done']
      : ['apps', 'review', 'done']
  const index = Math.max(0, steps.indexOf(stepId))
  const [finished, setFinished] = useState(false)
  const stepItems: StepItem[] = steps.map((id) => ({ id, label: id === 'done' && finished ? 'Done' : STEP_LABELS[id] }))
  const bodyRef = useRef<HTMLDivElement>(null)

  const go = (next: StepId): void => {
    setStepId(next)
    bodyRef.current?.closest('.overflow-y-auto')?.scrollTo({ top: 0 })
  }

  // ── Validation ──────────────────────────────────────────────────────────────
  const appsProblem = selectionProblem(selected)
  const fieldErrors = useMemo(() => validateValues(fields, values), [fields, values])
  const nameError = !custom && advanced && customName !== null ? (nameProblem(customName) ?? undefined) : undefined
  const customErrors = useMemo(() => draftErrors(draft), [draft])

  // ── The request ─────────────────────────────────────────────────────────────
  const [overwrite, setOverwrite] = useState(false)
  const installRequest: InstallRequest | null = useMemo(() => {
    if (custom) {
      if (Object.keys(customErrors).length) return null
      return { config: draftToConfig(draft), name, targets: selected, overwrite }
    }
    if (!server || !option) return null
    return {
      catalogId: server.id,
      optionId: option.id,
      values: toInstallValues(fields, values, advanced ? extraArgs : []),
      name: name || undefined,
      targets: selected,
      overwrite
    }
  }, [custom, customErrors, draft, name, selected, overwrite, server, option, fields, values, advanced, extraArgs])

  const requestKey = JSON.stringify(installRequest)
  const preview = useAsync(() => core.servers.preview(installRequest as InstallRequest), [requestKey], {
    enabled: open && stepId === 'review' && installRequest !== null,
    keepPreviousData: false
  })

  const secrets = useMemo(() => {
    if (custom) return [...Object.values(recordFrom(draft.env)), ...Object.values(recordFrom(draft.headers))].filter((v) => v.length >= 6)
    return secretValues(fields, values)
  }, [custom, draft, fields, values])

  const conflicts = useMemo(
    () => (name ? selected.filter((ref) => (installed.data ?? []).some((s) => s.name === name && sameRef(s.target, ref))) : []),
    [installed.data, name, selected]
  )

  // ── Install ─────────────────────────────────────────────────────────────────
  const { progress, reset: resetProgress } = useProgress('install')
  const [installing, setInstalling] = useState(false)
  const [result, setResult] = useState<InstallResult | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  const install = async (req: InstallRequest, mergeWith?: InstallResult): Promise<void> => {
    go('done')
    setFinished(false)
    resetProgress()
    setInstalling(true)
    setInstallError(null)
    setTestResult(null)
    if (remember && settings && !sameRefSet(selected, settings.defaultTargets)) void updateSettings({ defaultTargets: selected })
    try {
      const res = await core.servers.install(req)
      const merged: InstallResult = mergeWith
        ? {
            ...res,
            results: [...mergeWith.results.filter((r) => r.ok && !res.results.some((n) => sameRef(n.target, r.target))), ...res.results],
            warnings: [...new Set([...mergeWith.warnings, ...res.warnings])]
          }
        : res
      merged.ok = merged.results.length > 0 && merged.results.every((r) => r.ok)
      setResult(merged)
      setFinished(merged.ok)
      noteRestart(res.results)
      if (res.results.some((r) => r.ok)) bumpServers()
    } catch (err) {
      setInstallError(errorMessage(err))
    } finally {
      setInstalling(false)
    }
  }

  const failedConflicts = result
    ? result.results.filter((r) => !r.ok && (installed.data ?? []).some((s) => s.name === result.name && sameRef(s.target, r.target)))
    : []
  /** Install again, replacing the existing tool where adding failed because the name was taken. */
  const replaceConflicts = (): void => {
    if (!installRequest) return
    void install({ ...installRequest, overwrite: true, targets: failedConflicts.map((r) => r.target) }, result ?? undefined)
  }

  const runTest = async (): Promise<void> => {
    const target = result?.results.find((r) => r.ok)?.target
    if (!result || !target) return
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await core.servers.testInstalled(result.name, target))
    } catch (err) {
      setTestResult({ ok: false, kind: 'error', ms: 0, tools: [], error: errorMessage(err), hint: 'The test couldn’t run. Try again in a moment.' })
    } finally {
      setTesting(false)
    }
  }

  // ── Navigation ──────────────────────────────────────────────────────────────
  const next = (): void => {
    if (stepId === 'apps') {
      if (appsProblem) return setAttempted((a) => ({ ...a, apps: true }))
      return go(steps[index + 1] ?? 'review')
    }
    if (stepId === 'settings') {
      if (Object.keys(fieldErrors).length || nameError) return setAttempted((a) => ({ ...a, settings: true }))
      return go('review')
    }
    if (stepId === 'details') {
      if (Object.keys(customErrors).length) return setAttempted((a) => ({ ...a, details: true }))
      return go('review')
    }
    if (stepId === 'review' && installRequest) void install(installRequest)
  }
  const back = (): void => {
    if (index > 0) go(steps[index - 1] ?? 'apps')
  }

  // ── Rendering ───────────────────────────────────────────────────────────────
  const loadingServer = !custom && !server && serverState.loading
  const missingServer = !custom && !server && !serverState.loading
  const notInstallable = !custom && !!server && !isInstallable(server)
  const reviewBlocked =
    !preview.data ||
    preview.loading ||
    preview.data.targets.length === 0 ||
    preview.data.missingValues.length > 0 ||
    preview.data.targets.every((t) => !t.supported) ||
    (conflicts.length > 0 && !overwrite)

  const icon = custom ? (
    <IconTile icon={Wrench} tone="accent" size="md" />
  ) : server ? (
    <ServerIcon src={server.iconUrl} name={server.name} seed={server.id} size="md" />
  ) : (
    <IconTile icon={Blocks} tone="accent" size="md" />
  )
  const title = custom ? 'Add a custom tool' : `Add ${server?.name ?? 'a tool'}`
  const description =
    stepId === 'apps'
      ? 'Choose where Claude can use it.'
      : stepId === 'settings'
        ? fields.length
          ? 'A few details so it can connect.'
          : 'Fine-tune how it runs.'
        : stepId === 'details'
          ? 'Tell Claude Setup how to start it.'
          : stepId === 'review'
            ? 'Here’s what will happen. A backup is made before anything changes.'
            : undefined

  const footer = (() => {
    if (loadingServer || missingServer || notInstallable) {
      return (
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      )
    }
    if (stepId === 'done') {
      if (installing) {
        return (
          <Button variant="primary" loading disabled>
            Adding…
          </Button>
        )
      }
      const anyOk = !!result?.results.some((r) => r.ok)
      if (installError || (result && !anyOk)) {
        return (
          <>
            <Button variant="ghost" leftIcon={ArrowLeft} onClick={() => go('review')}>
              Back
            </Button>
            {failedConflicts.length && installRequest ? (
              <Button variant="primary" onClick={replaceConflicts}>
                Replace the existing one
              </Button>
            ) : installRequest ? (
              <Button variant="primary" onClick={() => void install(installRequest)}>
                Try again
              </Button>
            ) : null}
          </>
        )
      }
      return (
        <>
          <Button
            variant="ghost"
            onClick={() => {
              onClose()
              navigate('installed')
            }}
          >
            See my tools
          </Button>
          {failedConflicts.length && installRequest && result ? (
            <Button onClick={replaceConflicts}>Replace the existing one</Button>
          ) : null}
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      )
    }
    return (
      <>
        {index === 0 ? (
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        ) : (
          <Button variant="ghost" leftIcon={ArrowLeft} onClick={back}>
            Back
          </Button>
        )}
        {stepId === 'review' ? (
          <Button variant="primary" leftIcon={Plus} disabled={reviewBlocked} onClick={next}>
            {selected.length > 1 ? `Add to ${selected.length} apps` : selected[0] ? `Add to ${TARGET_NAMES[selected[0].target]}` : 'Add'}
          </Button>
        ) : (
          <Button variant="primary" rightIcon={ArrowRight} onClick={next} disabled={!targetsState.ready && stepId === 'apps'}>
            {steps[index + 1] === 'review' ? 'Review' : 'Next'}
          </Button>
        )}
      </>
    )
  })()

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
      size="lg"
      dismissible={!installing}
      title={
        <span className="flex items-center gap-3">
          {icon}
          <span className="min-w-0 truncate">{title}</span>
        </span>
      }
      description={description}
      footer={footer}
    >
      <div ref={bodyRef} className="@container">
        {loadingServer ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading the tool">
            <Skeleton className="h-8 w-full rounded-lg" />
            <Skeleton className="h-[84px] w-full rounded-xl" />
            <Skeleton className="h-[84px] w-full rounded-xl" />
          </div>
        ) : missingServer ? (
          serverState.error ? (
            <ErrorState size="sm" title="Couldn’t load this tool" error={serverState.error} onRetry={() => void serverState.reload()} />
          ) : (
            <EmptyState
              size="sm"
              icon={Blocks}
              title="This tool isn’t in the catalog anymore"
              description="Refresh the catalog on the Discover page and try again."
            />
          )
        ) : notInstallable && server ? (
          <EmptyState
            size="sm"
            icon={Wrench}
            title="This one needs a manual setup"
            description="Claude Setup can’t add it automatically. Its website explains how to set it up."
            actions={
              server.homepage || server.repository ? (
                <ExternalLink href={(server.homepage ?? server.repository) as string}>Open its website</ExternalLink>
              ) : undefined
            }
          />
        ) : (
          <>
            <Stepper
              steps={stepItems}
              current={finished ? steps.length : index}
              onStepClick={stepId === 'done' ? undefined : (i) => go(steps[i] ?? 'apps')}
              className="mb-6 px-1 pt-1"
            />
            <p className="sr-only" aria-live="polite">
              Step {index + 1} of {steps.length}: {STEP_LABELS[stepId]}
            </p>
            {stepId === 'apps' ? (
              <StepApps
                targets={targetsState.targets}
                ready={targetsState.ready}
                error={targetsState.error}
                onRetry={() => void targetsState.reload()}
                selected={selected}
                onChange={setSelected}
                advanced={advanced}
                recentProjects={settings?.recentProjects ?? []}
                problem={appsProblem}
                showErrors={!!attempted.apps}
                canRemember={canRemember}
                remember={remember}
                onRememberChange={setRemember}
                remote={option?.kind === 'remote'}
              />
            ) : null}
            {stepId === 'settings' && server && option ? (
              <StepSettings
                server={server}
                option={option}
                onOptionChange={setOptionId}
                fields={fields}
                values={values}
                onValuesChange={setValues}
                errors={attempted.settings ? fieldErrors : {}}
                advanced={advanced}
                name={customName ?? defaultName}
                onNameChange={setCustomName}
                nameError={attempted.settings ? nameError : undefined}
                extraArgs={extraArgs}
                onExtraArgsChange={setExtraArgs}
              />
            ) : null}
            {stepId === 'details' ? <StepCustom draft={draft} onChange={setDraft} errors={attempted.details ? customErrors : {}} /> : null}
            {stepId === 'review' ? (
              <StepReview
                preview={preview}
                displayName={displayName}
                name={name}
                advanced={advanced}
                secrets={secrets}
                conflicts={conflicts}
                overwrite={overwrite}
                onOverwriteChange={setOverwrite}
                onEditSettings={custom ? () => go('details') : includeSettings ? () => go('settings') : undefined}
                onSkipConflicts={
                  conflicts.length && conflicts.length < selected.length
                    ? () => setSelected((prev) => prev.filter((ref) => !conflicts.some((c) => sameRef(c, ref))))
                    : undefined
                }
                onMoreOptions={
                  !custom && !includeSettings && option && (optionHasInputs(option) || (server?.install.length ?? 0) > 1)
                    ? () => {
                        setShowMore(true)
                        go('settings')
                      }
                    : undefined
                }
              />
            ) : null}
            {stepId === 'done' ? (
              <StepResult
                displayName={displayName}
                installing={installing}
                progress={progress}
                result={result}
                error={installError}
                advanced={advanced}
                testing={testing}
                testResult={testResult}
                onTest={() => void runTest()}
              />
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  )
}
