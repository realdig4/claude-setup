/** Details of a catalog server in a side sheet: what it does, how it runs, what it needs, its tools and links. */
import { BadgeCheck, Blocks, Check, Plus } from 'lucide-react'
import type { CatalogServer, CategoryInfo, InstallOption, InstalledServer } from '@shared/types'
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  ErrorState,
  ExternalLink,
  KeyValue,
  ServerIcon,
  Sheet,
  Skeleton,
  SkeletonText
} from '@renderer/components/ui'
import { useAsync } from '@renderer/lib/hooks'
import { core } from '@renderer/lib/api'
import { formatCompact, formatDateTime, formatRelativeTime } from '@renderer/lib/format'
import { useNavigate } from '@renderer/lib/store'
import {
  KIND_LABELS,
  RUNTIME_LABELS,
  SOURCE_LABELS,
  defaultOption,
  isInstallable,
  optionNeedsKey,
  optionRequirement,
  optionTarget,
  optionTitle,
  transportLabel
} from './lib/catalog'
import { formFields, isRequired } from './lib/installForm'
import { markdownBlocks } from './lib/markdown'
import { ServerBadges } from './ServerBadges'
import { installedWhere } from './ServerCard'
import { ServerTools } from './ServerTools'

export interface ServerDetailSheetProps {
  /** Catalog id of the server to show (null closes the sheet). */
  serverId: string | null
  /** Already-loaded data (shown instantly while fresh details load). */
  initial?: CatalogServer
  onClose: () => void
  onAdd: (server: CatalogServer) => void
  categories?: CategoryInfo[]
  installedFor: (server: CatalogServer) => InstalledServer[]
  advanced: boolean
}

/** Side sheet with a server's details. */
export function ServerDetailSheet({ serverId, initial, onClose, onAdd, categories, installedFor, advanced }: ServerDetailSheetProps) {
  const details = useAsync<CatalogServer | null>(() => core.catalog.get(serverId ?? ''), [serverId], { enabled: !!serverId })
  const fresh = details.data && details.data.id === serverId ? details.data : undefined
  const server = fresh ?? (initial && initial.id === serverId ? initial : undefined)
  const notFound = details.data === null && !details.loading && !initial
  const installed = server ? installedFor(server) : []

  return (
    <Sheet
      open={!!serverId}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      size="lg"
      media={
        server ? <ServerIcon src={server.iconUrl} name={server.name} seed={server.id} size="xl" /> : <Skeleton className="size-14 rounded-2xl" />
      }
      title={server ? server.name : notFound ? 'Not found' : 'Loading…'}
      description={
        server?.publisher ? (
          <span className="inline-flex items-center gap-1">
            by {server.publisher}
            {server.official ? <BadgeCheck className="size-3.5 text-accent-text" aria-label="Official" role="img" /> : null}
          </span>
        ) : undefined
      }
      headerExtra={
        server ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {installed.length ? (
              <Badge size="sm" tone="success" icon={Check}>
                Added
              </Badge>
            ) : null}
            <ServerBadges server={server} advanced={advanced} />
          </div>
        ) : undefined
      }
      footer={
        server ? (
          isInstallable(server) ? (
            <Button variant="primary" leftIcon={Plus} onClick={() => onAdd(server)}>
              {installed.length ? 'Add to more apps' : 'Add to Claude'}
            </Button>
          ) : server.homepage || server.repository ? (
            <ExternalLink href={(server.homepage ?? server.repository) as string}>Open its website to set it up</ExternalLink>
          ) : null
        ) : undefined
      }
    >
      {server ? (
        <SheetBody server={server} installed={installed} categories={categories} advanced={advanced} onClose={onClose} />
      ) : details.error ? (
        <ErrorState size="sm" title="Couldn’t load the details" error={details.error} onRetry={() => void details.reload()} />
      ) : notFound ? (
        <EmptyState
          size="sm"
          icon={Blocks}
          title="This tool isn’t in the catalog anymore"
          description="It may have been renamed or removed. Try searching for it, or refresh the catalog."
        />
      ) : (
        <div className="space-y-6" aria-busy="true" aria-label="Loading details">
          <SkeletonText lines={3} />
          <Skeleton className="h-24 rounded-xl" />
          <SkeletonText lines={4} />
        </div>
      )}
    </Sheet>
  )
}

interface SheetBodyProps {
  server: CatalogServer
  installed: InstalledServer[]
  categories?: CategoryInfo[]
  advanced: boolean
  onClose: () => void
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="mb-2.5 text-[13px] font-semibold tracking-[-0.005em] text-fg">{children}</h3>
}

function SheetBody({ server, installed, categories, advanced, onClose }: SheetBodyProps) {
  const navigate = useNavigate()
  const option = defaultOption(server)
  const blocks = markdownBlocks(server.longDescription ?? '', 8).filter(
    (b, i) => !(i === 0 && b.kind === 'heading' && b.lines[0]?.toLowerCase().includes(server.name.toLowerCase()))
  )
  const fields = option ? formFields(option) : []
  const required = fields.filter(isRequired)
  const optionalCount = fields.length - required.length
  const categoryLabel = (id: string): string => categories?.find((c) => c.id === id)?.label ?? id

  return (
    <div className="space-y-7">
      <section>
        <p className="text-[14.5px] leading-[1.6] text-fg">{server.description || 'No description yet.'}</p>
        {blocks.length ? (
          <div className="mt-3 space-y-2.5 text-[13.5px] leading-[1.6] text-fg-muted">
            {blocks.map((block, i) =>
              block.kind === 'heading' ? (
                <h4 key={i} className="pt-1 text-[13px] font-semibold text-fg">
                  {block.lines[0]}
                </h4>
              ) : block.kind === 'list' ? (
                <ul key={i} className="list-disc space-y-1 pl-5">
                  {block.lines.slice(0, 8).map((line, j) => (
                    <li key={j}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p key={i}>{block.lines[0]}</p>
              )
            )}
          </div>
        ) : null}
      </section>

      {installed.length ? (
        <Callout
          tone="success"
          title={`Already added to ${installedWhere(installed)}`}
          action={
            <Button
              size="sm"
              onClick={() => {
                onClose()
                navigate('installed')
              }}
            >
              Manage
            </Button>
          }
        >
          {installed.some((s) => !s.enabled) ? 'It’s turned off in some apps.' : 'Claude can already use it there.'}
        </Callout>
      ) : null}

      <section>
        <SectionTitle>How it runs</SectionTitle>
        {advanced ? (
          <ul className="space-y-2">
            {server.install.map((o) => (
              <OptionRow key={o.id} option={o} isDefault={o.id === option?.id} />
            ))}
          </ul>
        ) : option ? (
          <div className="rounded-xl border border-line bg-surface px-4 py-3">
            <p className="text-sm font-medium text-fg">{optionTitle(option)}</p>
            <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">{option.notes ?? optionRequirement(option)}</p>
            {server.install.length > 1 ? (
              <p className="mt-1.5 text-xs text-fg-subtle">There are {server.install.length} ways to run it — you can choose when you add it.</p>
            ) : null}
          </div>
        ) : (
          <p className="text-[13px] text-fg-muted">This tool doesn’t say how to run it.</p>
        )}
      </section>

      {option && isInstallable(server) ? (
        <section>
          <SectionTitle>What you’ll need</SectionTitle>
          {required.length ? (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {required.map((f) => (
                <li key={f.key} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-fg">
                      {f.label}
                      {advanced ? <code className="ml-2 font-mono text-[11.5px] font-normal text-fg-muted">{f.name}</code> : null}
                    </p>
                    {f.description ? <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">{f.description}</p> : null}
                  </div>
                  {f.helpUrl ? (
                    <ExternalLink href={f.helpUrl} className="mt-0.5 shrink-0 text-[13px]">
                      {f.secret ? 'Get a key' : 'Learn more'}
                    </ExternalLink>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13.5px] text-fg-muted">Nothing — it works right away.</p>
          )}
          {optionalCount > 0 ? (
            <p className="mt-2 text-xs text-fg-subtle">
              Plus {optionalCount} optional {optionalCount === 1 ? 'setting' : 'settings'} you can fill in when you add it.
            </p>
          ) : null}
        </section>
      ) : null}

      {option && isInstallable(server) ? (
        <section>
          <SectionTitle>What it can do</SectionTitle>
          {optionNeedsKey(option) ? (
            <p className="text-[13.5px] text-fg-muted">Add it with your key to see the tools it gives Claude.</p>
          ) : (
            <ServerTools key={option.id} server={server} option={option} />
          )}
        </section>
      ) : null}

      <section>
        <SectionTitle>Details</SectionTitle>
        <KeyValue
          items={[
            server.publisher ? { label: 'Made by', value: server.publisher } : null,
            server.version ? { label: 'Version', value: server.version, mono: true } : null,
            server.updatedAt
              ? { label: 'Updated', value: formatRelativeTime(server.updatedAt), hint: advanced ? formatDateTime(server.updatedAt) : undefined }
              : null,
            server.stars ? { label: 'GitHub stars', value: formatCompact(server.stars) } : null,
            server.categories.length
              ? {
                  label: 'Category',
                  value: (
                    <span className="flex flex-wrap gap-1.5">
                      {server.categories.map((c) => (
                        <Badge key={c} size="sm">
                          {categoryLabel(c)}
                        </Badge>
                      ))}
                    </span>
                  )
                }
              : null,
            advanced && server.sources.length ? { label: 'Found in', value: server.sources.map((s) => SOURCE_LABELS[s]).join(', ') } : null,
            advanced ? { label: 'Catalog ID', value: server.id, mono: true, copy: server.id } : null
          ]}
        />
        {server.repository || server.homepage ? (
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[13.5px]">
            {server.homepage ? <ExternalLink href={server.homepage}>Website</ExternalLink> : null}
            {server.repository && server.repository !== server.homepage ? <ExternalLink href={server.repository}>Source code</ExternalLink> : null}
          </div>
        ) : null}
      </section>
    </div>
  )
}

function OptionRow({ option, isDefault }: { option: InstallOption; isDefault: boolean }) {
  const target = optionTarget(option)
  return (
    <li className="rounded-xl border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-sm font-medium text-fg">{option.label}</span>
        <Badge size="sm" variant="outline">
          {KIND_LABELS[option.kind]}
        </Badge>
        <Badge size="sm" variant="outline">
          {RUNTIME_LABELS[option.runtime]}
        </Badge>
        <Badge size="sm" variant="outline">
          {transportLabel(option.transport)}
        </Badge>
        {isDefault ? (
          <Badge size="sm" tone="accent">
            Default
          </Badge>
        ) : null}
      </div>
      {target ? <p className="mt-1.5 font-mono text-[12px] break-all text-fg-muted">{target}</p> : null}
      {option.notes ? <p className="mt-1 text-[12.5px] leading-5 text-fg-muted">{option.notes}</p> : null}
    </li>
  )
}
