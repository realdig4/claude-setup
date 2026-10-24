import { Activity, Code2, Ellipsis, KeyRound, Pencil, Play, SquareTerminal, Trash2 } from 'lucide-react'
import type { ModelProfile, ModelTarget, ProviderPreset } from '@shared/types'
import { Badge, Button, List, ListItem, Menu, Monogram, Skeleton, type MenuItem } from '@renderer/components/ui'
import { formatRelativeTime } from '@renderer/lib/format'
import { hostOf, modelLabel } from './logic'

export interface ProfileListProps {
  profiles: ModelProfile[] | undefined
  providers: ProviderPreset[] | undefined
  loading: boolean
  activeProfileId?: string
  /** Profile id currently being applied / tested. */
  busyId?: string | null
  advanced: boolean
  onUse: (profile: ModelProfile, targets?: ModelTarget[]) => void
  onEdit: (profile: ModelProfile) => void
  onTest: (profile: ModelProfile) => void
  onDelete: (profile: ModelProfile) => void
}

/** Saved model setups with a quick "Use" button and edit / test / delete actions. */
export function ProfileList(props: ProfileListProps) {
  const { profiles, providers, loading, activeProfileId, busyId, advanced, onUse, onEdit, onTest, onDelete } = props
  if (!profiles) {
    if (!loading) return null
    return (
      <List aria-label="Loading saved setups">
        {[0, 1].map((i) => (
          <li key={i} className="flex items-center gap-3.5 px-4 py-3.5">
            <Skeleton className="size-9 rounded-[10px]" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3.5 w-64 max-w-full" />
            </div>
            <Skeleton className="h-8 w-16 rounded-lg" />
          </li>
        ))}
      </List>
    )
  }

  return (
    <List aria-label="Saved setups">
      {profiles.map((profile) => {
        const preset = providers?.find((p) => p.id === profile.providerId)
        const active = profile.id === activeProfileId
        const missingKey = !!preset?.requiresKey && !profile.hasKey
        const region = (preset?.regions.length ?? 0) > 1 ? preset?.regions.find((r) => r.id === profile.regionId)?.label : undefined
        const busy = busyId === profile.id
        const parts = [preset?.name ?? profile.providerId, modelLabel(preset?.models, profile.models.main)]
        if (advanced && region) parts.push(region)
        const customAddress = !!profile.baseUrl && !preset?.regions.some((r) => r.baseUrl === profile.baseUrl)
        if (advanced && customAddress) parts.push(hostOf(profile.baseUrl))

        const menu: MenuItem[] = [
          { label: 'Edit', icon: Pencil, onSelect: () => onEdit(profile) },
          { label: 'Test connection', icon: Activity, onSelect: () => onTest(profile), disabled: missingKey },
          ...(advanced
            ? ([
                { type: 'separator' },
                {
                  label: 'Use in the terminal only',
                  icon: SquareTerminal,
                  onSelect: () => onUse(profile, ['claude-code']),
                  disabled: missingKey
                },
                { label: 'Use in VS Code only', icon: Code2, onSelect: () => onUse(profile, ['vscode']), disabled: missingKey }
              ] satisfies MenuItem[])
            : []),
          { type: 'separator' },
          { label: 'Delete', icon: Trash2, tone: 'danger', onSelect: () => onDelete(profile) }
        ]

        return (
          <ListItem
            key={profile.id}
            media={
              preset ? <Monogram text={preset.name} letters={preset.monogram} color={preset.color} /> : <Monogram text={profile.name} />
            }
            title={
              <span className="flex items-center gap-2">
                <span className="truncate">{profile.name}</span>
                {active ? (
                  <Badge tone="success" size="sm" dot>
                    In use
                  </Badge>
                ) : null}
                {missingKey ? (
                  <Badge tone="warn" size="sm" icon={KeyRound}>
                    Key missing
                  </Badge>
                ) : null}
              </span>
            }
            description={parts.filter(Boolean).join(' · ')}
            meta={advanced ? `Updated ${formatRelativeTime(profile.updatedAt)}` : undefined}
            actions={
              <>
                {missingKey ? (
                  <Button size="sm" leftIcon={KeyRound} onClick={() => onEdit(profile)}>
                    Add key
                  </Button>
                ) : !active ? (
                  <Button size="sm" leftIcon={Play} loading={busy} onClick={() => onUse(profile)}>
                    Use
                  </Button>
                ) : null}
                <Menu
                  label={`Actions for ${profile.name}`}
                  trigger={
                    <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${profile.name}`}>
                      <Ellipsis />
                    </Button>
                  }
                  items={menu}
                />
              </>
            }
          />
        )
      })}
    </List>
  )
}
