/**
 * Smithery (registry.smithery.ai): ~20k servers, mostly hosted remotes plus MCPB bundles.
 * The list is capped at 500 results unless a fixed `seed` is passed (research §4). List items carry
 * no install details; get() enriches them lazily from the detail endpoint (connections + configSchema).
 */
import type { ArgSpec, InstallOption } from '@shared/types'
import { mapLimit } from '../fetcher'
import { mcpbOption, remoteOption } from '../install'
import { parseRepoUrl, remoteKey, repoBaseKey, repoKey } from '../keys'
import { makeServer, sourceScopedId } from '../normalize'
import type { HeaderSpec, SourceEntry } from '../types'
import { asArray, asRecord, asString, isHttpUrl, isImageUrl, plainDescription, prettifyName, toCount, toIsoDate } from '../util'
import type { SourceAdapter, SourceRunContext, SourceRunResult } from './source'

export const SMITHERY_API = 'https://registry.smithery.ai'
/** Fixed seed → stable deep pagination over the whole catalog. */
export const SMITHERY_SEED = 42
const PAGE_SIZE = 100

const HOSTED_NOTE = 'Hosted by Smithery — sign in with your Smithery account when Claude asks.'
const BUNDLE_NOTE = 'Smithery bundle for Claude Desktop (.mcpb). Smithery publishes no checksum for it.'

/** Hosted endpoint used before the detail endpoint has been consulted. */
export function smitheryHostedUrl(qualifiedName: string): string {
  return `https://server.smithery.ai/${qualifiedName}`
}

/** Bundle download endpoint (bundleUrl values in details are sometimes stale). */
export function smitheryBundleUrl(qualifiedName: string): string {
  return `https://api.smithery.ai/servers/${encodeURIComponent(qualifiedName)}/download`
}

function listInstall(qn: string, remote: unknown): InstallOption[] {
  if (remote === true) return [remoteOption({ url: smitheryHostedUrl(qn), notes: HOSTED_NOTE })]
  if (remote === false) {
    return [mcpbOption({ url: smitheryBundleUrl(qn), notes: BUNDLE_NOTE })]
  }
  return []
}

/** Parse one list item. Returns undefined for hidden / uninstallable entries (remote: null). */
export function parseSmitheryItem(raw: unknown): SourceEntry | undefined {
  const it = asRecord(raw)
  const qn = asString(it?.qualifiedName)
  if (!it || !qn) return undefined
  if (it.unlisted === true || it.inactive === true) return undefined
  if (it.remote !== true && it.remote !== false) return undefined
  const displayName = asString(it.displayName)
  const homepage = asString(it.homepage)
  const keys: string[] = [`remote:server.smithery.ai/@${qn.toLowerCase()}/mcp`, `remote:server.smithery.ai/${qn.toLowerCase()}`]
  const softKeys: string[] = []
  const homeRepo = parseRepoUrl(homepage)
  if (homeRepo) softKeys.push(repoKey(homeRepo), repoBaseKey(homeRepo))
  else if (isHttpUrl(homepage) && !/smithery\.ai/i.test(homepage)) {
    const k = remoteKey(homepage)
    if (k) softKeys.push(k.replace(/^remote:/, 'home:'))
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(qn)) softKeys.push(`repo:github.com/${qn.toLowerCase()}`)
  const useCount = toCount(it.useCount)
  const icon = asString(it.iconUrl)
  return {
    source: 'smithery',
    sourceId: qn,
    ref: qn,
    keys,
    softKeys,
    nameExplicit: !!displayName || undefined,
    metrics: useCount ? { useCount } : undefined,
    server: makeServer('smithery', {
      id: sourceScopedId('smithery', qn),
      name: displayName ?? prettifyName(qn),
      description: plainDescription(it.description, 400),
      publisher: asString(it.namespace),
      homepage: isHttpUrl(homepage) ? homepage : `https://smithery.ai/servers/${qn}`,
      iconUrl: isImageUrl(icon) ? icon : undefined,
      verified: it.verified === true,
      updatedAt: toIsoDate(it.createdAt),
      install: listInstall(qn, it.remote)
    })
  }
}

/** Parse a list page. */
export function parseSmitheryPage(raw: unknown): { entries: SourceEntry[]; items: number; totalPages?: number; totalCount?: number } {
  const page = asRecord(raw)
  const items = asArray(page?.servers)
  const pg = asRecord(page?.pagination)
  return {
    entries: items.map(parseSmitheryItem).filter((e): e is SourceEntry => !!e),
    items: items.length,
    totalPages: toCount(pg?.totalPages),
    totalCount: toCount(pg?.totalCount)
  }
}

function looksSecret(name: string, title?: string): boolean {
  return /key|token|secret|password|passwd|credential|auth|bearer|cookie/i.test(`${name} ${title ?? ''}`)
}

/** Details of a Smithery server, as install options. */
export interface SmitheryDetail {
  options: InstallOption[]
  /** False when the server publishes no connection at all (cannot be installed). */
  installable: boolean
}

/** Parse GET /servers/{qualifiedName}. */
export function parseSmitheryDetail(raw: unknown): SmitheryDetail {
  const d = asRecord(raw)
  if (!d) return { options: [], installable: false }
  const qn = asString(d.qualifiedName) ?? ''
  const options: InstallOption[] = []
  for (const c of asArray(d.connections)) {
    const conn = asRecord(c)
    if (!conn) continue
    const schema = asRecord(conn.configSchema) ?? {}
    const props = Object.entries(asRecord(schema.properties) ?? {})
      .map(([name, v]) => ({ name, p: asRecord(v) ?? {} }))
      .sort((a, b) => (toCount(a.p['x-order']) ?? 999) - (toCount(b.p['x-order']) ?? 999))
    const required = new Set(asArray(schema.required).filter((r): r is string => typeof r === 'string'))
    const type = asString(conn.type)
    if (type === 'http') {
      const base = asString(conn.deploymentUrl) ?? asString(d.deploymentUrl) ?? (qn ? smitheryHostedUrl(qn) : undefined)
      if (!base || !isHttpUrl(base)) continue
      const headers: HeaderSpec[] = []
      const argsSpec: ArgSpec[] = []
      const query: string[] = []
      let optionalSkipped = 0
      for (const { name, p } of props) {
        const from = asRecord(p['x-from'])
        const title = asString(p.title)
        const description = [title, plainDescription(p.description, 300)].filter(Boolean).join(' — ') || undefined
        const def = p.default !== undefined && typeof p.default !== 'object' ? String(p.default) : undefined
        const headerName = asString(from?.header) ?? (!from && looksSecret(name, title) ? name : undefined)
        if (headerName) {
          headers.push({ name: headerName, description, required: required.has(name), secret: looksSecret(name, title), default: def })
          continue
        }
        if (!required.has(name)) {
          optionalSkipped++
          continue
        }
        const param = asString(from?.query) ?? name
        const format = p.type === 'number' || p.type === 'integer' ? 'number' : undefined
        argsSpec.push({ name: param, description, required: true, default: def, format })
        query.push(`${encodeURIComponent(param)}={{arg:${param}}}`)
      }
      const url = query.length ? `${base}${base.includes('?') ? '&' : '?'}${query.join('&')}` : base
      const skipped = optionalSkipped ? `${optionalSkipped} optional setting(s) can be changed on smithery.ai.` : ''
      const notes = [HOSTED_NOTE, skipped].filter(Boolean).join(' ')
      options.push(remoteOption({ url, headers, argsSpec, notes }))
    } else if (type === 'stdio' && qn) {
      const settings = props.map(({ name }) => name)
      options.push(
        mcpbOption({
          url: smitheryBundleUrl(qn),
          notes: [
            `Smithery bundle for Claude Desktop (.mcpb, ${asString(conn.runtime) ?? 'local'} runtime). Smithery publishes no checksum for it.`,
            settings.length ? `Settings asked by the bundle: ${settings.join(', ')}.` : ''
          ]
            .filter(Boolean)
            .join(' ')
        })
      )
    }
  }
  return { options, installable: options.length > 0 }
}

async function run(rc: SourceRunContext): Promise<SourceRunResult> {
  const key = await rc.secret(rc.settings.smitheryKeyRef)
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {}
  const sink = rc.begin('replace')
  const pageUrl = (page: number) => `${SMITHERY_API}/servers?pageSize=${PAGE_SIZE}&page=${page}&seed=${SMITHERY_SEED}`
  const first = parseSmitheryPage(await rc.http.json(pageUrl(1), headers))
  await sink.put(first.entries)
  let count = first.entries.length
  const totalPages = Math.min(first.totalPages ?? 1, 2000)
  rc.progress(count, `Smithery: page 1 of ${totalPages}…`)
  const pages = Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) => i + 2)
  let done = 1
  await mapLimit(pages, 4, async (page) => {
    const parsed = parseSmitheryPage(await rc.http.json(pageUrl(page), headers))
    await sink.put(parsed.entries)
    count += parsed.entries.length
    done++
    if (done % 5 === 0 || done === totalPages) rc.progress(count, `Smithery: page ${done} of ${totalPages}…`)
  })
  if (!count) throw new Error('Smithery returned no servers.')
  return { message: `${count.toLocaleString('en-US')} servers` }
}

export const smitherySource: SourceAdapter = {
  id: 'smithery',
  label: 'Smithery',
  heavy: true,
  minTtlHours: 24 * 7,
  http: { concurrency: 4, minIntervalMs: 250, timeoutMs: 60_000 },
  available: async () => true,
  run
}

/** Fetch + parse the detail of one server (used by get()). */
export async function fetchSmitheryDetail(
  qualifiedName: string,
  fetchJson: (url: string, headers?: Record<string, string>) => Promise<unknown>,
  apiKey?: string | null
): Promise<SmitheryDetail> {
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {}
  return parseSmitheryDetail(await fetchJson(`${SMITHERY_API}/servers/${encodeURIComponent(qualifiedName)}`, headers))
}
