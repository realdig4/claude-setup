/**
 * Shows the outcome of a connection test: the tools a server offers, or a friendly explanation with the
 * technical details tucked away.
 */
import { CircleCheck, KeyRound, PlugZap, Timer, TriangleAlert, Wrench, type LucideIcon } from 'lucide-react'
import type { TestFailureKind, TestResult } from '@shared/types'
import { Badge, CodeBlock, Disclosure, IconTile, type Tone } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { formatDuration, pluralize } from '@renderer/lib/format'
import { useIsAdvanced } from '@renderer/lib/store'

const FAILURES: Record<TestFailureKind, { title: string; icon: LucideIcon; tone: Tone }> = {
  'auth-required': { title: 'It needs you to sign in or add a key', icon: KeyRound, tone: 'warn' },
  timeout: { title: 'It took too long to answer', icon: Timer, tone: 'warn' },
  'process-exited': { title: 'It stopped right after starting', icon: TriangleAlert, tone: 'danger' },
  'command-not-found': { title: 'A program it needs is missing', icon: Wrench, tone: 'warn' },
  'sse-failed': { title: 'Couldn’t connect to the online tool', icon: PlugZap, tone: 'danger' },
  'invalid-config': { title: 'Its settings look wrong', icon: TriangleAlert, tone: 'danger' },
  error: { title: 'It didn’t work', icon: TriangleAlert, tone: 'danger' }
}

export interface TestResultViewProps {
  result: TestResult
  /** Display name of the tool ("GitHub"). */
  name?: string
  /** Max tools listed before "and N more" (default 12). */
  maxTools?: number
  className?: string
}

/** Result of core.servers.test / testInstalled. */
export function TestResultView({ result, name, maxTools = 12, className }: TestResultViewProps) {
  const advanced = useIsAdvanced()
  if (result.ok) {
    const shown = result.tools.slice(0, maxTools)
    const more = result.tools.length - shown.length
    return (
      <div className={cn('space-y-4', className)}>
        <div className="flex items-start gap-3">
          <IconTile icon={CircleCheck} tone="success" size="md" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-fg">{name ? `${name} is working` : 'It’s working'}</p>
            <p className="mt-0.5 text-[13px] text-fg-muted">
              {result.tools.length
                ? `Claude can use ${pluralize(result.tools.length, 'tool')} from it.`
                : 'It answered, but didn’t list any tools.'}{' '}
              <span className="text-fg-subtle">Answered in {formatDuration(result.ms)}.</span>
            </p>
          </div>
        </div>
        {shown.length ? (
          <div className="@container">
            <ul aria-label="Tools it offers" className="grid gap-1.5 @md:grid-cols-2">
              {shown.map((tool) => (
                <li key={tool.name} className="min-w-0 rounded-lg border border-line bg-surface-2/50 px-3 py-2">
                  <div className="truncate font-mono text-[12px] font-medium text-fg">{tool.title ?? tool.name}</div>
                  {tool.description ? (
                    <div className="mt-0.5 line-clamp-2 text-xs leading-[1.45] text-fg-muted">{tool.description}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {more > 0 ? <p className="text-xs text-fg-subtle">…and {pluralize(more, 'more tool')}.</p> : null}
        {advanced && (result.serverName || result.protocol) ? (
          <div className="flex flex-wrap gap-1.5">
            {result.serverName ? (
              <Badge size="sm" variant="outline">
                {result.serverName}
                {result.serverVersion ? ` ${result.serverVersion}` : ''}
              </Badge>
            ) : null}
            {result.protocol ? (
              <Badge size="sm" variant="outline">
                MCP {result.protocol}
              </Badge>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }

  const failure = FAILURES[result.kind ?? 'error']
  const details = [result.error, result.stderr ? `\n${result.stderr}` : ''].filter(Boolean).join('\n').trim()
  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-start gap-3">
        <IconTile icon={failure.icon} tone={failure.tone} size="md" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-fg">{failure.title}</p>
          <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
            {result.hint ?? result.error ?? 'The tool didn’t answer. Check its settings and try again.'}
          </p>
        </div>
      </div>
      {details ? (
        <Disclosure title="Technical details" defaultOpen={advanced}>
          <CodeBlock code={details} language="text" maxHeight={200} wrap />
        </Disclosure>
      ) : null}
    </div>
  )
}
