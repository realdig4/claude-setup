/** Runtimes MCP servers need: Node.js ≥ 20 (npx), uv, Docker, Git. */
import { basename } from 'node:path'
import type { DoctorCheck, RuntimeInfo } from '@shared/types'
import { installFix, type CheckGroup, type RunContext } from '../context'

const CATEGORY = 'runtimes' as const

function where(info: RuntimeInfo): string {
  return [info.version ? `version ${info.version}` : '', info.path ? `at ${info.path}` : ''].filter(Boolean).join(' ')
}

function howToInstall(info: RuntimeInfo | undefined): string {
  if (!info?.install) return ''
  return info.install.command ? ` To install it yourself: ${info.install.command}` : ` Download: ${info.install.url}`
}

function nodeCheck(node: RuntimeInfo | undefined): DoctorCheck {
  const base = { id: 'runtime:node', category: CATEGORY, title: 'Node.js', docsUrl: node?.install?.url ?? 'https://nodejs.org/en/download' }
  const fix = installFix(node, 'node', 'Node.js')
  const manual = fix ? '' : howToInstall(node)
  if (!node?.found) {
    return { ...base, status: 'warn', detail: `Node.js isn't installed. Most MCP servers start with npx, which comes with Node.js 20 or newer.${manual}`, fix }
  }
  if (node.outdated) {
    return { ...base, status: 'warn', detail: `Node.js ${node.version ?? ''} is too old — MCP servers need version 20 or newer.${manual}`, fix }
  }
  return { ...base, status: 'ok', detail: `Node.js ${where(node)}` }
}

function npxCheck(npx: RuntimeInfo | undefined, node: RuntimeInfo | undefined): DoctorCheck {
  const base = { id: 'runtime:npx', category: CATEGORY, title: 'npx' }
  if (npx?.found) return { ...base, status: 'ok', detail: `npx ${where(npx)}` }
  return {
    ...base,
    status: 'warn',
    detail: 'Node.js is installed but npx is missing, so npx-based MCP servers can\'t start. Reinstalling Node.js usually fixes this.',
    fix: installFix(node, 'node', 'Node.js')
  }
}

function optionalRuntime(info: RuntimeInfo | undefined, id: 'uv' | 'git', title: string, purpose: string): DoctorCheck {
  const base = { id: `runtime:${id}`, category: CATEGORY, title, docsUrl: info?.install?.url }
  if (info?.found) return { ...base, status: 'ok', detail: `${title} ${where(info)}` }
  const fix = installFix(info, id, title)
  return { ...base, status: 'info', detail: `${title} isn't installed. ${purpose}${fix ? '' : howToInstall(info)}`, fix }
}

async function usesDocker(rc: RunContext): Promise<string[]> {
  try {
    const servers = await rc.servers()
    return servers
      .filter((s) => s.enabled && s.config.type === 'stdio' && /^docker(\.exe)?$/i.test(basename(s.config.command)))
      .map((s) => s.name)
  } catch {
    return []
  }
}

async function dockerCheck(rc: RunContext, docker: RuntimeInfo | undefined): Promise<DoctorCheck> {
  const docsUrl = docker?.install?.url ?? 'https://www.docker.com/products/docker-desktop/'
  const base = { id: 'runtime:docker', category: CATEGORY, title: 'Docker', docsUrl }
  const users = await usesDocker(rc)
  const usedBy = users.length ? ` Used by: ${users.join(', ')}.` : ''
  if (!docker?.found) {
    const fix = installFix(docker, 'docker', 'Docker Desktop')
    return {
      ...base,
      status: users.length ? 'warn' : 'info',
      detail: `Docker isn't installed. It's needed only for MCP servers that run in containers.${usedBy}${fix ? '' : howToInstall(docker)}`,
      fix
    }
  }
  if (docker.running === false) {
    return {
      ...base,
      status: users.length ? 'warn' : 'info',
      detail: `Docker is installed but not running. Start Docker Desktop before using container-based servers.${usedBy}`
    }
  }
  return { ...base, status: 'ok', detail: `Docker ${where(docker)}${docker.running ? ' (running)' : ''}` }
}

export const runtimeChecks: CheckGroup = {
  id: 'runtimes',
  category: CATEGORY,
  title: 'Runtimes',
  timeoutMs: 45_000,
  async run(rc) {
    const list = await rc.runtimes()
    const by = new Map(list.map((r) => [r.id, r]))
    const node = by.get('node')
    const checks: DoctorCheck[] = [nodeCheck(node)]
    if (node?.found) checks.push(npxCheck(by.get('npx'), node))
    checks.push(optionalRuntime(by.get('uv'), 'uv', 'uv', 'It\'s needed only for Python-based MCP servers (the ones started with uvx).'))
    checks.push(await dockerCheck(rc, by.get('docker')))
    checks.push(optionalRuntime(by.get('git'), 'git', 'Git', 'It\'s needed to add plugin marketplaces and for some MCP servers.'))
    return checks
  }
}
