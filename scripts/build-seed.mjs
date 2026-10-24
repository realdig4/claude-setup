#!/usr/bin/env node
/**
 * Build resources/catalog-seed.json — the offline starter catalog bundled with Claude Setup.
 *
 * Crawls the curated registries and stores their RAW payloads, trimmed to the fields the app uses:
 *   - Claude connectors directory (Anthropic MCP sub-registry)
 *   - GitHub MCP registry (README cut to a short prefix)
 *   - Docker MCP catalog (catalog.yaml v3, parsed to JSON)
 * The app normalises these payloads at load time with the same parsers as a live refresh
 * (src/core/registry/seed-data.ts), so there is a single normalisation code path. The hand-curated
 * reference / vendor servers live in src/core/registry/seed.ts.
 *
 * Usage:
 *   node scripts/build-seed.mjs                       crawl live APIs
 *   node scripts/build-seed.mjs --from-dir <dir>      use local files anth_all.json, gh_all.json, dkcat_v3.yaml
 *   node scripts/build-seed.mjs --out <file>          output path (default resources/catalog-seed.json)
 * Only dependency: the `yaml` package.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_BYTES = 1_450_000
const UA = 'ClaudeSetup-seed-builder/1.0 (+https://github.com/)'

const ANTHROPIC = 'https://api.anthropic.com/mcp-registry/v0/servers?version=latest&visibility=commercial&limit=100'
const GITHUB = 'https://api.mcp.github.com/v0.1/servers?limit=100'
const DOCKER = 'https://desktop.docker.com/mcp/catalog/v3/catalog.yaml'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(url, accept = 'application/json') {
  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetch(url, { headers: { 'user-agent': UA, accept }, signal: AbortSignal.timeout(90_000) })
    } catch (err) {
      if (attempt >= 4) throw new Error(`${url}: ${err.message}`)
      await sleep(1000 * 2 ** attempt)
      continue
    }
    if (res.ok) return res.text()
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const ra = Number(res.headers.get('retry-after'))
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt)
      continue
    }
    throw new Error(`${url}: HTTP ${res.status}`)
  }
}

async function crawl(base, label) {
  const items = []
  let cursor
  const seen = new Set()
  for (let page = 0; page < 200; page++) {
    const url = cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base
    const data = JSON.parse(await get(url))
    const servers = Array.isArray(data.servers) ? data.servers : []
    items.push(...servers)
    process.stderr.write(`\r${label}: ${items.length} servers`)
    cursor = data.metadata?.nextCursor
    if (!cursor || !servers.length || seen.has(cursor)) break
    seen.add(cursor)
    await sleep(250)
  }
  process.stderr.write('\n')
  return items
}

/** Copy only the listed keys that have meaningful values. */
function pick(obj, keys) {
  const out = {}
  if (!obj || typeof obj !== 'object') return out
  for (const k of keys) {
    const v = obj[k]
    if (v === undefined || v === null || v === '') continue
    if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue
    if (Array.isArray(v) && !v.length) continue
    out[k] = v
  }
  return out
}

const SERVER_KEYS = ['name', 'title', 'description', 'version', 'websiteUrl', 'repository', 'icons', 'packages', 'remotes']
const OFFICIAL_META = 'io.modelcontextprotocol.registry/official'
/** Longest description kept for inputs (arguments, env vars, headers). */
const INPUT_DESCRIPTION = 160
/** Most inputs kept per list (the app shows at most 10 optional ones anyway). */
const MAX_INPUTS = 25

const cut = (text, max) => (typeof text === 'string' && text.length > max ? text.slice(0, max - 1) + '…' : text)

/** Shorten input descriptions and drop surplus optional inputs (required ones are always kept). */
function trimInputs(list) {
  if (!Array.isArray(list)) return list
  const required = list.filter((i) => i?.isRequired)
  const optional = list.filter((i) => !i?.isRequired)
  const kept = [...required, ...optional.slice(0, Math.max(0, MAX_INPUTS - required.length))]
  const order = new Map(list.map((x, i) => [x, i]))
  return kept
    .sort((a, b) => order.get(a) - order.get(b))
    .map((i) => (i && typeof i === 'object' ? { ...i, description: cut(i.description, INPUT_DESCRIPTION) } : i))
}

/** Registry status block: only what the parsers read (status when not active, updatedAt). */
function trimStatus(meta, withDate) {
  const out = {}
  if (meta?.status && meta.status !== 'active') out.status = meta.status
  if (withDate && meta?.updatedAt) out.updatedAt = meta.updatedAt
  return Object.keys(out).length ? { [OFFICIAL_META]: out } : undefined
}

/** server.json with trimmed inputs, a single icon and a bounded description. */
function trimServer(server, { icons = true, description = 600 } = {}) {
  const s = pick(server, SERVER_KEYS)
  if (Array.isArray(s.icons)) s.icons = icons ? s.icons.slice(0, 1) : undefined
  if (!s.icons) delete s.icons
  if (s.repository) s.repository = pick(s.repository, ['url', 'subfolder'])
  if (s.repository && !Object.keys(s.repository).length) delete s.repository
  if (s.description) s.description = cut(s.description, description)
  if (Array.isArray(s.packages)) {
    s.packages = s.packages.map((p) => ({
      ...p,
      runtimeArguments: trimInputs(p.runtimeArguments),
      packageArguments: trimInputs(p.packageArguments),
      environmentVariables: trimInputs(p.environmentVariables)
    }))
  }
  if (Array.isArray(s.remotes)) s.remotes = s.remotes.map((r) => ({ ...r, headers: trimInputs(r.headers) }))
  return s
}

function trimAnthropic(item) {
  const meta = item._meta ?? {}
  const anth = meta['com.anthropic.api/mcp-registry'] ?? {}
  return {
    server: trimServer(item.server, { description: 450 }),
    _meta: {
      ...trimStatus(meta[OFFICIAL_META], true),
      'com.anthropic.api/mcp-registry': pick(anth, [
        'displayName',
        'oneLiner',
        'iconUrl',
        'isAuthless',
        'documentation',
        'author',
        'urlOptions',
        'requiredFields',
        'urlRegex',
        'useCases'
      ])
    }
  }
}

function trimGithub(item, readmeChars) {
  const server = item.server ?? {}
  const gh = server._meta?.['io.modelcontextprotocol.registry/publisher-provided']?.github ?? {}
  const kept = pick(gh, [
    'displayName',
    'nameWithOwner',
    'ownerAvatarUrl',
    'license',
    'primaryLanguage',
    'pushedAt',
    'stargazerCount',
    'topics',
    'homepageUrl',
    'isInOrganization'
  ])
  if (Array.isArray(kept.topics)) kept.topics = kept.topics.slice(0, 10)
  if (readmeChars > 0 && typeof gh.readme === 'string') kept.readme = gh.readme.slice(0, readmeChars)
  const status = trimStatus(item._meta?.[OFFICIAL_META], !kept.pushedAt)
  return {
    server: {
      ...trimServer(server, { icons: false }),
      _meta: { 'io.modelcontextprotocol.registry/publisher-provided': { github: kept } }
    },
    ...(status ? { _meta: status } : {})
  }
}

const DOCKER_KEYS = [
  'title',
  'description',
  'type',
  'image',
  'upstream',
  'source',
  'icon',
  'secrets',
  'env',
  'config',
  'volumes',
  'command',
  'user',
  'remote',
  'oauth'
]

function trimDocker(doc) {
  const registry = {}
  for (const [key, e] of Object.entries(doc?.registry ?? {})) {
    if (!e || (e.type !== 'server' && e.type !== 'remote')) continue
    registry[key] = {
      ...pick(e, DOCKER_KEYS),
      ...(e.disableNetwork === true ? { disableNetwork: true } : {}),
      metadata: pick(e.metadata, ['pulls', 'githubStars', 'category', 'tags', 'owner'])
    }
  }
  return { registry }
}

/** JSON with one array element / registry entry per line (compact but diff-friendly). */
function serialize(seed) {
  const lines = []
  const head = { format: seed.format, version: seed.version, generatedAt: seed.generatedAt, counts: seed.counts }
  lines.push(JSON.stringify(head).slice(0, -1) + ',"sources":{')
  const blocks = []
  for (const name of ['anthropic', 'github']) {
    const items = seed.sources[name]
    blocks.push(`"${name}":[\n` + items.map((i) => JSON.stringify(i)).join(',\n') + '\n]')
  }
  const reg = Object.entries(seed.sources.docker.registry)
  const entries = reg.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
  blocks.push('"docker":{"registry":{\n' + entries.join(',\n') + '\n}}')
  lines.push(blocks.join(',\n'))
  lines.push('}}')
  return lines.join('\n') + '\n'
}

async function main() {
  const fromDir = arg('--from-dir')
  const out = resolve(arg('--out') ?? join(ROOT, 'resources', 'catalog-seed.json'))
  let anthropic
  let github
  let dockerDoc
  if (fromDir) {
    anthropic = JSON.parse(await readFile(join(fromDir, 'anth_all.json'), 'utf8'))
    github = JSON.parse(await readFile(join(fromDir, 'gh_all.json'), 'utf8'))
    dockerDoc = parseYaml(await readFile(join(fromDir, 'dkcat_v3.yaml'), 'utf8'), { maxAliasCount: -1 })
  } else {
    anthropic = await crawl(ANTHROPIC, 'Claude directory')
    github = await crawl(GITHUB, 'GitHub MCP registry')
    process.stderr.write('Docker MCP catalog…\n')
    dockerDoc = parseYaml(await get(DOCKER, 'application/yaml, text/yaml, */*'), { maxAliasCount: -1 })
  }
  const active = (i) => i?.server?.name && i?._meta?.[OFFICIAL_META]?.status !== 'deleted'
  anthropic = anthropic.filter(active)
  github = github.filter(active)
  if (anthropic.length < 50 || github.length < 100) {
    throw new Error(`Suspiciously small crawl (anthropic ${anthropic.length}, github ${github.length}); aborting.`)
  }

  let text
  for (const readmeChars of [900, 600, 400, 250, 0]) {
    const seed = {
      format: 'claude-setup-catalog-seed',
      version: 1,
      generatedAt: new Date().toISOString(),
      sources: {
        anthropic: anthropic.map(trimAnthropic),
        github: github.map((g) => trimGithub(g, readmeChars)),
        docker: trimDocker(dockerDoc)
      }
    }
    seed.counts = {
      anthropic: seed.sources.anthropic.length,
      github: seed.sources.github.length,
      docker: Object.keys(seed.sources.docker.registry).length
    }
    text = serialize(seed)
    JSON.parse(text)
    if (Buffer.byteLength(text) <= MAX_BYTES) break
    process.stderr.write(`Seed is ${(Buffer.byteLength(text) / 1e6).toFixed(2)} MB with ${readmeChars}-char READMEs; shrinking…\n`)
  }
  const bytes = Buffer.byteLength(text)
  if (bytes > MAX_BYTES) throw new Error(`Seed is ${(bytes / 1e6).toFixed(2)} MB, above the size budget (${(MAX_BYTES / 1e6).toFixed(2)} MB).`)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, text, 'utf8')
  process.stderr.write(`Wrote ${out} (${(bytes / 1024).toFixed(0)} KB)\n`)
}

main().catch((err) => {
  process.stderr.write(`build-seed failed: ${err.message}\n`)
  process.exit(1)
})
