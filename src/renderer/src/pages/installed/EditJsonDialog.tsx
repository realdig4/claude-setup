/** Advanced: edit an installed tool's settings as JSON, with live validation, then save through the core. */
import { useEffect, useMemo, useState } from 'react'
import { Braces, CircleAlert, CircleCheck } from 'lucide-react'
import type { InstalledServer, ServerConfig } from '@shared/types'
import { Button, Dialog, PathText, Textarea, toastError, toastResult } from '@renderer/components/ui'
import { core } from '@renderer/lib/api'
import { refLabel } from '../discover/lib/targets'
import { parseConfigText } from '../discover/lib/customServer'
import { noteRestart } from '../discover/common/restart'
import { bumpServers } from '../discover/common/servers'

export interface EditJsonDialogProps {
  server: InstalledServer | null
  label: string
  onClose: () => void
}

function pretty(config: ServerConfig): string {
  return JSON.stringify(config, null, 2)
}

/** JSON editor dialog for one installed tool. */
export function EditJsonDialog({ server, label, onClose }: EditJsonDialogProps) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (server) setText(pretty(server.config))
  }, [server])

  const check = useMemo(() => parseConfigText(text), [text])
  const unchanged = !!server && check.ok && JSON.stringify(check.config) === JSON.stringify(server.config)

  const save = async (): Promise<void> => {
    if (!server || !check.ok) return
    setSaving(true)
    try {
      const result = await core.servers.update(server.name, server.target, check.config)
      toastResult(result, result.ok ? { successTitle: `Saved ${label}` } : { errorTitle: `Couldn’t save ${label}` })
      if (result.ok) {
        noteRestart(result)
        bumpServers()
        onClose()
      }
    } catch (err) {
      toastError(err, `Couldn’t save ${label}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={!!server}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      size="lg"
      icon={Braces}
      title={`Edit ${label}`}
      description={server ? `${refLabel(server.target)} · a backup is made before saving.` : undefined}
      dismissible={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="outline"
            disabled={!check.ok || saving}
            onClick={() => {
              if (check.ok) setText(pretty(check.config))
            }}
          >
            Tidy up
          </Button>
          <Button variant="primary" loading={saving} disabled={!check.ok || unchanged} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      {server ? (
        <div className="space-y-3">
          <PathText path={server.configPath} copy reveal />
          <Textarea
            mono
            rows={14}
            value={text}
            onValueChange={setText}
            aria-label={`Settings for ${label} (JSON)`}
            invalid={!check.ok}
            spellCheck={false}
            data-autofocus
            className="min-h-64"
          />
          {check.ok ? (
            <p className="flex items-center gap-1.5 text-[12.5px] text-success-text">
              <CircleCheck className="size-3.5" aria-hidden="true" />
              {unchanged ? 'No changes yet.' : 'Looks good.'}
            </p>
          ) : (
            <p role="alert" className="flex items-start gap-1.5 text-[12.5px] leading-5 text-danger-text">
              <CircleAlert className="mt-[3px] size-3.5 shrink-0" aria-hidden="true" />
              {check.message}
            </p>
          )}
          <p className="text-xs leading-5 text-fg-subtle">
            Use {'{ "type": "stdio", "command", "args", "env" }'} for programs or {'{ "type": "http", "url", "headers" }'} for online servers.
          </p>
        </div>
      ) : null}
    </Dialog>
  )
}
