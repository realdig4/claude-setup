import { useState } from 'react'
import { Bot, FileText, Info, Package, Palette, RefreshCw, Sparkles, SquareSlash, Webhook, type LucideIcon } from 'lucide-react'
import type { ExtensionKind } from '@shared/types'
import { Button, Callout, PageHeader, SimpleOnly, TabPanel, Tabs, Tooltip, toastError, toastResult } from '@renderer/components/ui'
import { core } from '@renderer/lib/api'
import { getPage, type PageProps } from '@renderer/lib/nav'
import { useAppStore, useIsAdvanced } from '@renderer/lib/store'
import { ClaudeMdTab } from './extensions/ClaudeMdTab'
import { ExtensionBrowser } from './extensions/ExtensionBrowser'
import { MarketplacesSection } from './extensions/MarketplacesSection'

const page = getPage('extensions')

type TabId = 'plugin' | 'skill' | 'agent' | 'command' | 'hooks' | 'output-style' | 'claude-md'

interface TabDef {
  id: TabId
  label: string
  icon: LucideIcon
  /** Shown in Simple mode too. */
  simple: boolean
  kinds?: ExtensionKind[]
}

const TABS: readonly TabDef[] = [
  { id: 'plugin', label: 'Plugins', icon: Package, simple: true, kinds: ['plugin'] },
  { id: 'skill', label: 'Skills', icon: Sparkles, simple: true, kinds: ['skill'] },
  { id: 'agent', label: 'Agents', icon: Bot, simple: false, kinds: ['agent'] },
  { id: 'command', label: 'Commands', icon: SquareSlash, simple: false, kinds: ['command'] },
  { id: 'hooks', label: 'Hooks & Status line', icon: Webhook, simple: false, kinds: ['hook', 'statusline'] },
  { id: 'output-style', label: 'Output styles', icon: Palette, simple: false, kinds: ['output-style'] },
  { id: 'claude-md', label: 'CLAUDE.md', icon: FileText, simple: true }
]

const ID_BASE = 'extensions'

/** Extensions: plugins, skills, agents, commands, hooks, status lines, output styles, marketplaces and CLAUDE.md. */
export default function ExtensionsPage({ params }: PageProps) {
  const advanced = useIsAdvanced()
  const replaceParams = useAppStore((s) => s.replaceParams)
  const [refreshing, setRefreshing] = useState(false)
  const visible = TABS.filter((t) => advanced || t.simple)
  const requested = typeof params.tab === 'string' ? params.tab : undefined
  const tab = visible.find((t) => t.id === requested) ?? visible[0] ?? TABS[0]

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      toastResult(await core.extensions.refresh())
    } catch (err) {
      toastError(err, 'Couldn’t refresh the lists')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <>
      <PageHeader
        icon={page.icon}
        title={page.label}
        subtitle="Plugins, skills, agents and commands for Claude Code."
        actions={
          advanced ? (
            <Tooltip content="Fetch the newest lists from every source">
              <Button leftIcon={RefreshCw} loading={refreshing} onClick={() => void refresh()}>
                Refresh lists
              </Button>
            </Tooltip>
          ) : undefined
        }
      >
        <div className="-mx-1 overflow-x-auto px-1 scrollbar-none">
          <Tabs
            idBase={ID_BASE}
            aria-label="Extension types"
            value={tab?.id ?? 'plugin'}
            onValueChange={(next) => replaceParams({ tab: next })}
            items={visible.map((t) => ({ value: t.id, label: t.label, icon: t.icon }))}
            className="min-w-max"
          />
        </div>
      </PageHeader>

      <div className="space-y-10">
        <SimpleOnly>
          {tab?.id !== 'claude-md' ? (
            <Callout tone="accent" icon={Info}>
              Extensions give Claude Code new abilities — in the terminal, in VS Code and in the Desktop app’s Code tab.
              They don’t change
              the Claude chat app.
            </Callout>
          ) : null}
        </SimpleOnly>

        {tab ? (
          <TabPanel idBase={ID_BASE} value={tab.id}>
            {tab.kinds ? <ExtensionBrowser key={tab.id} kinds={tab.kinds} advanced={advanced} /> : <ClaudeMdTab />}
          </TabPanel>
        ) : null}

        {advanced && tab?.id === 'plugin' ? <MarketplacesSection /> : null}
      </div>
    </>
  )
}
