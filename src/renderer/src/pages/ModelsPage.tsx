import { useMemo, useState } from 'react'
import { Layers, Monitor, Plus, RefreshCw, RotateCcw } from 'lucide-react'
import type { ApplyModelResult, ModelProfile, ModelTarget, ProviderPreset } from '@shared/types'
import {
  Button,
  Callout,
  Dialog,
  EmptyState,
  ErrorState,
  ExternalLink,
  PageHeader,
  Section,
  Tooltip,
  confirmAction,
  toast,
  toastError,
  toastResult
} from '@renderer/components/ui'
import { core, errorMessage, useCoreEvent } from '@renderer/lib/api'
import { useAsync, useTargets } from '@renderer/lib/hooks'
import { getPage, type PageProps } from '@renderer/lib/nav'
import { useIsAdvanced } from '@renderer/lib/store'
import { ApplyResultView } from './models/ApplyResultView'
import { ModelStatusCard } from './models/ModelStatusCard'
import { ProfileList } from './models/ProfileList'
import { ProviderGallery } from './models/ProviderGallery'
import { CAVEAT, classifyWarnings, isThirdParty, isUserDefined, usesProxy, verdictInfo } from './models/logic'
import { ProviderWizard } from './models/wizard/ProviderWizard'

const page = getPage('models')

interface WizardState {
  key: number
  open: boolean
  preset: ProviderPreset
  profile?: ModelProfile
}

interface ResultDialogState {
  open: boolean
  title: string
  result: ApplyModelResult
  thirdParty: boolean
  proxy: boolean
}

/** Models: what Claude Code uses now, saved setups, and a provider gallery with a guided setup wizard. */
export default function ModelsPage(_props: PageProps) {
  const advanced = useIsAdvanced()
  const providers = useAsync(() => core.models.providers(), [])
  const profiles = useAsync(() => core.models.profiles(), [])
  const status = useAsync(() => core.models.status(), [])
  const { byId } = useTargets()
  const [wizard, setWizard] = useState<WizardState | null>(null)
  const [resultDialog, setResultDialog] = useState<ResultDialogState | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  useCoreEvent('state', (event) => {
    if (event.key === 'models') void status.reload()
    if (event.key === 'profiles') void profiles.reload()
  })

  const vscodeInstalled = byId('vscode')?.installed ?? false
  const activeProfileId = status.data?.profileId
  const customPreset = useMemo(() => providers.data?.find((p) => p.kind === 'custom' && isUserDefined(p)), [providers.data])
  const presetFor = (profile: ModelProfile): ProviderPreset | undefined => providers.data?.find((p) => p.id === profile.providerId)

  const refreshAll = (): void => {
    void status.reload()
    void profiles.reload()
  }

  const defaultTargets = (): ModelTarget[] =>
    vscodeInstalled || status.data?.vscodeConfigured ? ['claude-code', 'vscode'] : ['claude-code']

  const openWizard = (preset: ProviderPreset, profile?: ModelProfile): void => {
    setWizard({ key: Date.now(), open: true, preset, profile })
  }

  const editProfile = (profile: ModelProfile): void => {
    const preset = presetFor(profile)
    if (!preset) {
      toast.error('This setup can’t be edited', { description: 'Its provider isn’t known to this version of Claude Setup.' })
      return
    }
    openWizard(preset, profile)
  }

  const switchTo = async (profile: ModelProfile, targets: ModelTarget[] = defaultTargets()): Promise<void> => {
    setBusyId(profile.id)
    try {
      const result = await core.models.apply({ profileId: profile.id, targets })
      const preset = presetFor(profile)
      setResultDialog({
        open: true,
        title: result.ok ? `Now using “${profile.name}”` : `Couldn’t switch to “${profile.name}”`,
        result,
        thirdParty: preset ? isThirdParty(preset) : true,
        proxy: preset ? usesProxy(preset) : false
      })
    } catch (err) {
      toastError(err, `Couldn’t use “${profile.name}”`)
    } finally {
      setBusyId(null)
      refreshAll()
    }
  }

  const syncVsCode = async (): Promise<void> => {
    if (!activeProfileId) return
    setSyncing(true)
    try {
      const result = await core.models.apply({ profileId: activeProfileId, targets: ['vscode'] })
      const vscode = result.results.find((r) => r.target === 'vscode')
      const { steps } = classifyWarnings(result.warnings)
      if (vscode?.ok) toast.success('VS Code uses the same model now', { description: steps[0] ?? vscode.message })
      else toast.error('Couldn’t update VS Code', { description: vscode?.message ?? result.warnings[0], duration: 8000 })
    } catch (err) {
      toastError(err, 'Couldn’t update VS Code')
    } finally {
      setSyncing(false)
      refreshAll()
    }
  }

  const resetToClaude = (): void => {
    // Include VS Code whenever it might hold settings from us; resetting it is harmless when there's nothing to remove.
    const targets: ModelTarget[] = vscodeInstalled || status.data?.vscodeConfigured ? ['claude-code', 'vscode'] : ['claude-code']
    let result: ApplyModelResult | undefined
    void confirmAction({
      title: 'Switch back to Claude?',
      description:
        'Claude Code goes back to your Claude account. Your saved setups stay here, so you can switch again any time. ' +
        'A backup is made first.',
      confirmLabel: 'Switch back',
      icon: RotateCcw,
      onConfirm: async () => {
        result = await core.models.reset(targets)
      }
    }).then((ok) => {
      if (!ok || !result) return
      const { steps } = classifyWarnings(result.warnings)
      if (result.ok) toast.success('Claude Code uses Claude again', { description: steps[0] ?? 'Your saved setups are still here.' })
      else setResultDialog({ open: true, title: 'Couldn’t switch back to Claude', result, thirdParty: false, proxy: false })
      refreshAll()
    })
  }

  const testProfile = async (profile: ModelProfile): Promise<void> => {
    const id = toast.loading(`Testing “${profile.name}”…`)
    try {
      const result = await core.models.testConnection({ profileId: profile.id })
      const preset = presetFor(profile)
      if (result.ok) {
        toast.success(`“${profile.name}” works`, { id, description: result.message })
      } else {
        const title = preset ? verdictInfo(result, preset).title : 'The test failed'
        toast.error(title, {
          id,
          description: result.message,
          duration: 9000,
          action: { label: 'Edit', onClick: () => editProfile(profile) }
        })
      }
    } catch (err) {
      toast.error('The test couldn’t run', { id, description: errorMessage(err) })
    }
  }

  const deleteProfile = (profile: ModelProfile): void => {
    const active = profile.id === activeProfileId
    void confirmAction({
      title: `Delete “${profile.name}”?`,
      description: active
        ? 'Claude Code is using this setup right now. It keeps its current settings until you switch, ' +
          'but the saved key is removed from this computer.'
        : 'Its saved key is removed from this computer. This can’t be undone.',
      tone: 'danger',
      confirmLabel: 'Delete'
    }).then(async (ok) => {
      if (!ok) return
      const before = profiles.data
      profiles.setData((list) => list?.filter((p) => p.id !== profile.id))
      try {
        const result = await core.models.deleteProfile(profile.id)
        toastResult(result)
        if (!result.ok && before) profiles.setData(before)
      } catch (err) {
        if (before) profiles.setData(before)
        toastError(err, 'Couldn’t delete the setup')
      } finally {
        void profiles.reload()
      }
    })
  }

  const profileCount = profiles.data?.length ?? 0
  const showProfiles = profileCount > 0 || (profiles.loading && !profiles.data) || (advanced && !!profiles.data) || !!profiles.error

  return (
    <>
      <PageHeader
        icon={page.icon}
        title={page.label}
        subtitle="Use other AI models like Kimi, DeepSeek or GLM in Claude Code."
        actions={
          advanced ? (
            <>
              <Tooltip content="Refresh">
                <Button size="icon" variant="ghost" aria-label="Refresh" onClick={refreshAll}>
                  <RefreshCw />
                </Button>
              </Tooltip>
              {customPreset ? (
                <Button leftIcon={Plus} onClick={() => openWizard(customPreset)}>
                  Custom endpoint
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />

      <div className="space-y-10">
        <div className="space-y-4">
          <ModelStatusCard
            status={status.data}
            loading={status.loading}
            error={status.error}
            onRetry={() => void status.reload()}
            providers={providers.data}
            profiles={profiles.data}
            onReset={resetToClaude}
            onSyncVsCode={() => void syncVsCode()}
            syncing={syncing}
          />
          <Callout tone="neutral" icon={Monitor} title="Works in Claude Code — in the terminal and in VS Code">
            Claude Desktop only works with Claude models, so it keeps using Claude whatever you choose here. {CAVEAT}
            {advanced ? (
              <>
                {' '}
                Desktop’s own third-party mode (gateway, Bedrock, Vertex, Foundry) accepts Claude models only.{' '}
                <ExternalLink href="https://claude.com/docs/third-party/claude-desktop/gateway">Learn more</ExternalLink>
              </>
            ) : null}
          </Callout>
        </div>

        {showProfiles ? (
          <Section
            title={advanced ? 'Profiles' : 'Your saved setups'}
            description={
              advanced
                ? 'Saved provider + model combinations. Keys stay in your system’s secure storage.'
                : 'Switch between them with one click.'
            }
          >
            {profiles.error && !profiles.data ? (
              <ErrorState size="sm" framed error={profiles.error} onRetry={() => void profiles.reload()} />
            ) : profileCount === 0 && profiles.data ? (
              <EmptyState
                framed
                size="sm"
                icon={Layers}
                title="No profiles yet"
                description="Pick a provider below — your setup is saved here."
              />
            ) : (
              <ProfileList
                profiles={profiles.data}
                providers={providers.data}
                loading={profiles.loading}
                activeProfileId={activeProfileId}
                busyId={busyId}
                advanced={advanced}
                onUse={(profile, targets) => void switchTo(profile, targets)}
                onEdit={editProfile}
                onTest={(profile) => void testProfile(profile)}
                onDelete={deleteProfile}
              />
            )}
          </Section>
        ) : null}

        <Section
          title={profileCount > 0 ? 'Add another provider' : 'Pick a provider'}
          description={
            advanced
              ? 'Every provider Claude Setup knows, with verified addresses and model lists.'
              : 'Choose who runs the model. Most need an account and an API key — we’ll walk you through it.'
          }
        >
          {providers.error && !providers.data ? (
            <ErrorState framed error={providers.error} onRetry={() => void providers.reload()} />
          ) : (
            <ProviderGallery
              providers={providers.data}
              loading={providers.loading}
              onSelect={(preset) => openWizard(preset)}
              activeProviderId={status.data?.mode === 'anthropic' ? undefined : status.data?.providerId}
              advanced={advanced}
            />
          )}
        </Section>
      </div>

      {wizard ? (
        <ProviderWizard
          key={wizard.key}
          open={wizard.open}
          onOpenChange={(open) => setWizard((w) => (w ? { ...w, open } : w))}
          preset={wizard.preset}
          profile={wizard.profile}
          existingNames={(profiles.data ?? []).filter((p) => p.id !== wizard.profile?.id).map((p) => p.name)}
          defaultTargets={defaultTargets()}
          vscodeInstalled={vscodeInstalled}
          active={!!wizard.profile && wizard.profile.id === activeProfileId}
          onSaved={refreshAll}
        />
      ) : null}

      {resultDialog ? (
        <Dialog
          open={resultDialog.open}
          onOpenChange={(open) => setResultDialog((d) => (d ? { ...d, open } : d))}
          title={resultDialog.title}
          size="md"
          footer={
            <Button variant="primary" onClick={() => setResultDialog((d) => (d ? { ...d, open: false } : d))}>
              Done
            </Button>
          }
        >
          <ApplyResultView
            result={resultDialog.result}
            thirdParty={resultDialog.thirdParty}
            proxy={resultDialog.proxy}
            headline={false}
          />
        </Dialog>
      ) : null}
    </>
  )
}
