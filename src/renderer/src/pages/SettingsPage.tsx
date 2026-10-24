import { ArrowRight, Monitor, Moon, SlidersHorizontal, Smile, Sun } from 'lucide-react'
import type { TargetId } from '@shared/types'
import {
  AdvancedOnly,
  Badge,
  Button,
  Card,
  CardContent,
  Disclosure,
  ErrorState,
  Field,
  OptionCard,
  OptionCardGroup,
  PageHeader,
  Section,
  Segmented,
  Select,
  Separator,
  Skeleton,
  SkeletonCard,
  Switch
} from '@renderer/components/ui'
import { useSettings, useTargets } from '@renderer/lib/hooks'
import { getPage, type PageProps } from '@renderer/lib/nav'
import { useAppStore, useIsAdvanced, useNavigate } from '@renderer/lib/store'
import type { ThemePreference } from '@renderer/lib/theme'
import { AboutSection } from './settings/AboutSection'
import { KeysSection } from './settings/KeysSection'
import { SelfSection } from './settings/SelfSection'
import { SourcesSection } from './settings/SourcesSection'
import { APP_BLURBS, APP_ICONS, APP_ORDER } from './settings/apps'
import { KEEP_CHOICES, isDefaultTarget, toggleDefaultTarget, withCurrent } from './settings/meta'

const page = getPage('settings')

const THEMES: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon }
]

function SettingsSkeleton() {
  return (
    <div className="space-y-10" aria-busy="true" aria-label="Loading settings">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-4">
          <Skeleton className="h-5 w-40" />
          <div className="grid gap-3 md:grid-cols-2">
            <SkeletonCard />
            <SkeletonCard />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Settings: mode and theme, install defaults, catalog sources, optional keys, Claude managing itself, about. */
export default function SettingsPage(_props: PageProps) {
  const advanced = useIsAdvanced()
  const navigate = useNavigate()
  const mode = useAppStore((s) => s.mode)
  const theme = useAppStore((s) => s.theme)
  const setMode = useAppStore((s) => s.setMode)
  const setTheme = useAppStore((s) => s.setTheme)
  const { settings, loading, error, update, reload } = useSettings()
  const { targets, byId, ready } = useTargets()

  const header = (
    <PageHeader icon={page.icon} title={page.label} subtitle="Appearance, where tools go, catalog sources and Claude Setup itself." />
  )

  if (!settings) {
    return (
      <>
        {header}
        {error && !loading ? (
          <ErrorState framed title="Couldn’t load your settings" error={error} onRetry={() => void reload()} />
        ) : (
          <SettingsSkeleton />
        )}
      </>
    )
  }

  const toggleTarget = (id: TargetId, on: boolean): void => {
    const target = byId(id)
    if (!target) return
    void update({ defaultTargets: toggleDefaultTarget(settings.defaultTargets, target, on) })
  }

  const appList = APP_ORDER.map((id) => byId(id)).filter((t): t is NonNullable<typeof t> => !!t)

  return (
    <>
      {header}
      <div className="space-y-12">
        <Section title="Appearance" description="How Claude Setup looks and how much it shows.">
          <OptionCardGroup label="Interface mode" columns={2}>
            <OptionCard
              size="lg"
              icon={Smile}
              title="Simple"
              badge={<Badge size="sm" tone="accent">Recommended</Badge>}
              description="Big friendly choices and plain words. Claude Setup picks sensible defaults for you."
              checked={mode === 'simple'}
              onCheckedChange={() => setMode('simple')}
            />
            <OptionCard
              size="lg"
              icon={SlidersHorizontal}
              title="Advanced"
              description="Everything: raw settings, scopes, environment variables, the proxy, backups and logs."
              checked={mode === 'advanced'}
              onCheckedChange={() => setMode('advanced')}
            />
          </OptionCardGroup>
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-5">
              <div>
                <p className="text-sm font-medium text-fg">Theme</p>
                <p className="text-[13px] text-fg-muted">“System” follows your computer’s light or dark setting.</p>
              </div>
              <Segmented
                aria-label="Theme"
                value={theme}
                onValueChange={setTheme}
                options={THEMES.map((t) => ({ value: t.value, label: t.label, icon: t.icon }))}
              />
            </CardContent>
          </Card>
        </Section>

        <Section title="Adding tools" description="Where new tools go unless you choose otherwise in the install wizard.">
          {!ready ? (
            <div className="grid gap-3 md:grid-cols-2">
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ) : (
            <OptionCardGroup label="Default apps for new tools" type="checkbox" columns={2}>
              {appList.map((target) => (
                <OptionCard
                  key={target.id}
                  type="checkbox"
                  icon={APP_ICONS[target.id]}
                  title={target.label}
                  description={APP_BLURBS[target.id]}
                  badge={!target.installed ? <Badge size="sm">Not installed</Badge> : undefined}
                  disabled={!target.installed && !isDefaultTarget(settings, target.id)}
                  checked={isDefaultTarget(settings, target.id)}
                  onCheckedChange={(on) => toggleTarget(target.id, on)}
                />
              ))}
            </OptionCardGroup>
          )}
          <Card>
            <CardContent className="space-y-4 pt-5">
              <Switch
                checked={settings.autoRestartDesktop}
                onCheckedChange={(autoRestartDesktop) => void update({ autoRestartDesktop })}
                label="Restart Claude Desktop automatically"
                description={
                  'Claude Desktop only loads new tools when it starts. Turn this on and Claude Setup restarts it for you after ' +
                  'changes — otherwise it asks first.'
                }
              />
              <Separator />
              <Switch
                checked={settings.startAtLogin ?? false}
                onCheckedChange={(startAtLogin) => void update({ startAtLogin })}
                label="Start Claude Setup when you log in"
                description="It opens quietly in the tray, so models that go through Claude Setup’s proxy keep working after a restart."
              />
            </CardContent>
          </Card>
          {targets.length > 0 && !targets.some((t) => t.installed) ? (
            <p className="text-[13px] text-fg-muted">No Claude apps were found on this computer yet. Install one, then come back.</p>
          ) : null}
        </Section>

        <Section
          title="Tool catalog"
          description={
            advanced
              ? 'Registries Discover searches, with tool counts. Changes apply on the next refresh.'
              : 'Where Discover finds tools. The defaults work well for most people.'
          }
        >
          {advanced ? (
            <SourcesSection settings={settings} update={update} advanced />
          ) : (
            <Disclosure variant="card" title="Where tools come from" description="Turn sources on or off">
              <SourcesSection settings={settings} update={update} advanced={false} />
            </Disclosure>
          )}
        </Section>

        <Section
          title="Optional keys"
          description="Unlock more sources and higher limits. Keys are kept in your system’s secure storage, never in plain files."
        >
          {advanced ? (
            <KeysSection settings={settings} update={update} />
          ) : (
            <Disclosure variant="card" title="Add optional keys" description="For GitHub, Smithery, Glama and PulseMCP">
              <KeysSection settings={settings} update={update} />
            </Disclosure>
          )}
        </Section>

        <Section title="Backups" description="Claude Setup saves a copy of every settings file before it changes it.">
          <Card>
            <CardContent className="flex flex-wrap items-end gap-4 pt-5">
              <Field label="Keep the newest" className="w-72" hint="Older backups are deleted automatically.">
                <Select
                  value={String(settings.keepBackups)}
                  options={withCurrent(KEEP_CHOICES, settings.keepBackups).map((n) => ({ value: String(n), label: `${n} backups` }))}
                  onValueChange={(v) => void update({ keepBackups: Number(v) })}
                />
              </Field>
              <AdvancedOnly>
                <Button variant="ghost" rightIcon={ArrowRight} onClick={() => navigate('backups')} className="mb-6">
                  View backups
                </Button>
              </AdvancedOnly>
            </CardContent>
          </Card>
        </Section>

        <Section
          title="Claude Setup in your Claude apps"
          description="Optional extras that make Claude Setup available outside this window."
        >
          <SelfSection />
        </Section>

        <Section title="About">
          <AboutSection update={update} />
        </Section>
      </div>
    </>
  )
}
