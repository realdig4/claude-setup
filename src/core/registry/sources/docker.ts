/**
 * Docker MCP Catalog (catalog.yaml v3): curated images pinned by digest, plus hosted remotes.
 * Catalog templates ({{server.prop}}, $SECRET) are translated into the registry placeholder
 * conventions (see install.ts). Entries whose templates need Docker's MCP gateway (filters such as
 * `|volume|into`) get a "manual" option pointing at Docker Desktop's MCP Toolkit instead.
 */
import { parse as parseYaml } from 'yaml'
import type { ArgSpec, EnvVarSpec, InstallOption } from '@shared/types'
import { argPlaceholder, dockerOption, envPlaceholder, manualOption, remoteOption } from '../install'
import { packageKey, parseRepoUrl, remoteKey, repoBaseKey, repoKey, repoUrl, softRemoteKey } from '../keys'
import { ARCHIVED_NOTE, isArchivedReference, makeServer, sourceScopedId } from '../normalize'
import type { HeaderSpec, SourceEntry } from '../types'
import { asArray, asRecord, asString, cleanText, isHttpUrl, plainDescription, toCount, uniq } from '../util'
import { withLicense } from './github'
import type { SourceAdapter, SourceRunContext, SourceRunResult } from './source'

export const DOCKER_CATALOG_URL = 'https://desktop.docker.com/mcp/catalog/v3/catalog.yaml'

const TEMPLATE_RE = /\{\{\s*([^}|]+?)\s*(\|[^}]*)?\}\}/g
const HAS_TEMPLATE = /\{\{[^}]*\}\}/
const VAR_RE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g

class Unsupported extends Error {}

interface ConfigProp {
  description?: string
  required: boolean
  default?: string
  type?: string
}

/** Look up "server.a.b" in the entry's JSON-schema `config` blocks. */
function lookupConfig(config: unknown[], path: string): ConfigProp {
  const segs = path.split('.')
  const block = config.map((c) => asRecord(c)).find((c) => c && asString(c.name) === segs[0])
  let node: Record<string, unknown> | undefined = block
  let required = true
  for (const seg of segs.slice(1)) {
    if (!node) break
    const req = asArray(node.required)
    required &&= req.includes(seg)
    node = asRecord(asRecord(node.properties)?.[seg])
  }
  if (!node) return { required: true }
  const def = node.default
  return {
    description: asString(node.description) ?? asString(node.title),
    required,
    default: typeof def === 'string' || typeof def === 'number' || typeof def === 'boolean' ? String(def) : undefined,
    type: asString(node.type)
  }
}

class DockerSpecs {
  readonly env: EnvVarSpec[] = []
  readonly args: ArgSpec[] = []
  constructor(
    readonly config: unknown[],
    readonly envNames: Set<string>
  ) {}

  /** Replace {{server.prop}} templates in a value with arg placeholders (throws Unsupported for filters). */
  templ(value: string, format?: ArgSpec['format']): string {
    return value.replace(TEMPLATE_RE, (_w, path: string, filters?: string) => {
      if (filters) throw new Unsupported(path)
      const prop = lookupConfig(this.config, path.trim())
      let name = path.trim().split('.').pop() || 'value'
      const clash = this.args.find((a) => a.name === name)
      if (clash && clash.description !== prop.description) name = path.trim().split('.').slice(1).join('_') || name
      if (!this.args.some((a) => a.name === name)) {
        this.args.push({
          name,
          description: prop.description ? cleanText(prop.description) : undefined,
          required: true,
          format: format ?? (prop.type === 'number' || prop.type === 'integer' ? 'number' : undefined),
          default: prop.default
        })
      }
      return argPlaceholder(name)
    })
  }

  /** Replace $VAR / ${VAR} references to known env vars with {{VAR}} placeholders. */
  vars(value: string): string {
    return value.replace(VAR_RE, (whole, name: string) => (this.envNames.has(name) ? envPlaceholder(name) : whole))
  }
}

/** docker run option for a `type: server` entry (manual option when templates are unsupported). */
export function dockerServerOption(key: string, e: Record<string, unknown>): InstallOption {
  const image = asString(e.image)
  const toolkit = manualOption({
    notes: "Add it from Docker Desktop's MCP Toolkit — it needs folder access or settings that only Docker's gateway can fill in.",
    url: `https://hub.docker.com/mcp/server/${key}/overview`
  })
  if (!image) return toolkit
  const secrets = asArray(e.secrets)
    .map((s) => asRecord(s))
    .filter((s): s is Record<string, unknown> => !!s && !!asString(s.env))
  const envList = asArray(e.env)
    .map((x) => asRecord(x))
    .filter((x): x is Record<string, unknown> => !!x && !!asString(x.name))
  const envNames = new Set([...secrets.map((s) => asString(s.env)!), ...envList.map((x) => asString(x.name)!)])
  const specs = new DockerSpecs(asArray(e.config), envNames)
  const envArgs: string[] = []
  const runtimeArgs: string[] = []
  const notes: string[] = []
  try {
    for (const s of secrets) {
      specs.env.push({
        name: asString(s.env)!,
        description: plainDescription(s.description, 300) || undefined,
        required: secrets.length === 1,
        secret: true,
        placeholder: asString(s.example)
      })
    }
    if (secrets.length > 1) notes.push('Fill in the keys for the features you use.')
    for (const x of envList) {
      const name = asString(x.name)!
      const value = x.value === undefined || x.value === null ? '' : String(x.value)
      const whole = /^\{\{\s*([^}|]+?)\s*\}\}$/.exec(value)
      if (whole) {
        const prop = lookupConfig(specs.config, whole[1])
        specs.env.push({
          name,
          description: prop.description ? cleanText(prop.description) : undefined,
          required: prop.required,
          secret: false,
          default: prop.default,
          format: prop.type === 'number' || prop.type === 'integer' ? 'number' : prop.type === 'boolean' ? 'boolean' : undefined
        })
        continue
      }
      if (HAS_TEMPLATE.test(value)) envArgs.push('-e', `${name}=${specs.vars(specs.templ(value))}`)
      else envArgs.push('-e', `${name}=${specs.vars(value)}`)
    }
    for (const v of asArray(e.volumes)) {
      if (typeof v !== 'string') continue
      runtimeArgs.push('-v', specs.templ(v, 'path'))
      notes.push('Mounts a folder or volume into the container.')
    }
    const user = asString(e.user)
    if (user) runtimeArgs.push('--user', specs.templ(user))
    if (e.disableNetwork === true) runtimeArgs.push('--network', 'none')
    const command = asArray(e.command).filter((c): c is string => typeof c === 'string')
    const packageArgs = command.map((c) => specs.vars(specs.templ(c)))
    return dockerOption({
      package: image,
      runtimeArgs,
      envArgs,
      env: specs.env,
      packageArgs,
      argsSpec: specs.args,
      notes: uniq(notes).join(' ') || undefined
    })
  } catch (err) {
    if (err instanceof Unsupported) return toolkit
    throw err
  }
}

/** Remote option for a `type: remote` entry. */
export function dockerRemoteOption(e: Record<string, unknown>): InstallOption | undefined {
  const remote = asRecord(e.remote)
  const url = asString(remote?.url)
  if (!remote || !url) return undefined
  const transportType = asString(remote.transport_type) ?? 'streamable-http'
  const secrets = asArray(e.secrets)
    .map((s) => asRecord(s))
    .filter((s): s is Record<string, unknown> => !!s && !!asString(s.env))
  const secretFor = (name: string) => secrets.find((s) => asString(s.env) === name)
  const specs = new DockerSpecs(asArray(e.config), new Set())
  let finalUrl: string
  try {
    finalUrl = specs.templ(url, 'url')
  } catch {
    return undefined
  }
  if (!isHttpUrl(finalUrl)) return undefined
  const headers: HeaderSpec[] = []
  for (const [name, rawValue] of Object.entries(asRecord(remote.headers) ?? {})) {
    const value = String(rawValue ?? '')
    const vars = [...value.matchAll(VAR_RE)]
    if (!vars.length) {
      headers.push({ name, required: false, secret: false, default: value })
      continue
    }
    const varName = vars[0][1]
    const s = secretFor(varName)
    const spec: HeaderSpec = {
      name,
      description: plainDescription(s?.description, 300) || undefined,
      required: true,
      secret: !!s || /key|token|secret|auth/i.test(varName),
      placeholder: value.replace(vars[0][0], `<${varName}>`)
    }
    if (vars.length === 1) spec.template = value.replace(vars[0][0], '{{value}}')
    headers.push(spec)
  }
  const oauth = asArray(asRecord(e.oauth)?.providers).length > 0
  return remoteOption({
    url: finalUrl,
    transport: transportType === 'sse' ? 'sse' : 'http',
    headers,
    argsSpec: specs.args,
    notes: oauth && !headers.length ? 'Sign in with your account when Claude asks (OAuth).' : undefined
  })
}

/** Parse one catalog entry. `poci` tool containers are skipped. */
export function parseDockerEntry(key: string, raw: unknown, ctx: { monorepos?: ReadonlySet<string> } = {}): SourceEntry | undefined {
  const e = asRecord(raw)
  if (!e) return undefined
  const type = asString(e.type)
  if (type !== 'server' && type !== 'remote') return undefined
  const meta = asRecord(e.metadata) ?? {}
  const title = cleanText(e.title) || key
  const reference = /\(reference\)/i.test(title)
  const name = title.replace(/\s*\(reference\)\s*$/i, '').trim() || title
  const description = plainDescription(e.description, 400)
  const option = type === 'remote' ? dockerRemoteOption(e) : dockerServerOption(key, e)
  const keys: string[] = []
  const softKeys: string[] = []
  const image = asString(e.image)
  if (image) {
    const k = packageKey('oci', image)
    if (k) keys.push(k)
  }
  const rurl = asString(asRecord(e.remote)?.url)
  if (rurl) {
    const k = remoteKey(rurl)
    if (k) keys.push(k)
    const sk = softRemoteKey(rurl)
    if (sk) softKeys.push(sk)
  }
  const sourceRepo = parseRepoUrl(asString(e.source))
  const upstreamRepo = parseRepoUrl(asString(e.upstream))
  const repo = sourceRepo ?? upstreamRepo
  if (repo) {
    keys.push(repoKey(repo))
    softKeys.push(repoBaseKey(repo))
  }
  if (upstreamRepo && (!sourceRepo || repoBaseKey(upstreamRepo) !== repoBaseKey(sourceRepo))) softKeys.push(repoBaseKey(upstreamRepo))
  // Stars of a monorepo (e.g. modelcontextprotocol/servers) say nothing about one of its servers.
  const monorepo = !!sourceRepo?.subfolder || (!!repo && !!ctx.monorepos?.has(repoBaseKey(repo)))
  const stars = monorepo ? undefined : toCount(meta.githubStars)
  const pulls = toCount(meta.pulls)
  const upstream = asString(e.upstream)
  const archived = isArchivedReference(repo, key) || /\(archived\)/i.test(title)
  return {
    source: 'docker',
    ...(archived ? { deprecated: ARCHIVED_NOTE } : {}),
    sourceId: key,
    keys: uniq(keys),
    softKeys: uniq(softKeys),
    nameExplicit: true,
    metrics: stars || pulls ? { stars, pulls } : undefined,
    server: makeServer('docker', {
      id: sourceScopedId('docker', key),
      name,
      description,
      longDescription: withLicense(undefined, asString(meta.license)),
      publisher: asString(meta.owner),
      repository: isHttpUrl(upstream) ? upstream : repo ? repoUrl(repo) : undefined,
      homepage: `https://hub.docker.com/mcp/server/${key}/overview`,
      iconUrl: asString(e.icon),
      sourceCategories: asString(meta.category) ? [asString(meta.category)!] : undefined,
      tags: [...asArray(meta.tags).filter((t): t is string => typeof t === 'string'), reference ? 'reference' : undefined],
      official: /\bofficial\b/i.test(title) || /^official\b/i.test(description),
      verified: true,
      stars,
      install: option ? [option] : []
    })
  }
}

/** Parse a parsed catalog document ({ registry: { key: entry } }). */
export function parseDockerCatalog(doc: unknown): SourceEntry[] {
  const registry = asRecord(asRecord(doc)?.registry)
  if (!registry) return []
  // Repositories used by several catalog entries are monorepos.
  const repoCounts = new Map<string, number>()
  for (const raw of Object.values(registry)) {
    const e = asRecord(raw)
    const repo = parseRepoUrl(asString(e?.source)) ?? parseRepoUrl(asString(e?.upstream))
    if (repo) repoCounts.set(repoBaseKey(repo), (repoCounts.get(repoBaseKey(repo)) ?? 0) + 1)
  }
  const monorepos = new Set([...repoCounts].filter(([, n]) => n > 1).map(([k]) => k))
  const out: SourceEntry[] = []
  for (const [key, raw] of Object.entries(registry)) {
    const entry = parseDockerEntry(key, raw, { monorepos })
    if (entry) out.push(entry)
  }
  return out
}

/** Parse catalog.yaml text. */
export function parseDockerYaml(text: string): SourceEntry[] {
  return parseDockerCatalog(parseYaml(text, { maxAliasCount: -1 }))
}

async function run(rc: SourceRunContext): Promise<SourceRunResult> {
  const headers: Record<string, string> = { accept: 'application/yaml, text/yaml, */*' }
  if (rc.state.etag && !rc.force) headers['if-none-match'] = rc.state.etag
  const res = await rc.http.text(DOCKER_CATALOG_URL, headers)
  if (res.status === 304) {
    rc.begin('keep')
    return { message: 'Docker catalog unchanged' }
  }
  const entries = parseDockerYaml(res.text)
  if (!entries.length) throw new Error('The Docker MCP catalog could not be read (no servers found).')
  const sink = rc.begin('replace')
  await sink.put(entries)
  rc.progress(entries.length, `Docker MCP catalog: ${entries.length} servers`)
  return { state: { etag: res.headers.etag }, message: `${entries.length} servers` }
}

export const dockerSource: SourceAdapter = {
  id: 'docker',
  label: 'Docker MCP catalog',
  heavy: false,
  http: { concurrency: 1, minIntervalMs: 0, timeoutMs: 60_000 },
  available: async () => true,
  run
}
