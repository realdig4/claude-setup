import { describe, expect, it } from 'vitest'
import { ToolNameMapper } from '@core/proxy/names'
import {
  ToolIdAllocator,
  mapStopReason,
  mapUsage,
  parseToolArguments,
  removeTrailingCommas,
  toAnthropicMessage
} from '@core/proxy/translate/response'

function message(json: unknown, opts: { names?: ToolNameMapper; reserved?: string[]; warnings?: string[] } = {}) {
  return toAnthropicMessage(json, {
    requestedModel: 'kimi-k2.5',
    names: opts.names ?? new ToolNameMapper(),
    inputEstimate: 1234,
    reservedIds: opts.reserved,
    onWarning: (w) => opts.warnings?.push(w)
  })
}

describe('non-streaming response translation', () => {
  it('maps reasoning, text and tool calls in Anthropic order, echoing the requested model', () => {
    const names = new ToolNameMapper()
    const long = `mcp__server__${'x'.repeat(80)}`
    const short = names.shorten(long)
    const out = message(
      {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              reasoning_content: 'Think first.',
              content: 'Let me check.',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } },
                { id: 'call_2', type: 'function', function: { name: short, arguments: '{"x":1,}' } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 5200, completion_tokens: 42, total_tokens: 5242, prompt_tokens_details: { cached_tokens: 4096 } }
      },
      { names }
    )
    expect(out.id).toMatch(/^msg_[0-9a-f]{32}$/)
    expect(out.type).toBe('message')
    expect(out.role).toBe('assistant')
    expect(out.model).toBe('kimi-k2.5')
    expect(out.stop_reason).toBe('tool_use')
    expect(out.stop_sequence).toBeNull()
    expect(out.content).toHaveLength(4)
    expect(out.content[0]).toMatchObject({ type: 'thinking', thinking: 'Think first.' })
    expect((out.content[0] as { signature: string }).signature).toMatch(/^proxy-/)
    expect(out.content[1]).toEqual({ type: 'text', text: 'Let me check.' })
    expect(out.content[2]).toEqual({ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.txt' } })
    expect(out.content[3]).toEqual({ type: 'tool_use', id: 'call_2', name: long, input: { x: 1 } })
    expect(out.usage).toEqual({ input_tokens: 1104, output_tokens: 42, cache_read_input_tokens: 4096, cache_creation_input_tokens: 0 })
  })

  it('tool calls with finish_reason "stop" (Gemini) still mean tool_use; plain text means end_turn', () => {
    const gemini = message({ choices: [{ message: { content: null, tool_calls: [{ id: 'fc_1', function: { name: 'Read', arguments: '{}' } }] }, finish_reason: 'stop' }] })
    expect(gemini.stop_reason).toBe('tool_use')
    const plain = message({ choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }] })
    expect(plain.stop_reason).toBe('end_turn')
    expect(plain.content).toEqual([{ type: 'text', text: 'Hi' }])
    const filtered = message({ choices: [{ message: { content: 'x' }, finish_reason: 'content_filter' }] })
    expect(filtered.stop_reason).toBe('end_turn')
  })

  it('length → max_tokens, and a cut-off tool call is dropped instead of run with partial input', () => {
    const warnings: string[] = []
    const out = message(
      {
        choices: [
          {
            message: {
              content: 'Writing',
              tool_calls: [
                { id: 'c1', function: { name: 'Glob', arguments: '{"pattern":"*.ts"}' } },
                { id: 'c2', function: { name: 'Write', arguments: '{"file_path":"a.txt","content":"half of the fi' } }
              ]
            },
            finish_reason: 'length'
          }
        ]
      },
      { warnings }
    )
    expect(out.stop_reason).toBe('max_tokens')
    expect(out.content.map((b) => b.type)).toEqual(['text', 'tool_use'])
    expect(warnings[0]).toMatch(/cut-off call to Write/)
  })

  it('reads OpenRouter "reasoning", array content, refusals and DeepSeek cache fields; estimates missing usage', () => {
    const router = message({ choices: [{ message: { reasoning: 'hmm', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, finish_reason: 'stop' }] })
    expect(router.content).toMatchObject([
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'ab' }
    ])
    expect(router.usage.input_tokens).toBe(1234)
    expect(router.usage.output_tokens).toBeGreaterThan(0)

    const refusal = message({ choices: [{ message: { content: null, refusal: 'I cannot help with that.' }, finish_reason: 'stop' }] })
    expect(refusal.content).toEqual([{ type: 'text', text: 'I cannot help with that.' }])
    expect(refusal.stop_reason).toBe('end_turn')

    expect(mapUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 60 }, 1)).toEqual({
      input_tokens: 40,
      output_tokens: 5,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 0
    })
    expect(mapUsage(null, 77, 3)).toEqual({ input_tokens: 77, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  })

  it('never reuses a tool_use id from the conversation and sanitizes unsafe ids', () => {
    const out = message(
      {
        choices: [
          {
            message: {
              tool_calls: [
                { id: 'call_old', function: { name: 'A', arguments: '{}' } },
                { id: 'call_old', function: { name: 'B', arguments: '{}' } },
                { id: 'fn:call/1', function: { name: 'C', arguments: '{}' } },
                { function: { name: 'D', arguments: '{}' } },
                { id: 'call_x', function: { arguments: '{}' } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      },
      { reserved: ['call_old'] }
    )
    const ids = out.content.map((b) => (b.type === 'tool_use' ? b.id : ''))
    expect(ids).toHaveLength(4)
    expect(ids[0]).toMatch(/^toolu_[0-9a-f]{32}$/)
    expect(ids[1]).toMatch(/^toolu_[0-9a-f]{32}$/)
    expect(ids[0]).not.toBe(ids[1])
    expect(ids[2]).toBe('fn_call_1')
    expect(ids[3]).toMatch(/^toolu_/)
  })

  it('handles empty or malformed bodies without throwing', () => {
    expect(message({}).content).toEqual([])
    expect(message('nonsense').stop_reason).toBe('end_turn')
    expect(message({ choices: [null, { message: { content: 'ok' } }] }).content).toEqual([{ type: 'text', text: 'ok' }])
  })
})

describe('parseToolArguments', () => {
  it('parses, repairs safely, and falls back to _raw_arguments', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ input: { a: 1 }, ok: true })
    expect(parseToolArguments({ a: 2 })).toEqual({ input: { a: 2 }, ok: true })
    expect(parseToolArguments('')).toEqual({ input: {}, ok: true })
    expect(parseToolArguments(undefined)).toEqual({ input: {}, ok: true })
    expect(parseToolArguments('{"a":[1,2,],}')).toEqual({ input: { a: [1, 2] }, ok: true })
    expect(parseToolArguments('```json\n{"a":1}\n```')).toEqual({ input: { a: 1 }, ok: true })
    expect(parseToolArguments(JSON.stringify(JSON.stringify({ a: 3 })))).toEqual({ input: { a: 3 }, ok: true })
    expect(parseToolArguments('{"a": "x, }"}')).toEqual({ input: { a: 'x, }' }, ok: true })
    expect(parseToolArguments('{"a": "unterminated')).toEqual({ input: { _raw_arguments: '{"a": "unterminated' }, ok: false })
    expect(parseToolArguments('[1,2]')).toEqual({ input: { _raw_arguments: '[1,2]' }, ok: false })
  })

  it('removeTrailingCommas leaves string contents alone', () => {
    expect(removeTrailingCommas('{"a":"1, ]","b":[1,],}')).toBe('{"a":"1, ]","b":[1]}')
    expect(removeTrailingCommas('{"q":"say \\"hi\\", }"}')).toBe('{"q":"say \\"hi\\", }"}')
  })
})

describe('stop reason and ids', () => {
  it('mapStopReason', () => {
    expect(mapStopReason('tool_calls', true)).toBe('tool_use')
    expect(mapStopReason('stop', true)).toBe('tool_use')
    expect(mapStopReason('length', true)).toBe('max_tokens')
    expect(mapStopReason('length', false)).toBe('max_tokens')
    expect(mapStopReason(null, false)).toBe('end_turn')
    expect(mapStopReason('tool_calls', false)).toBe('end_turn')
  })

  it('ToolIdAllocator', () => {
    const ids = new ToolIdAllocator(['a'])
    expect(ids.take('b')).toBe('b')
    expect(ids.take('b')).not.toBe('b')
    expect(ids.take('a')).not.toBe('a')
    expect(ids.take('  ')).toMatch(/^toolu_/)
  })
})
