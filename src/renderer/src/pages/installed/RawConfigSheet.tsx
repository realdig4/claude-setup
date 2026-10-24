/** Advanced: read-only view of an app's raw config file, with copy / show in folder / open actions. */
import { ExternalLink as OpenIcon, FileJson, FolderOpen } from 'lucide-react'
import type { TargetRef } from '@shared/types'
import { Button, CodeBlock, EmptyState, ErrorState, PathText, Sheet, Skeleton, toast } from '@renderer/components/ui'
import { core, errorMessage, ui } from '@renderer/lib/api'
import { useAsync } from '@renderer/lib/hooks'
import { refLabel } from '../discover/lib/targets'

export interface RawConfigSheetProps {
  target: TargetRef | null
  onClose: () => void
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** Shows the exact file an app reads its tools from. */
export function RawConfigSheet({ target, onClose }: RawConfigSheetProps) {
  const raw = useAsync(() => core.targets.readRaw(target as TargetRef), [target ? JSON.stringify(target) : ''], {
    enabled: !!target,
    keepPreviousData: false
  })
  const data = raw.data

  const open = async (path: string): Promise<void> => {
    try {
      const problem = await ui.openPath(path)
      if (problem) toast.error('Couldn’t open the file', { description: problem })
    } catch (err) {
      toast.error('Couldn’t open the file', { description: errorMessage(err) })
    }
  }

  return (
    <Sheet
      open={!!target}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
      size="xl"
      title="Config file"
      description={target ? refLabel(target) : undefined}
      media={<FileJson className="mt-1 size-5 text-fg-subtle" aria-hidden="true" />}
      headerExtra={data?.path ? <PathText path={data.path} max={80} copy /> : undefined}
      footer={
        data?.exists ? (
          <>
            <Button leftIcon={FolderOpen} onClick={() => void ui.showItemInFolder(data.path).catch(() => toast.error('Couldn’t open the folder'))}>
              Show in folder
            </Button>
            <Button leftIcon={OpenIcon} onClick={() => void open(data.path)}>
              Open in editor
            </Button>
          </>
        ) : undefined
      }
    >
      {raw.error ? (
        <ErrorState size="sm" title="Couldn’t read the file" error={raw.error} onRetry={() => void raw.reload()} />
      ) : raw.loading || data === undefined ? (
        <Skeleton className="h-80 rounded-xl" aria-label="Loading the file" />
      ) : data === null ? (
        <EmptyState
          size="sm"
          icon={FileJson}
          title="No config file here"
          description="This place doesn’t have a settings file Claude Setup can read."
        />
      ) : !data.exists ? (
        <EmptyState
          size="sm"
          icon={FileJson}
          title="The file doesn’t exist yet"
          description="It’s created the first time you add a tool here."
        />
      ) : (
        <CodeBlock
          code={data.text}
          // Very large files (Claude Code keeps per-project history here) are shown without colors to stay fast.
          language={data.text.length < 150_000 && isJson(data.text) ? 'json' : 'text'}
          maxHeight="calc(100vh - 260px)"
          title={data.path.split(/[\\/]/).pop()}
        />
      )}
    </Sheet>
  )
}
