import { useId } from 'react'
import { ArrowRight, CircleAlert, Plus, X } from 'lucide-react'
import type { ProxyUpstream } from '@shared/types'
import { Button, Card, CardContent, Field, Input, Select, Separator, type SelectOption } from '@renderer/components/ui'
import { CLAUDE_ALIASES, newRouteRow, routeChoices, type DraftIssues, type ProxyDraft, type RouteRow } from './logic'

export interface RoutesEditorProps {
  draft: ProxyDraft
  upstreams: ProxyUpstream[]
  issues: DraftIssues
  onChange: (patch: Partial<ProxyDraft>) => void
}

/** Choices for a route target: every upstream/model, plus the current value when it isn't one of them. */
function targetOptions(upstreams: ProxyUpstream[], current: string, emptyLabel: string): SelectOption[] {
  const choices = routeChoices(upstreams)
  const options: SelectOption[] = [{ value: '', label: emptyLabel }]
  if (current && !choices.some((c) => c.value === current)) options.push({ value: current, label: current })
  return [...options, ...choices]
}

/** Model routes: which upstream model answers when Claude Code asks for a given model name, plus the fallbacks. */
export function RoutesEditor({ draft, upstreams, issues, onChange }: RoutesEditorProps) {
  const listId = useId()
  const noModels = routeChoices(upstreams).length === 0

  const updateRow = (id: string, changes: Partial<RouteRow>): void => {
    onChange({ routes: draft.routes.map((r) => (r.id === id ? { ...r, ...changes } : r)) })
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 pt-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Everything else goes to" error={issues.defaultRoute} hint="Used for any model name without its own route.">
            <Select
              value={draft.defaultRoute}
              onValueChange={(defaultRoute) => onChange({ defaultRoute })}
              options={targetOptions(upstreams, draft.defaultRoute, noModels ? 'Add models to an upstream first' : 'Choose a model')}
            />
          </Field>
          <Field
            label="Background tasks go to"
            error={issues.smallRoute}
            hint="Quick work like titles and summaries (the Haiku slot)."
          >
            <Select
              value={draft.smallRoute}
              onValueChange={(smallRoute) => onChange({ smallRoute })}
              options={targetOptions(upstreams, draft.smallRoute, 'Same as everything else')}
            />
          </Field>
        </div>

        <Separator />

        <div className="flex flex-col gap-2" role="group" aria-label="Model routes">
          <div>
            <h3 className="text-sm font-semibold text-fg">Model routes</h3>
            <p className="text-[12.5px] leading-5 text-fg-muted">
              When Claude Code asks for a model by this name, the proxy sends the request to the chosen upstream model.
            </p>
          </div>
          {draft.routes.length ? (
            <div
              className="grid grid-cols-[minmax(0,1fr)_1rem_minmax(0,1.3fr)_2rem] gap-x-2 px-0.5 pt-1 text-xs font-medium text-fg-muted"
              aria-hidden="true"
            >
              <span>Model name Claude Code asks for</span>
              <span />
              <span>Goes to</span>
              <span />
            </div>
          ) : (
            <p className="text-[13px] text-fg-subtle">No routes yet — every request uses the default above.</p>
          )}
          {draft.routes.map((row, index) => {
            const error = issues.routes[row.id]
            return (
              <div key={row.id} className="flex flex-col gap-1">
                <div className="grid grid-cols-[minmax(0,1fr)_1rem_minmax(0,1.3fr)_2rem] items-center gap-x-2">
                  <Input
                    size="sm"
                    mono
                    value={row.alias}
                    onValueChange={(alias) => updateRow(row.id, { alias })}
                    placeholder="claude-sonnet-5-5"
                    list={listId}
                    aria-label={`Model name ${index + 1}`}
                    invalid={!!error}
                    spellCheck={false}
                  />
                  <ArrowRight className="size-4 text-fg-subtle" aria-hidden="true" />
                  <Select
                    size="sm"
                    value={row.target}
                    onValueChange={(target) => updateRow(row.id, { target })}
                    options={targetOptions(upstreams, row.target, 'Choose a model')}
                    aria-label={`Destination ${index + 1}`}
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove route ${row.alias || index + 1}`}
                    onClick={() => onChange({ routes: draft.routes.filter((r) => r.id !== row.id) })}
                  >
                    <X />
                  </Button>
                </div>
                {error ? (
                  <p className="flex items-start gap-1.5 text-[12.5px] leading-5 text-danger-text" role="alert">
                    <CircleAlert className="mt-[3px] size-3.5 shrink-0" aria-hidden="true" />
                    {error}
                  </p>
                ) : null}
              </div>
            )
          })}
          <datalist id={listId}>
            {CLAUDE_ALIASES.map((alias) => (
              <option key={alias} value={alias} />
            ))}
          </datalist>
          <div>
            <Button
              size="sm"
              variant="ghost"
              leftIcon={Plus}
              className="-ml-2"
              onClick={() => onChange({ routes: [...draft.routes, newRouteRow()] })}
            >
              Add route
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
