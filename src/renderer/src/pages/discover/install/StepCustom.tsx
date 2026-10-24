/** Wizard step 2 (custom tool, Advanced): a program with arguments and environment, or an online URL with headers. */
import { useState } from 'react'
import { ClipboardPaste, Globe, SquareTerminal } from 'lucide-react'
import { Button, Disclosure, Field, Input, Segmented, Textarea, toast } from '@renderer/components/ui'
import { FieldGroup, KeyValueEditor, ListEditor } from '../common/inputs'
import { configToDraft, nameForConfig, parseServerJson, type CustomDraft, type DraftErrors } from '../lib/customServer'

export interface StepCustomProps {
  draft: CustomDraft
  onChange: (draft: CustomDraft) => void
  /** Shown only after Next was pressed. */
  errors: DraftErrors
}

/** Custom server form with a "paste JSON" shortcut. */
export function StepCustom({ draft, onChange, errors }: StepCustomProps) {
  const [json, setJson] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const set = (patch: Partial<CustomDraft>): void => onChange({ ...draft, ...patch })

  const applyJson = (): void => {
    const parsed = parseServerJson(json)
    if (!parsed.ok) {
      setJsonError(parsed.message)
      return
    }
    const name = draft.name.trim() || parsed.name || nameForConfig(parsed.config)
    onChange(configToDraft(name, parsed.config))
    setJsonError(null)
    setJson('')
    setPasteOpen(false)
    toast.success('Filled in from your JSON', { description: 'Check the details below, then continue.' })
  }

  return (
    <div className="space-y-5">
      <Disclosure
        variant="card"
        title="Paste JSON from a README"
        description="Fills in the form for you"
        open={pasteOpen}
        onOpenChange={setPasteOpen}
      >
        <div className="space-y-3">
          <Textarea
            mono
            rows={6}
            value={json}
            onValueChange={(v) => {
              setJson(v)
              if (jsonError) setJsonError(null)
            }}
            placeholder={'{\n  "mcpServers": {\n    "my-tool": { "command": "npx", "args": ["-y", "my-mcp-server"] }\n  }\n}'}
            aria-label="Server JSON"
            invalid={!!jsonError}
          />
          {jsonError ? (
            <p role="alert" className="text-[12.5px] text-danger-text">
              {jsonError}
            </p>
          ) : null}
          <Button size="sm" variant="outline" leftIcon={ClipboardPaste} onClick={applyJson} disabled={!json.trim()}>
            Fill in the form
          </Button>
        </div>
      </Disclosure>

      <Field label="Name" hint="Letters, numbers, “-” and “_”. Claude shows this name in its tool list." error={errors.name} required>
        <Input mono value={draft.name} onValueChange={(name) => set({ name })} placeholder="my-tool" spellCheck={false} autoComplete="off" />
      </Field>

      <div className="space-y-2">
        <span className="block text-[13px] font-medium text-fg" aria-hidden="true">
          How does it run?
        </span>
        <Segmented
          aria-label="How does it run?"
          value={draft.kind}
          onValueChange={(kind) => set({ kind })}
          options={[
            { value: 'command', label: 'Program on this computer', icon: SquareTerminal },
            { value: 'url', label: 'Online server (URL)', icon: Globe }
          ]}
        />
      </div>

      {draft.kind === 'command' ? (
        <>
          <Field label="Program" hint="The command that starts the server, like npx, uvx, docker or a full path." error={errors.command} required>
            <Input
              mono
              value={draft.command}
              onValueChange={(command) => set({ command })}
              placeholder="npx"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <FieldGroup label="Arguments" optional hint="One per row, in order — no quotes needed.">
            <ListEditor itemLabel="Argument" values={draft.args} onChange={(args) => set({ args })} addLabel="Add argument" placeholder="-y" />
          </FieldGroup>
          <FieldGroup label="Environment variables" optional error={errors.env} hint="Keys and settings the server reads, like API_KEY.">
            <KeyValueEditor
              rows={draft.env}
              onChange={(env) => set({ env })}
              keyLabel="Name"
              valueLabel="Value"
              addLabel="Add variable"
              keyPlaceholder="API_KEY"
              invalid={!!errors.env}
            />
          </FieldGroup>
        </>
      ) : (
        <>
          <Field label="Server address" error={errors.url} required hint="Usually ends in /mcp (or /sse for older servers).">
            <Input
              mono
              type="url"
              value={draft.url}
              onValueChange={(url) => set({ url })}
              placeholder="https://example.com/mcp"
              spellCheck={false}
            />
          </Field>
          <div className="space-y-2">
            <span className="block text-[13px] font-medium text-fg" aria-hidden="true">
              Connection type
            </span>
            <Segmented
              aria-label="Connection type"
              size="sm"
              value={draft.transport}
              onValueChange={(transport) => set({ transport })}
              options={[
                { value: 'http', label: 'Streamable HTTP' },
                { value: 'sse', label: 'SSE (older)' }
              ]}
            />
          </div>
          <FieldGroup label="Headers" optional error={errors.headers} hint="For example Authorization: Bearer <token>.">
            <KeyValueEditor
              rows={draft.headers}
              onChange={(headers) => set({ headers })}
              keyLabel="Header"
              valueLabel="Value"
              addLabel="Add header"
              keyPlaceholder="Authorization"
              invalid={!!errors.headers}
            />
          </FieldGroup>
        </>
      )}
    </div>
  )
}
