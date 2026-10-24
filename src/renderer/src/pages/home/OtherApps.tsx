/** Advanced: compact status of the other apps Claude Setup can configure (VS Code, Cursor, Windsurf). */
import type { InstalledServer, TargetInfo } from '@shared/types'
import { Badge, Button, List, ListItem, PathText } from '@renderer/components/ui'
import { pluralize } from '@renderer/lib/format'
import { APP_BLURBS, AppIcon } from '../discover/common/apps'

export interface OtherAppsProps {
  targets: TargetInfo[]
  installed: InstalledServer[] | undefined
  onManage: () => void
}

/** One row per non-primary app. */
export function OtherApps({ targets, installed, onManage }: OtherAppsProps) {
  return (
    <List aria-label="Other apps">
      {targets.map((target) => {
        const count = installed?.filter((s) => s.target.target === target.id).length ?? target.serverCount
        return (
          <ListItem
            key={target.id}
            media={<AppIcon target={target.id} size="sm" tone={target.installed ? 'accent' : 'neutral'} />}
            title={
              <span className="flex items-center gap-2">
                {target.label}
                {target.version ? <span className="font-mono text-xs font-normal text-fg-subtle">{target.version}</span> : null}
              </span>
            }
            description={target.installed && target.configPath ? <PathText path={target.configPath} max={64} /> : APP_BLURBS[target.id]}
            meta={target.installed ? pluralize(count, 'tool') : undefined}
            actions={
              <>
                {target.installed ? (
                  !target.configValid ? (
                    <Badge size="sm" tone="warn">
                      Needs a fix
                    </Badge>
                  ) : (
                    <Badge size="sm" tone="success" dot>
                      Found
                    </Badge>
                  )
                ) : (
                  <Badge size="sm">Not installed</Badge>
                )}
                {target.installed && count > 0 ? (
                  <Button size="sm" variant="ghost" onClick={onManage} aria-label={`Manage tools in ${target.label}`}>
                    Manage
                  </Button>
                ) : null}
              </>
            }
          />
        )
      })}
    </List>
  )
}
