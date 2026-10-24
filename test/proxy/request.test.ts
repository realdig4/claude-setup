import { describe, expect, it } from 'vitest'
import type { ProxyUpstream } from '@shared/types'
import { ToolNameMapper } from '@core/proxy/names'
import { detectQuirks } from '@core/proxy/quirks'
import { parseAnthropicRequest, repairToolSequence, toOpenAIRequest } from '@core/proxy/translate/request'
import type { OpenAIMessage, OpenAIRequest } from '@core/proxy/wire'
import { firstTurnVscode, toolResultsWithBilling, toolResultsWithThinking, webSearchSubRequest } from './fixtures'

const generic: ProxyUpstream = {
  id: 'mock',
  name: 'Mock',
  baseUrl: 'https://llm.example.com/v1',
  models: ['mock-kimi'],
  maxOutputTokens: 16384,
  reasoning: 'off'
}

function translate(body: unknown, upstream: Partial<ProxyUpstream> = {}, model = 'mock-kimi') {
  const parsed = parseAnthropicRequest(body)
  if (!parsed.ok) throw new Error(parsed.message)
  const up = { ...generic, ...upstream }
  const names = new ToolNameMapper()
  const result = toOpenAIRequest(parsed.request, { upstream: up, model, names, quirks: detectQuirks(up) })
  return { ...result, names }
}

describe('request translation — captured Claude Code requests', () => {
  it('first turn: drops the billing block, merges the mid-conversation system message, cleans tools', () => {
    const { payload, droppedTools } = translate(firstTurnVscode)
    expect(payload.model).toBe('mock-kimi')
    const [system, user, ...rest] = payload.messages
    expect(rest).toHaveLength(0)
    expect(system.role).toBe('system')
    expect(system.content).toMatch(/^You are a Claude agent, built on Anthropic's Claude Agent SDK\.\n\n\nYou are an agent working/)
    expect(system.content).not.toContain('x-anthropic-billing-header')
    expect(user.role).toBe('user')
    expect(typeof user.content).toBe('string')
    const text = user.content as string
    expect(text.startsWith('<system-reminder>\nAttribution for git commits')).toBe(true)
    expect(text).toContain('\nSay\n\n<system-reminder>\n# Environment\n')
    expect(text.endsWith('\n</system-reminder>')).toBe(true)

    expect(droppedTools).toEqual(['DeferredToolPlaceholder'])
    const names = payload.tools?.map((t) => t.function.name)
    expect(names).toEqual(['Bash', 'Glob', 'Read'])
    const read = payload.tools?.find((t) => t.function.name === 'Read')
    expect(read?.function.parameters.$schema).toBeUndefined()
    expect(read?.function.parameters.type).toBe('object')
    expect((read?.function.parameters.properties as Record<string, Record<string, unknown>>).limit.exclusiveMinimum).toBe(0)
    expect(read?.function.description).toMatch(/^Reads a file/)

    expect(payload.max_tokens).toBe(16384)
    expect(payload.stream).toBe(true)
    expect(payload.stream_options).toEqual({ include_usage: true })
    expect(payload.reasoning_effort).toBeUndefined()
    const json = JSON.stringify(payload)
    for (const gone of ['cache_control', 'context_management', 'metadata', 'thinking', 'output_config', 'defer_loading']) expect(json).not.toContain(gone)
  })

  it('second turn: assistant tool calls followed by tool messages, in order', () => {
    const { payload, historyToolIds } = translate(toolResultsWithBilling)
    const roles = payload.messages.map((m) => m.role)
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'tool'])
    const assistant = payload.messages[2] as Extract<OpenAIMessage, { role: 'assistant' }>
    expect(assistant.content).toBe('Checking files.')
    expect(assistant.tool_calls).toEqual([
      { id: 'toolu_cap_read_1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'C:\\Users\\dev\\project\\hello.txt' }) } },
      { id: 'toolu_cap_glob_2', type: 'function', function: { name: 'Glob', arguments: '{"pattern":"no-such-dir-xyz/**/*.zzz"}' } }
    ])
    expect(assistant.reasoning_content).toBeUndefined()
    expect(payload.messages[3]).toEqual({ role: 'tool', tool_call_id: 'toolu_cap_read_1', content: '1\thello from file\n2\t' })
    expect(payload.messages[4]).toEqual({ role: 'tool', tool_call_id: 'toolu_cap_glob_2', content: 'No files found' })
    expect([...historyToolIds]).toEqual(['toolu_cap_read_1', 'toolu_cap_glob_2'])
    // The string-form system message is merged into the first user message too.
    expect(payload.messages[1].content).toContain('<system-reminder>\n# Environment')
  })

  it('replayed thinking is round-tripped as reasoning_content only when the upstream asks for it', () => {
    const off = translate(toolResultsWithThinking).payload.messages[2] as Extract<OpenAIMessage, { role: 'assistant' }>
    expect(off.reasoning_content).toBeUndefined()
    expect(off.content).toBeNull()
    expect(off.tool_calls).toHaveLength(2)

    const roundtrip = translate(toolResultsWithThinking, { reasoning: 'roundtrip' }).payload.messages[2] as Extract<OpenAIMessage, { role: 'assistant' }>
    expect(roundtrip.reasoning_content).toBe('I should read the file first.')

    const effort = translate(toolResultsWithThinking, { reasoning: 'effort' }).payload
    expect(effort.reasoning_effort).toBe('high')
    expect((effort.messages[2] as { reasoning_content?: string }).reasoning_content).toBeUndefined()

    const both = translate(toolResultsWithThinking, { reasoning: 'both' }).payload
    expect(both.reasoning_effort).toBe('high')
    expect((both.messages[2] as { reasoning_content?: string }).reasoning_content).toBe('I should read the file first.')
  })

  it('WebSearch sub-request: the web_search server tool is dropped (no tools, no tool_choice)', () => {
    const { payload, droppedTools } = translate(webSearchSubRequest)
    expect(droppedTools).toEqual(['web_search'])
    expect(payload.tools).toBeUndefined()
    expect(payload.tool_choice).toBeUndefined()
    expect(payload.messages[0]).toEqual({
      role: 'system',
      content:
        "You are a Claude agent, built on Anthropic's Claude Agent SDK.\n\nYou run a web search for another Claude model, which is waiting on the result and can search again. Search once, then reply with a brief summary of the results."
    })
    expect(payload.messages[1]).toEqual({ role: 'user', content: 'Perform a web search for the query: anthropic messages api streaming' })
  })
})

describe('request translation — content mapping', () => {
  const base = { model: 'x', max_tokens: 1000 }

  it('tool results: errors, empty results, images moved to a following user message, tool_reference', () => {
    const { payload } = translate({
      ...base,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Shot', input: {} },
            { type: 'tool_use', id: 't2', name: 'Empty', input: {} },
            { type: 'tool_use', id: 't3', name: 'ToolSearch', input: { q: 'x' } }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'after the tools' },
            {
              type: 'tool_result',
              tool_use_id: 't1',
              is_error: true,
              content: [
                { type: 'text', text: 'partial failure' },
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }
              ]
            },
            { type: 'tool_result', tool_use_id: 't2', content: [] },
            { type: 'tool_result', tool_use_id: 't3', content: [{ type: 'tool_reference', tool_name: 'WebFetch' }] }
          ]
        }
      ]
    })
    expect(payload.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'tool', 'user'])
    expect(payload.messages[2]).toEqual({ role: 'tool', tool_call_id: 't1', content: '[tool error] partial failure' })
    expect(payload.messages[3]).toEqual({ role: 'tool', tool_call_id: 't2', content: '(no output)' })
    expect(payload.messages[4]).toEqual({ role: 'tool', tool_call_id: 't3', content: '[tool loaded: WebFetch]' })
    expect(payload.messages[5]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Images returned by the tool calls above:' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
        { type: 'text', text: 'after the tools' }
      ]
    })
  })

  it('images and documents in user messages', () => {
    const blocks = [
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'document', title: 'notes', source: { type: 'text', media_type: 'text/plain', data: 'hello doc' } },
      { type: 'document', title: 'spec.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' } }
    ]
    const generic = translate({ ...base, messages: [{ role: 'user', content: blocks }] }).payload.messages[0]
    expect(generic.content).toEqual([
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      { type: 'text', text: 'notes\n\nhello doc' },
      { type: 'text', text: '[document "spec.pdf" omitted: this model\'s provider does not accept PDF or file attachments]' }
    ])
    const openai = translate({ ...base, messages: [{ role: 'user', content: blocks }] }, { baseUrl: 'https://api.openai.com/v1' }, 'gpt-4.1').payload.messages[0]
    expect((openai.content as unknown[])[2]).toEqual({ type: 'file', file: { filename: 'spec.pdf', file_data: 'data:application/pdf;base64,JVBERi0x' } })
  })

  it('merges consecutive user turns and skips empty assistant turns', () => {
    const { payload } = translate({
      ...base,
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'zzz' }] },
        { role: 'user', content: [{ type: 'text', text: 'two' }] }
      ]
    })
    expect(payload.messages).toEqual([{ role: 'user', content: 'one\n\ntwo' }])
  })

  it('defers a system message that arrives while tool results are pending', () => {
    const { payload } = translate({
      ...base,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] },
        { role: 'system', content: 'remember this' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] }
      ]
    })
    expect(payload.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(payload.messages[3].content).toBe('<system-reminder>\nremember this\n</system-reminder>')
  })

  it('long tool names are shortened to 64 chars and mapped consistently', () => {
    const long = `mcp__${'very-long-server-name'.repeat(3)}__${'do_something_useful'.repeat(3)}`
    const { payload, names } = translate({
      ...base,
      tools: [{ name: long, description: 'd', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'tool', name: long },
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: long, input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'done' }] }
      ]
    })
    const short = payload.tools?.[0].function.name as string
    expect(short.length).toBe(64)
    expect(short).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(payload.tool_choice).toEqual({ type: 'function', function: { name: short } })
    expect((payload.messages[1] as { tool_calls: Array<{ function: { name: string } }> }).tool_calls[0].function.name).toBe(short)
    expect(names.restore(short)).toBe(long)
  })

  it('tool_choice, sampling, stop sequences and max-token field per upstream', () => {
    const tools = [{ name: 'A', input_schema: { type: 'object' } }]
    const msgs = [{ role: 'user', content: 'hi' }]
    expect(translate({ ...base, tools, messages: msgs, tool_choice: { type: 'any' } }).payload.tool_choice).toBe('required')
    expect(translate({ ...base, tools, messages: msgs, tool_choice: { type: 'auto' } }).payload.tool_choice).toBe('auto')
    expect(translate({ ...base, tools, messages: msgs, tool_choice: { type: 'none' } }).payload.tool_choice).toBe('none')
    expect(translate({ ...base, tools, messages: msgs, tool_choice: { type: 'tool', name: 'missing' } }).payload.tool_choice).toBeUndefined()

    const parallel = { ...base, tools, messages: msgs, tool_choice: { type: 'auto', disable_parallel_tool_use: true } }
    expect(translate(parallel).payload.parallel_tool_calls).toBe(false)
    expect(translate(parallel, { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' }).payload.parallel_tool_calls).toBeUndefined()

    const sampled = { ...base, messages: msgs, temperature: 0.3, top_p: 0.9, stop_sequences: ['a', 'b', 'c', 'd', 'e'] }
    const p = translate(sampled).payload
    expect([p.temperature, p.top_p, p.stop]).toEqual([0.3, 0.9, ['a', 'b', 'c', 'd']])
    expect(p.max_tokens).toBe(1000)
    expect(p.max_completion_tokens).toBeUndefined()

    const openaiReasoning = translate(sampled, { baseUrl: 'https://api.openai.com/v1', maxOutputTokens: undefined }, 'gpt-5.1').payload
    expect(openaiReasoning.temperature).toBeUndefined()
    expect(openaiReasoning.top_p).toBeUndefined()
    expect(openaiReasoning.stop).toBeUndefined()
    expect(openaiReasoning.max_completion_tokens).toBe(1000)
    expect(openaiReasoning.max_tokens).toBeUndefined()

    const flagged = translate(sampled, { useMaxCompletionTokens: true }).payload
    expect(flagged.max_completion_tokens).toBe(1000)
    expect(flagged.temperature).toBe(0.3)
  })

  it('reasoning effort: output_config.effort, thinking budgets, clamping, disabled thinking', () => {
    const msgs = [{ role: 'user', content: 'hi' }]
    const effort = (body: Record<string, unknown>) => translate({ ...base, messages: msgs, ...body }, { reasoning: 'effort' }).payload.reasoning_effort
    expect(effort({ output_config: { effort: 'low' } })).toBe('low')
    expect(effort({ output_config: { effort: 'xhigh' } })).toBe('high')
    expect(effort({ output_config: { effort: 'max' } })).toBe('high')
    expect(effort({ thinking: { type: 'enabled', budget_tokens: 2000 } })).toBe('low')
    expect(effort({ thinking: { type: 'enabled', budget_tokens: 8000 } })).toBe('medium')
    expect(effort({ thinking: { type: 'enabled', budget_tokens: 32000 } })).toBe('high')
    expect(effort({ thinking: { type: 'adaptive' } })).toBeUndefined()
    expect(effort({ thinking: { type: 'disabled' }, output_config: { effort: 'high' } })).toBeUndefined()
  })

  it('honours the proposed maxEffort and extraBody upstream fields (extraBody cannot override routing)', () => {
    const msgs = [{ role: 'user', content: 'hi' }]
    const extras = { reasoning: 'effort', maxEffort: 'xhigh', extraBody: { provider: { only: ['moonshotai'] }, model: 'evil', stream: false } }
    const p = translate({ ...base, stream: true, messages: msgs, output_config: { effort: 'max' } }, extras as Partial<ProxyUpstream>).payload
    expect(p.reasoning_effort).toBe('xhigh')
    expect((p as unknown as Record<string, unknown>).provider).toEqual({ only: ['moonshotai'] })
    expect(p.model).toBe('mock-kimi')
    expect(p.stream).toBe(true)
  })

  it('JSON output format, OpenAI prompt cache key, streamOptions flag', () => {
    const body = {
      ...base,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { user_id: JSON.stringify({ device_id: 'd', session_id: 'session-1' }) },
      output_config: { format: { type: 'json_schema', schema: { $schema: 'x', type: 'object', properties: { a: { type: 'string' } } } } }
    }
    const generic = translate(body).payload
    expect(generic.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema: { type: 'object', properties: { a: { type: 'string' } } }, strict: false }
    })
    expect(generic.prompt_cache_key).toBeUndefined()
    const openai = translate(body, { baseUrl: 'https://api.openai.com/v1' }, 'gpt-4.1').payload
    expect(openai.prompt_cache_key).toMatch(/^cs-[0-9a-f]{40}$/)
    expect(translate(body, { baseUrl: 'https://api.openai.com/v1' }, 'gpt-4.1').payload.prompt_cache_key).toBe(openai.prompt_cache_key)
    expect(translate(body, { streamOptions: false }).payload.stream_options).toBeUndefined()
  })

  it('parseAnthropicRequest rejects bodies without messages', () => {
    expect(parseAnthropicRequest(null)).toEqual({ ok: false, message: 'The request body must be a JSON object.' })
    expect(parseAnthropicRequest({ model: 'x' })).toEqual({ ok: false, message: 'messages: Field required' })
    const ok = parseAnthropicRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, 'junk', { nope: 1 }] }], max_tokens: -5 })
    expect(ok.ok && ok.request.messages[0].content).toEqual([{ type: 'text', text: 'a' }])
    expect(ok.ok && ok.request.max_tokens).toBeUndefined()
  })
})

describe('repairToolSequence', () => {
  it('adds placeholders for unanswered tool calls and turns orphan results into user text', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'A', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'B', arguments: '{}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'a', content: 'A ok' },
      { role: 'tool', tool_call_id: 'zzz', content: 'stray' },
      { role: 'user', content: 'next' }
    ]
    const repaired = repairToolSequence(messages)
    expect(repaired.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
    expect(repaired[3]).toEqual({ role: 'tool', tool_call_id: 'b', content: '(no result: the tool call was interrupted)' })
    expect(repaired[4]).toEqual({ role: 'user', content: '[Result of an earlier tool call (zzz)]\nstray\n\nnext' })
  })

  it('keeps a valid sequence unchanged', () => {
    const payload: OpenAIRequest = translate(toolResultsWithBilling).payload
    expect(repairToolSequence(payload.messages)).toEqual(payload.messages)
  })
})
