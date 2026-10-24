/**
 * Home: a warm overview — greeting, the Claude apps on this computer (status, tools, restart), quick actions,
 * popular tools with one-click Add and the current AI model for Claude Code.
 */
import { useMemo } from 'react'
import { ArrowRight } from 'lucide-react'
import type { CatalogServer } from '@shared/types'
import { Button, ErrorState, FadeIn, Section, SkeletonCard } from '@renderer/components/ui'
import { core } from '@renderer/lib/api'
import { refreshTargets, useAsync, useTargets } from '@renderer/lib/hooks'
import { useIsAdvanced, useNavigate } from '@renderer/lib/store'
import { useRestartPending } from './discover/common/restart'
import { useCatalogServers, useInstalledServers } from './discover/common/servers'
import { InstallWizardHost } from './discover/install/InstallWizard'
import { AppCard } from './home/AppCard'
import { HeroCard } from './home/HeroCard'
import { ModelChip } from './home/ModelChip'
import { OtherApps } from './home/OtherApps'
import { PopularTools } from './home/PopularTools'
import { QuickActions } from './home/QuickActions'

export default function HomePage() {
  const advanced = useIsAdvanced()
  const navigate = useNavigate()
  const targets = useTargets()
  const installed = useInstalledServers()
  const featured = useAsync(() => core.catalog.featured(), [])
  const model = useAsync(() => core.models.status(), [])
  const stats = useAsync(() => core.catalog.stats(), [])
  const restartPending = useRestartPending()

  const servers = installed.data
  const catalogIds = useMemo(() => [...new Set((servers ?? []).map((s) => s.catalogId).filter((id): id is string => !!id))], [servers])
  const catalog = useCatalogServers(catalogIds)

  // Hero icons: the person's own tools, or popular picks when nothing is installed yet.
  const heroIcons = useMemo(() => {
    const own = catalogIds.map((id) => catalog.get(id)).filter((s): s is CatalogServer => !!s)
    if (own.length || (servers && servers.length)) return own
    return featured.data ?? []
  }, [catalogIds, catalog, servers, featured.data])

  const primary = targets.targets.filter((t) => t.primary)
  const others = targets.targets.filter((t) => !t.primary)
  const openServer = (server: CatalogServer): void => navigate('discover', { server: server.id })

  return (
    <>
      <div className="space-y-10">
        <FadeIn>
          <HeroCard
            installed={servers}
            icons={heroIcons}
            onDiscover={() => navigate('discover')}
            onCheck={() => navigate('doctor', { run: true })}
          />
        </FadeIn>

        <Section title="Your Claude apps" description="Where Claude can use your tools.">
          {!targets.ready && targets.error ? (
            <ErrorState framed size="sm" title="Couldn’t check your apps" error={targets.error} onRetry={() => void targets.reload()} />
          ) : !targets.ready ? (
            <div className="grid gap-4 md:grid-cols-2" aria-busy="true" aria-label="Looking for your apps">
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {primary.map((target) => (
                <AppCard
                  key={target.id}
                  target={target}
                  tools={servers?.filter((s) => s.target.target === target.id)}
                  advanced={advanced}
                  restartPending={restartPending}
                  onManage={() => navigate('installed')}
                  onAdd={() => navigate('discover')}
                  onCheck={() => navigate('doctor', { run: true })}
                  onRecheck={() => void refreshTargets()}
                >
                  {target.id === 'claude-code' && target.installed ? (
                    <ModelChip status={model.data} loading={model.loading} onClick={() => navigate('models')} />
                  ) : null}
                </AppCard>
              ))}
            </div>
          )}
          {advanced && targets.ready && others.length ? (
            <div className="space-y-2.5 pt-2">
              <h3 className="text-[13px] font-semibold text-fg-muted">Other apps</h3>
              <OtherApps targets={others} installed={servers} onManage={() => navigate('installed')} />
            </div>
          ) : null}
        </Section>

        <Section title="Quick actions">
          <QuickActions catalogTotal={stats.data?.total} onNavigate={navigate} />
        </Section>

        <Section
          title="Popular tools"
          description="Hand-picked favorites that work great with Claude."
          actions={
            <Button variant="ghost" size="sm" rightIcon={ArrowRight} onClick={() => navigate('discover')}>
              See all
            </Button>
          }
        >
          <PopularTools
            servers={servers !== undefined || installed.error ? featured.data : undefined}
            error={featured.error}
            onRetry={() => void featured.reload()}
            installedFor={installed.find}
            onOpen={openServer}
            advanced={advanced}
          />
        </Section>
      </div>
      <InstallWizardHost />
    </>
  )
}
