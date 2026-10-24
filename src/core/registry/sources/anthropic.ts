/**
 * Anthropic MCP sub-registry = the Claude Connectors Directory (curated remote servers).
 * Needs the undocumented `visibility=commercial` parameter (research §2). Entries whose remote URL is
 * the placeholder "{url}" carry `urlOptions` (pick a region) or `requiredFields` (user's own URL).
 */
import type { InstallOption } from '@shared/types'
import { remoteOption, sortOptions } from '../install'
import { remoteKey } from '../keys'
import { mapServerJson } from '../serverjson'
import type { SourceEntry } from '../types'
import { asArray, asRecord, asString, cleanText, isHttpUrl, isImageUrl, plainDescription } from '../util'
import { officialMeta, serverJsonEntry } from './common'
import { paginateCursor, type SourceAdapter, type SourceRunContext, type SourceRunResult } from './source'

export const ANTHROPIC_API = 'https://api.anthropic.com/mcp-registry/v0/servers'

function authNote(isAuthless: unknown): string | undefined {
  if (isAuthless === true) return 'No sign-in needed.'
  if (isAuthless === false) return 'Sign in with your account when Claude asks (OAuth).'
  return undefined
}

/** Install options for an Anthropic directory entry (handles urlOptions / requiredFields). */
export function anthropicInstall(
  server: Record<string, unknown>,
  meta: Record<string, unknown>
): { options: InstallOption[]; keys: string[] } {
  const remotes = asArray(server.remotes)
  const first = asRecord(remotes[0])
  const placeholderUrl = asString(first?.url) === '{url}'
  const note = authNote(meta.isAuthless)
  const transport = asString(first?.type) === 'sse' ? 'sse' : 'http'
  if (placeholderUrl) {
    const urlOptions = asArray(meta.urlOptions)
      .map((u) => asRecord(u))
      .filter((u): u is Record<string, unknown> => !!u && isHttpUrl(u.url))
    if (urlOptions.length) {
      const options = urlOptions.map((u, i) =>
        remoteOption({
          id: i === 0 ? 'remote' : `remote-${i + 1}`,
          url: u.url as string,
          transport,
          label: asString(u.label) ? `Remote (${cleanText(u.label)})` : undefined,
          notes: [asString(u.description), note].filter(Boolean).join(' ') || undefined
        })
      )
      return { options, keys: urlOptions.map((u) => remoteKey(u.url as string)).filter((k): k is string => !!k) }
    }
    const field = asArray(meta.requiredFields)
      .map((f) => asRecord(f))
      .find((f) => asString(f?.field) === 'url')
    const sourceUrl = asString(field?.sourceUrl)
    const regex = asString(meta.urlRegex)
    return {
      options: [
        remoteOption({
          url: '{{arg:url}}',
          transport,
          argsSpec: [
            {
              name: 'url',
              description: `Your personal server address${sourceUrl ? ` — see ${sourceUrl}` : ''}.`,
              required: true,
              format: 'url'
            }
          ],
          notes: [regex ? `The address must match ${regex}.` : '', note ?? ''].filter(Boolean).join(' ') || undefined
        })
      ],
      keys: []
    }
  }
  const mapped = mapServerJson(server)
  const options = mapped.options.map((o) => (o.kind === 'remote' && !o.headers?.length && note && !o.notes ? { ...o, notes: note } : o))
  return { options: sortOptions(options), keys: mapped.keys }
}

/** Parse one list item of the Anthropic registry. */
export function parseAnthropicItem(raw: unknown): SourceEntry | undefined {
  const item = asRecord(raw)
  const server = asRecord(item?.server)
  if (!item || !server || !asString(server.name)) return undefined
  const status = officialMeta(item).status
  if (status === 'deleted') return undefined
  const meta = asRecord(asRecord(item._meta)?.['com.anthropic.api/mcp-registry']) ?? {}
  const { options, keys } = anthropicInstall(server, meta)
  const author = asRecord(meta.author)
  const oneLiner = cleanText(meta.oneLiner)
  const description = plainDescription(server.description, 1200)
  const displayName = asString(meta.displayName) ?? asString(server.title)
  const homepage = [meta.documentation, author?.url, server.websiteUrl].find(isHttpUrl) as string | undefined
  const icon = asString(meta.iconUrl)
  return serverJsonEntry('anthropic', server, {
    name: displayName,
    nameExplicit: !!displayName,
    description: oneLiner || plainDescription(server.description, 300),
    longDescription: description && description !== oneLiner ? description : undefined,
    publisher: asString(author?.name),
    homepage,
    iconUrl: isImageUrl(icon) ? icon : undefined,
    sourceCategories: asArray(meta.useCases).filter((u): u is string => typeof u === 'string' && !!u),
    official: true,
    verified: true,
    updatedAt: officialMeta(item).updatedAt,
    install: options,
    extraKeys: keys
  })
}

/** Parse a list page. */
export function parseAnthropicPage(raw: unknown): { entries: SourceEntry[]; items: number; next?: string } {
  const page = asRecord(raw)
  const items = asArray(page?.servers)
  const entries = items.map(parseAnthropicItem).filter((e): e is SourceEntry => !!e)
  return { entries, items: items.length, next: asString(asRecord(page?.metadata)?.nextCursor) }
}

async function run(rc: SourceRunContext): Promise<SourceRunResult> {
  const sink = rc.begin('replace')
  let count = 0
  const pages = paginateCursor(async (cursor) => {
    const url = `${ANTHROPIC_API}?version=latest&visibility=commercial&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const page = parseAnthropicPage(await rc.http.json(url))
    return { items: page.items ? [page] : [], next: page.next }
  }, 200)
  for await (const [page] of pages) {
    await sink.put(page.entries)
    count += page.entries.length
    rc.progress(count, `Claude directory: ${count} connectors…`)
  }
  if (!count) throw new Error('The Claude connectors directory returned no servers.')
  return { message: `${count} connectors` }
}

export const anthropicSource: SourceAdapter = {
  id: 'anthropic',
  label: 'Claude connectors directory',
  heavy: false,
  http: { concurrency: 1, minIntervalMs: 200 },
  available: async () => true,
  run
}
