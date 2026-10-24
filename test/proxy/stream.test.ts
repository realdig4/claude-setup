import { describe, expect, it } from 'vitest'
import { ToolNameMapper } from '@core/proxy/names'
import { SseParser, formatSse, type UpstreamSseItem } from '@core/proxy/sse'
import { StreamTranslator, UpstreamStreamError, messageToEvents } from '@core/proxy/translate/stream'
import type { SseEvent } from '@core/proxy/wire'

const base = { id: 'chatcmpl-mock001', object: 'chat.completion.chunk', created: 1761200000, model: 'mock-kimi' }
const usage = { prompt_tokens: 5200, completion_tokens: 42, total_tokens: 5242, prompt_tokens_details: { cached_tokens: 4096 } }

function sse(chunks: unknown[], opts: { crlf?: boolean; done?: boolean; comment?: boolean } = {}): string {
  const nl = opts.crlf ? '\r\n' : '\n'
  let text = opts.comment ? `: keep-alive comment line${nl}${nl}` : ''
  for (const c of chunks) text += `data: ${JSON.stringify(c)}${nl}${nl}`
  if (opts.done !== false) text += `data: [DONE]${nl}${nl}`
  return text
}

/** The verified mock-openai.mjs turn-1 stream: reasoning, text, two fragmented parallel tool calls, usage chunk. */
function referenceStream(readTarget = 'C:\\proj\\hello.txt'): unknown[] {
  const args0 = JSON.stringify({ file_path: readTarget })
  const send = (choices: unknown[], extra: Record<string, unknown> = {}) => ({ ...base, choices, ...extra })
  return [
    send([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
    send([{ index: 0, delta: { reasoning_content: 'User wants the file. ' }, finish_reason: null }]),
    send([{ index: 0, delta: { reasoning_content: 'I will call Read and Glob.' }, finish_reason: null }]),
    send([{ index: 0, delta: { content: 'Let me check' }, finish_reason: null }]),
    send([{ index: 0, delta: { content: ' the files.' }, finish_reason: null }]),
    send([{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc123', type: 'function', function: { name: 'Read', arguments: '' } }] }, finish_reason: null }]),
    send([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args0.slice(0, 7) } }] }, finish_reason: null }]),
    send([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args0.slice(7) } }] }, finish_reason: null }]),
    send([{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_def456', type: 'function', function: { name: 'Glob', arguments: '{"pattern":' } }] }, finish_reason: null }]),
    send([{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: ' "*.txt"}' } }] }, finish_reason: null }]),
    send([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
    send([], { usage })
  ]
}

function parseAll(text: string, pieceSize: number): UpstreamSseItem[] {
  const parser = new SseParser()
  const bytes = Buffer.from(text, 'utf8')
  const items: UpstreamSseItem[] = []
  for (let i = 0; i < bytes.length; i += pieceSize) items.push(...parser.push(bytes.subarray(i, i + pieceSize)))
  items.push(...parser.end())
  return items
}

function run(text: string, pieceSize = 5, names = new ToolNameMapper()): { events: SseEvent[]; translator: StreamTranslator } {
  const translator = new StreamTranslator({ model: 'kimi-k2.5', names, inputEstimate: 84 })
  const events: SseEvent[] = [...translator.start()]
  let sawDone = false
  for (const item of parseAll(text, pieceSize)) {
    if (item.kind === 'done') {
      sawDone = true
      break
    }
    if (item.kind === 'json') events.push(...translator.push(item.value, item.event))
  }
  events.push(...translator.finish(sawDone))
  return { events, translator }
}

describe('SseParser', () => {
  it('yields the same items for every way of splitting the byte stream (CRLF, comments, UTF-8)', () => {
    const chunks = [
      { choices: [{ index: 0, delta: { content: 'héllo — 你好 👋' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ]
    const text = sse(chunks, { crlf: true, comment: true })
    const expected = parseAll(text, text.length)
    expect(expected).toEqual([{ kind: 'json', event: undefined, value: chunks[0] }, { kind: 'json', event: undefined, value: chunks[1] }, { kind: 'done' }])
    for (let size = 1; size <= 12; size++) expect(parseAll(text, size)).toEqual(expected)
  })

  it('handles missing blank lines, multi-line data, event names, bare CR line endings and a final unterminated line', () => {
    const items = parseAll(
      'data: {"a":1}\ndata: {"a":2}\n' +
        'data: {"multi":\ndata: "line"}\n\n' +
        'event: error\ndata: {"message":"boom"}\n\n' +
        'data: {"cr":true}\r\r' +
        'id: 7\nretry: 100\n' +
        'data: not json\n\n' +
        'data: {"last":true}',
      3
    )
    expect(items).toEqual([
      { kind: 'json', event: undefined, value: { a: 1 } },
      { kind: 'json', event: undefined, value: { a: 2 } },
      { kind: 'json', event: undefined, value: { multi: 'line' } },
      { kind: 'json', event: 'error', value: { message: 'boom' } },
      { kind: 'json', event: undefined, value: { cr: true } },
      { kind: 'invalid', event: undefined, data: 'not json' },
      { kind: 'json', event: undefined, value: { last: true } }
    ])
  })

  it('stops on an oversized event instead of buffering without limit', () => {
    const parser = new SseParser()
    const big = 'x'.repeat(1024 * 1024)
    expect(() => {
      for (let i = 0; i < 17; i++) parser.push(i === 0 ? `data: ${big}` : big)
    }).toThrow(/larger than 16 MB/)
  })

  it('formatSse writes one Anthropic event', () => {
    expect(formatSse({ event: 'ping', data: { type: 'ping' } })).toBe('event: ping\ndata: {"type":"ping"}\n\n')
  })
})

describe('StreamTranslator', () => {
  it('reproduces the verified event sequence for reasoning + text + fragmented parallel tool calls + usage', () => {
    const { events, translator } = run(sse(referenceStream(), { comment: true }), 7)
    expect(events.map((e) => `${e.event}${e.data.delta ? `:${(e.data.delta as { type?: string }).type ?? ''}` : ''}`)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta:thinking_delta',
      'content_block_delta:thinking_delta',
      'content_block_delta:signature_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta:text_delta',
      'content_block_delta:text_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta:input_json_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta:input_json_delta',
      'content_block_stop',
      'message_delta:',
      'message_stop'
    ])
    const start = events[0].data.message as Record<string, unknown>
    expect(start).toMatchObject({ type: 'message', role: 'assistant', content: [], model: 'kimi-k2.5', stop_reason: null })
    expect(start.usage).toEqual({ input_tokens: 84, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    expect(events[1].data).toEqual({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
    expect(events[2].data).toEqual({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'User wants the file. ' } })
    expect((events[4].data.delta as { signature: string }).signature).toMatch(/^proxy-/)
    expect(events[6].data).toEqual({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
    expect(events[10].data).toEqual({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_abc123', name: 'Read', input: {} } })
    expect(events[11].data).toEqual({
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: 'C:\\proj\\hello.txt' }) }
    })
    expect(events[13].data).toMatchObject({ index: 3, content_block: { type: 'tool_use', id: 'call_def456', name: 'Glob' } })
    expect(events[14].data).toMatchObject({ delta: { partial_json: '{"pattern":"*.txt"}' } })
    expect(events[16].data).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { input_tokens: 1104, output_tokens: 42, cache_read_input_tokens: 4096, cache_creation_input_tokens: 0 }
    })
    const msg = translator.toMessage()
    expect(msg.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use', 'tool_use'])
    expect(msg.content[1]).toEqual({ type: 'text', text: 'Let me check the files.' })
    expect(msg.content[0]).toMatchObject({ type: 'thinking', thinking: 'User wants the file. I will call Read and Glob.' })
  })

  it('Gemini quirks: index 0 reused with new ids, one-chunk args with a trailing comma, finish "stop", no [DONE]', () => {
    const g = { id: 'g1', object: 'chat.completion.chunk', created: 1, model: 'gemini-x' }
    const chunks = [
      { ...g, choices: [{ index: 0, delta: { role: 'assistant', content: 'Two calls:' } }] },
      { ...g, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'fc_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }] } }] },
      { ...g, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'fc_2', type: 'function', function: { name: 'Read', arguments: '{"file_path":"b.txt",}' } }] } }] },
      { ...g, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 30, total_tokens: 930 } }
    ]
    const { events } = run(sse(chunks, { done: false }), 11)
    const tools = events.filter((e) => e.event === 'content_block_start' && (e.data.content_block as { type: string }).type === 'tool_use')
    expect(tools.map((e) => (e.data.content_block as { id: string }).id)).toEqual(['fc_1', 'fc_2'])
    const deltas = events.filter((e) => (e.data.delta as { type?: string } | undefined)?.type === 'input_json_delta')
    expect(deltas.map((e) => (e.data.delta as { partial_json: string }).partial_json)).toEqual(['{"file_path":"a.txt"}', '{"file_path":"b.txt"}'])
    const delta = events.find((e) => e.event === 'message_delta')?.data
    expect(delta).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { input_tokens: 900, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    })
  })

  it('tool calls without index (id-keyed), object arguments, reversed names; Groq and choice-level usage', () => {
    const names = new ToolNameMapper()
    const short = names.shorten(`mcp__a__${'y'.repeat(90)}`)
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ id: 'x1', function: { name: short, arguments: { q: 1 } } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 'x2', function: { name: 'Glob' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 'x2', function: { arguments: '{"pattern":"*"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], x_groq: { usage: { prompt_tokens: 10, completion_tokens: 2 } } }
    ]
    const { translator } = run(sse(chunks), 9, names)
    const msg = translator.toMessage()
    expect(msg.content).toEqual([
      { type: 'tool_use', id: 'x1', name: `mcp__a__${'y'.repeat(90)}`, input: { q: 1 } },
      { type: 'tool_use', id: 'x2', name: 'Glob', input: { pattern: '*' } }
    ])
    expect(msg.usage.input_tokens).toBe(10)

    const moonshot = run(sse([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop', usage: { prompt_tokens: 7, completion_tokens: 1 } }] }]))
    expect(moonshot.translator.toMessage().usage).toMatchObject({ input_tokens: 7, output_tokens: 1 })
  })

  it('switches between thinking and text blocks as deltas interleave', () => {
    const chunks = [
      { choices: [{ delta: { reasoning: 'a' } }] },
      { choices: [{ delta: { content: 'b' } }] },
      { choices: [{ delta: { reasoning_content: 'c', reasoning: 'c' } }] },
      { choices: [{ delta: { content: 'd' }, finish_reason: 'stop' }] }
    ]
    const { translator, events } = run(sse(chunks))
    expect(translator.toMessage().content.map((b) => b.type)).toEqual(['thinking', 'text', 'thinking', 'text'])
    expect(events.filter((e) => (e.data.delta as { type?: string } | undefined)?.type === 'signature_delta')).toHaveLength(2)
    expect(translator.toMessage().content[2]).toMatchObject({ thinking: 'c' })
  })

  it('[DONE] without finish_reason ends normally; a stream that just stops is an error', () => {
    const ok = run(sse([{ choices: [{ delta: { content: 'x' } }] }]))
    expect(ok.events.at(-2)?.data).toMatchObject({ delta: { stop_reason: 'end_turn' } })

    const translator = new StreamTranslator({ model: 'm', names: new ToolNameMapper(), inputEstimate: 1 })
    translator.start()
    translator.push({ choices: [{ delta: { content: 'partial' } }] })
    expect(() => translator.finish(false)).toThrow(UpstreamStreamError)
    expect(translator.error('connection lost')).toEqual([
      { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'connection lost' } } }
    ])
  })

  it('error chunks and `event: error` raise UpstreamStreamError with the provider message', () => {
    const t = new StreamTranslator({ model: 'm', names: new ToolNameMapper(), inputEstimate: 1 })
    expect(() => t.push({ error: { message: 'Rate limit hit', code: 429 } })).toThrow('Rate limit hit')
    expect(() => t.push({ message: 'upstream died' }, 'error')).toThrow('upstream died')
    expect(() => t.push({ error: 'plain' })).toThrow('plain')
    expect(t.push('junk')).toEqual([])
  })

  it('length with a truncated tool call: max_tokens and the cut-off call is dropped', () => {
    const warnings: string[] = []
    const t = new StreamTranslator({ model: 'm', names: new ToolNameMapper(), inputEstimate: 1, onWarning: (w) => warnings.push(w) })
    t.start()
    t.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'Write', arguments: '{"content":"abc' } }] }, finish_reason: 'length' }] })
    const end = t.finish(true)
    expect(end.map((e) => e.event)).toEqual(['message_delta', 'message_stop'])
    expect(end[0].data).toMatchObject({ delta: { stop_reason: 'max_tokens' } })
    expect(warnings).toHaveLength(1)
  })
})

describe('messageToEvents', () => {
  it('replays a complete message as a valid SSE sequence', () => {
    const events = messageToEvents({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: [
        { type: 'thinking', thinking: 't', signature: 'sig' },
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 'tu', name: 'Read', input: { a: 1 } }
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    })
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    expect(events[9].data).toEqual({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } })
    expect(events[11].data).toMatchObject({ delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 5, output_tokens: 6 } })
  })
})
