import { useState, type FormEvent } from 'react'
import { BadgeCheck, Check, Plus, Store } from 'lucide-react'
import type { Marketplace } from '@shared/types'
import {
  Badge,
  Button,
  Card,
  ErrorState,
  ExternalLink,
  Field,
  IconTile,
  Input,
  List,
  ListItem,
  Section,
  Skeleton,
  toast,
  toastError,
  toastResult
} from '@renderer/components/ui'
import { core, errorMessage, useCoreEvent } from '@renderer/lib/api'
import { formatNumber } from '@renderer/lib/format'
import { useAsync, useProgress } from '@renderer/lib/hooks'
import { parseMarketplaceSource } from './meta'
import { TypeToConfirmDialog } from './TypeToConfirmDialog'

/** Plugin marketplaces (Advanced): add by owner/repo, add known ones, remove with a strong confirmation. */
export function MarketplacesSection() {
  const markets = useAsync(() => core.extensions.marketplaces(), [])
  const [source, setSource] = useState('')
  const [adding, setAdding] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<{ market: Marketplace; open: boolean } | null>(null)
  const { progress, reset } = useProgress('extensions')

  useCoreEvent('state', (event) => {
    if (event.key === 'extensions') void markets.reload()
  })

  const add = async (value: string, key: string): Promise<void> => {
    setAdding(key)
    setFormError(null)
    reset()
    try {
      const result = await core.extensions.addMarketplace(value)
      if (result.ok) {
        toastResult(result)
        if (key === 'form') setSource('')
      } else if (key === 'form') {
        setFormError(result.message)
      } else {
        toastResult(result)
      }
    } catch (err) {
      if (key === 'form') setFormError(errorMessage(err))
      else toastError(err, 'Couldn’t add the marketplace')
    } finally {
      setAdding(null)
      void markets.reload()
    }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const parsed = parseMarketplaceSource(source)
    if ('error' in parsed) {
      setFormError(parsed.error)
      return
    }
    void add(parsed.value, 'form')
  }

  const list = [...(markets.data ?? [])].sort(
    (a, b) => Number(b.added) - Number(a.added) || Number(!!b.official) - Number(!!a.official)
  )

  return (
    <Section title="Marketplaces" description="Where plugins come from. Adding one downloads its plugin list from GitHub.">
      <Card className="overflow-hidden">
        <form className="flex flex-wrap items-start gap-2 p-4" onSubmit={submit} noValidate>
          <Field
            label="Add a marketplace"
            error={formError ?? undefined}
            className="min-w-64 flex-1"
            hint={
              adding === 'form' && progress
                ? progress.message
                : 'A GitHub repository like “owner/repo”, or a URL to a marketplace.json file.'
            }
          >
            <Input
              mono
              value={source}
              onValueChange={(value) => {
                setSource(value)
                setFormError(null)
              }}
              placeholder="owner/repo"
              spellCheck={false}
              disabled={adding === 'form'}
            />
          </Field>
          <Button type="submit" leftIcon={Plus} loading={adding === 'form'} className="mt-[26px]">
            Add
          </Button>
        </form>

        {markets.error && !markets.data ? (
          <div className="border-t border-line">
            <ErrorState size="sm" title="Couldn’t load the marketplaces" error={markets.error} onRetry={() => void markets.reload()} />
          </div>
        ) : !markets.data ? (
          <ul className="divide-y divide-line border-t border-line" aria-label="Loading marketplaces">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-3.5 px-4 py-3.5">
                <Skeleton className="size-9 rounded-[10px]" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3.5 w-72 max-w-full" />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <List variant="plain" aria-label="Marketplaces" className="border-t border-line">
            {list.map((market) => (
              <ListItem
                key={market.name}
                media={<IconTile icon={Store} tone={market.official ? 'accent' : 'neutral'} size="md" />}
                title={
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-[13px]">{market.name}</span>
                    {market.official ? (
                      <Badge size="sm" tone="accent" icon={BadgeCheck}>
                        Anthropic
                      </Badge>
                    ) : null}
                  </span>
                }
                description={market.description ?? market.source}
                meta={
                  market.pluginCount !== undefined
                    ? `${formatNumber(market.pluginCount)} ${market.pluginCount === 1 ? 'plugin' : 'plugins'}`
                    : undefined
                }
                actions={
                  market.added ? (
                    <>
                      <Badge tone="success" icon={Check}>
                        Added
                      </Badge>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger-text"
                        onClick={() => setRemoving({ market, open: true })}
                      >
                        Remove
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      leftIcon={Plus}
                      loading={adding === market.name}
                      disabled={!!adding && adding !== market.name}
                      onClick={() => void add(market.repo ?? market.name, market.name)}
                    >
                      Add
                    </Button>
                  )
                }
              >
                {market.repo ? (
                  <div className="-mt-2 pl-[50px] text-xs">
                    <ExternalLink href={`https://github.com/${market.repo}`} tone="muted">
                      github.com/{market.repo}
                    </ExternalLink>
                  </div>
                ) : null}
              </ListItem>
            ))}
          </List>
        )}
      </Card>

      {removing ? (
        <TypeToConfirmDialog
          open={removing.open}
          onOpenChange={(open) => setRemoving((r) => (r ? { ...r, open } : r))}
          title={`Remove ${removing.market.name}?`}
          description={
            'Every plugin installed from it is uninstalled too — including its data and saved settings. ' +
            'You can add the marketplace again later.'
          }
          phrase={removing.market.name}
          confirmLabel="Remove marketplace"
          onConfirm={async () => {
            const result = await core.extensions.removeMarketplace(removing.market.name)
            if (!result.ok) throw new Error(result.message)
            toast.success(result.message)
            void markets.reload()
          }}
        />
      ) : null}
    </Section>
  )
}
