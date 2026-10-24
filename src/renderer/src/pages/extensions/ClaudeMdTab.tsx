import { useEffect, useState } from 'react'
import { FileText, FolderPlus, Plus } from 'lucide-react'
import type { ClaudeMdTemplate } from '@shared/types'
import {
  AdvancedOnly,
  Button,
  Card,
  CardContent,
  Checkbox,
  CodeBlock,
  EmptyState,
  ErrorState,
  IconTile,
  OptionCard,
  OptionCardGroup,
  Segmented,
  Skeleton,
  confirmAction,
  toastError,
  toastResult
} from '@renderer/components/ui'
import { core, ui } from '@renderer/lib/api'
import { useAsync, useSettings } from '@renderer/lib/hooks'
import { useIsAdvanced } from '@renderer/lib/store'
import { MarkdownPreview } from './MarkdownPreview'

/** CLAUDE.md templates with a preview and one-click "add to my global file" / "add to a project". */
export function ClaudeMdTab() {
  const templates = useAsync(() => core.extensions.claudeMdTemplates(), [])
  const { settings, update } = useSettings()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'preview' | 'markdown'>('preview')
  const [replaceChecked, setReplace] = useState(false)
  const [busy, setBusy] = useState<'user' | 'project' | null>(null)
  // Replacing is an Advanced option; Simple mode always appends.
  const replace = useIsAdvanced() && replaceChecked

  useEffect(() => {
    if (!selectedId && templates.data?.length) setSelectedId(templates.data[0]?.id ?? null)
  }, [templates.data, selectedId])

  const selected: ClaudeMdTemplate | undefined = templates.data?.find((t) => t.id === selectedId)

  const confirmReplace = async (where: string): Promise<boolean> => {
    if (!replace) return true
    return confirmAction({
      title: 'Replace the whole file?',
      description: `Everything in ${where} is replaced with this template. A backup is made first, so you can undo it from Backups.`,
      tone: 'danger',
      confirmLabel: 'Replace file'
    })
  }

  const addToUser = async (): Promise<void> => {
    if (!selected || !(await confirmReplace('your global CLAUDE.md'))) return
    setBusy('user')
    try {
      toastResult(await core.extensions.writeClaudeMd(selected.id, { scope: 'user' }, replace || undefined))
    } catch (err) {
      toastError(err, 'Couldn’t update CLAUDE.md')
    } finally {
      setBusy(null)
    }
  }

  const addToProject = async (): Promise<void> => {
    if (!selected) return
    let projectPath: string | null
    try {
      projectPath = await ui.pickFolder({ title: 'Choose the project folder', defaultPath: settings?.recentProjects[0] })
    } catch (err) {
      toastError(err, 'Couldn’t open the folder picker')
      return
    }
    if (!projectPath) return
    if (!(await confirmReplace('this project’s CLAUDE.md'))) return
    if (settings) {
      const recentProjects = [projectPath, ...settings.recentProjects.filter((p) => p !== projectPath)].slice(0, 20)
      void update({ recentProjects })
    }
    setBusy('project')
    try {
      toastResult(await core.extensions.writeClaudeMd(selected.id, { scope: 'project', projectPath }, replace || undefined))
    } catch (err) {
      toastError(err, 'Couldn’t update CLAUDE.md')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card variant="muted">
        <CardContent className="flex items-start gap-4 pt-5">
          <IconTile icon={FileText} tone="accent" size="md" />
          <div className="text-[13.5px] leading-6 text-fg-muted">
            <p className="font-semibold text-fg">What is CLAUDE.md?</p>
            <p>
              A note Claude Code reads at the start of every session — how you like to work, project rules and handy commands.
              Your global
              file applies everywhere; a project’s file only there. Pick a template to start, then edit it any time.
            </p>
          </div>
        </CardContent>
      </Card>

      {templates.error && !templates.data ? (
        <ErrorState framed title="Couldn’t load the templates" error={templates.error} onRetry={() => void templates.reload()} />
      ) : !templates.data ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-80 rounded-xl" />
        </div>
      ) : templates.data.length === 0 ? (
        <EmptyState
          framed
          icon={FileText}
          title="No templates available"
          description="Update Claude Setup to get CLAUDE.md templates."
        />
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <OptionCardGroup label="CLAUDE.md templates" columns={1}>
            {templates.data.map((template) => (
              <OptionCard
                key={template.id}
                title={template.name}
                description={template.description}
                checked={template.id === selectedId}
                onCheckedChange={() => setSelectedId(template.id)}
              />
            ))}
          </OptionCardGroup>

          {selected ? (
            <Card className="overflow-hidden lg:sticky lg:top-4">
              <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-2/50 px-5 py-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-fg">{selected.name}</h3>
                  <p className="text-xs text-fg-muted">Preview</p>
                </div>
                <Segmented
                  size="sm"
                  aria-label="Preview style"
                  value={view}
                  onValueChange={setView}
                  options={[
                    { value: 'preview', label: 'Preview' },
                    { value: 'markdown', label: 'Markdown' }
                  ]}
                />
              </div>
              <div className="max-h-[420px] overflow-y-auto px-5 py-4">
                {view === 'preview' ? (
                  <MarkdownPreview source={selected.content} />
                ) : (
                  <CodeBlock code={selected.content} language="text" maxHeight={380} wrap />
                )}
              </div>
              <div className="flex flex-col gap-3 border-t border-line bg-surface-2/40 px-5 py-4">
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    leftIcon={Plus}
                    loading={busy === 'user'}
                    disabled={!!busy}
                    onClick={() => void addToUser()}
                  >
                    {replace ? 'Use as my global CLAUDE.md' : 'Add to my global CLAUDE.md'}
                  </Button>
                  <Button leftIcon={FolderPlus} loading={busy === 'project'} disabled={!!busy} onClick={() => void addToProject()}>
                    Add to a project…
                  </Button>
                </div>
                <p className="text-xs text-fg-subtle">
                  {replace ? 'The file is replaced. ' : 'It’s added to the end of the file, so nothing you wrote is lost. '}
                  A backup is made first.
                </p>
                <AdvancedOnly>
                  <Checkbox
                    checked={replaceChecked}
                    onCheckedChange={setReplace}
                    label="Replace the file instead of adding to it"
                    description="Global file: ~/.claude/CLAUDE.md · project file: <project>/CLAUDE.md"
                  />
                </AdvancedOnly>
              </div>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  )
}
