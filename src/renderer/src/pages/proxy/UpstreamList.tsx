import { Check, Ellipsis, KeyRound, Pencil, Plus, Server, Trash2 } from 'lucide-react'
import type { ModelProfile, ProviderPreset, ProxyUpstream } from '@shared/types'
import { Badge, Button, Card, EmptyState, Menu, Monogram } from '@renderer/components/ui'
import { formatNumber } from '@renderer/lib/format'

export interface UpstreamListProps {
  upstreams: ProxyUpstream[]
  presets: ProviderPreset[]
  profiles: ModelProfile[] | undefined
  /** Saved-key state by keyRef. */
  keys: Record<string, boolean>
  /** Messages per upstream index (validation). */
  issues: Record<number, string>
  onAdd: () => void
  onEdit: (upstream: ProxyUpstream) => void
  onRemove: (upstream: ProxyUpstream) => void
}

const REASONING_LABELS: Record<NonNullable<ProxyUpstream['reasoning']>, string> = {
  off: 'Reasoning off',
  effort: 'Reasoning effort',
  roundtrip: 'Reasoning round-trip',
  both: 'Reasoning effort + round-trip'
}

/** The upstream servers the proxy can forward to, as cards with edit/remove actions. */
export function UpstreamList({ upstreams, presets, profiles, keys, issues, onAdd, onEdit, onRemove }: UpstreamListProps) {
  if (upstreams.length === 0) {
    return (
      <EmptyState
        framed
        size="sm"
        icon={Server}
        title="No upstreams yet"
        description={
          'Add the OpenAI-style server you want Claude Code to use — or set up OpenAI, Gemini or Groq on the Models page ' +
          'and Claude Setup adds it for you.'
        }
        actions={
          <Button size="sm" variant="primary" leftIcon={Plus} onClick={onAdd}>
            Add upstream
          </Button>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {upstreams.map((upstream, index) => {
        const preset = presets.find((p) => p.id === upstream.providerId)
        const profile = profiles?.find((p) => p.id === upstream.id)
        const keySaved = upstream.keyRef ? keys[upstream.keyRef] : undefined
        const issue = issues[index]
        const headerCount = Object.keys(upstream.extraHeaders ?? {}).length
        const facts = [
          `${formatNumber(upstream.models.length)} ${upstream.models.length === 1 ? 'model' : 'models'}`,
          upstream.maxOutputTokens ? `max ${formatNumber(upstream.maxOutputTokens)} tokens out` : null,
          upstream.reasoning ? REASONING_LABELS[upstream.reasoning] : null,
          upstream.useMaxCompletionTokens ? 'max_completion_tokens' : null,
          upstream.streamOptions === false ? 'no stream_options' : null,
          headerCount ? `${headerCount} extra ${headerCount === 1 ? 'header' : 'headers'}` : null
        ].filter(Boolean)
        return (
          <Card key={`${upstream.id}-${index}`} className={issue ? 'border-danger-line' : undefined}>
            <div className="flex items-start gap-3.5 p-4">
              <Monogram text={upstream.name || upstream.id} letters={preset?.monogram} color={preset?.color} seed={upstream.id} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-fg">{upstream.name || upstream.id}</span>
                  <code className="rounded bg-surface-3/70 px-1.5 font-mono text-[11.5px] text-fg-muted">{upstream.id}</code>
                  {profile ? (
                    <Badge size="sm" tone="accent">
                      From setup “{profile.name}”
                    </Badge>
                  ) : null}
                  {!upstream.keyRef ? (
                    <Badge size="sm">No key</Badge>
                  ) : keySaved === false ? (
                    <Badge size="sm" tone="warn" icon={KeyRound}>
                      Key missing
                    </Badge>
                  ) : keySaved ? (
                    <Badge size="sm" tone="success" icon={Check}>
                      Key saved
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 truncate font-mono text-xs text-fg-muted">{upstream.baseUrl}</p>
                <p className="mt-1 text-xs text-fg-subtle">{facts.join(' · ')}</p>
                {upstream.models.length ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {upstream.models.slice(0, 6).map((model) => (
                      <code
                        key={model}
                        className="rounded-md border border-line bg-surface-2/60 px-1.5 py-0.5 font-mono text-[11px] text-fg-muted"
                      >
                        {model}
                      </code>
                    ))}
                    {upstream.models.length > 6 ? (
                      <span className="px-1 text-[11px] text-fg-subtle">+{upstream.models.length - 6} more</span>
                    ) : null}
                  </div>
                ) : null}
                {issue ? (
                  <p className="mt-2 text-[12.5px] text-danger-text" role="alert">
                    {issue}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" leftIcon={Pencil} onClick={() => onEdit(upstream)}>
                  Edit
                </Button>
                <Menu
                  label={`Actions for ${upstream.name || upstream.id}`}
                  trigger={
                    <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${upstream.name || upstream.id}`}>
                      <Ellipsis />
                    </Button>
                  }
                  items={[{ label: 'Remove upstream', icon: Trash2, tone: 'danger', onSelect: () => onRemove(upstream) }]}
                />
              </div>
            </div>
          </Card>
        )
      })}
    </div>
  )
}
