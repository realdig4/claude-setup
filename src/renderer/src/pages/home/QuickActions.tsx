/** Home quick-action tiles: the four things people come here to do. */
import { ArrowRight, BrainCircuit, Compass, Puzzle, Stethoscope, type LucideIcon } from 'lucide-react'
import { IconTile, type Tone } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { formatCompact } from '@renderer/lib/format'
import type { PageId, RouteParams } from '@renderer/lib/nav'

interface Action {
  title: string
  description: string
  icon: LucideIcon
  tone: Tone
  page: PageId
  params?: RouteParams
}

export interface QuickActionsProps {
  /** Catalog size for the "Add tools" tile. */
  catalogTotal?: number
  onNavigate: (page: PageId, params?: RouteParams) => void
}

/** Four friendly tiles that jump to the main areas of the app. */
export function QuickActions({ catalogTotal, onNavigate }: QuickActionsProps) {
  const actions: Action[] = [
    {
      title: 'Add tools to Claude',
      description: `Browse ${catalogTotal ? `${formatCompact(catalogTotal)} ` : ''}tools — from GitHub to your own files.`,
      icon: Compass,
      tone: 'accent',
      page: 'discover'
    },
    {
      title: 'Use a different AI model',
      description: 'Try Kimi, DeepSeek, GLM and more in Claude Code.',
      icon: BrainCircuit,
      tone: 'info',
      page: 'models'
    },
    {
      title: 'Check my setup',
      description: 'Find and fix common problems in one click.',
      icon: Stethoscope,
      tone: 'success',
      page: 'doctor',
      params: { run: true }
    },
    {
      title: 'Get skills & plugins',
      description: 'Teach Claude Code new tricks with plugins, skills and agents.',
      icon: Puzzle,
      tone: 'warn',
      page: 'extensions'
    }
  ]
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {actions.map((action) => (
        <button
          key={action.title}
          type="button"
          onClick={() => onNavigate(action.page, action.params)}
          className={cn(
            'group flex h-full flex-col items-start gap-3 rounded-xl border border-line bg-surface p-4 text-left shadow-xs',
            'transition-[border-color,box-shadow,transform] duration-200 ease-smooth hover:-translate-y-px hover:border-line-strong hover:shadow-md'
          )}
        >
          <div className="flex w-full items-start justify-between">
            <IconTile icon={action.icon} tone={action.tone} size="md" />
            <ArrowRight
              className={cn(
                'size-4 text-fg-subtle opacity-0 transition-[opacity,transform] duration-200',
                'group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100'
              )}
              aria-hidden="true"
            />
          </div>
          <div>
            <div className="text-sm font-semibold text-fg">{action.title}</div>
            <div className="mt-0.5 text-[13px] leading-5 text-fg-muted">{action.description}</div>
          </div>
        </button>
      ))}
    </div>
  )
}
