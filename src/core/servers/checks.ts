/** Pre-install checks: which runtimes a config needs, and risky Docker options worth a warning. */
import type { RuntimeName, ServerConfig } from '@shared/types'
import { isRemoteConfig } from '../targets/validate'
import { commandTool } from './hints'

/** Runtimes needed to run `config` (`bridged`: remote server run through mcp-remote, which needs Node). */
export function requiredRuntimes(config: ServerConfig, bridged = false): RuntimeName[] {
  if (isRemoteConfig(config)) return bridged ? ['npx'] : []
  const { tool, command } = commandTool(config)
  if (tool === 'node') return [command === 'node' ? 'node' : 'npx']
  if (tool === 'uv') return [command === 'uv' ? 'uv' : 'uvx']
  if (tool === 'docker') return command === 'docker' ? ['docker'] : []
  if (tool === 'python') return ['python']
  return []
}

/** Host side of a -v value ("C:\data:/data", "/srv:/srv:ro"); null for anonymous volumes ("/data"). */
function volumeSource(value: string): string | null {
  const m = /^([A-Za-z]:[\\/][^:]*|[^:]+):(.+)$/.exec(value)
  return m ? m[1] : null
}

const VALUE_FLAGS = new Set([
  '-v',
  '--volume',
  '--mount',
  '-p',
  '--publish',
  '--cap-add',
  '--device',
  '--security-opt',
  '--network',
  '--net',
  '--pid',
  '--ipc',
  '--userns'
])

/** Plain-language warnings about Docker options that give a container access to the computer. */
export function dockerRisks(config: ServerConfig): string[] {
  if (isRemoteConfig(config) || commandTool(config).tool !== 'docker') return []
  const args = config.args ?? []
  const risks: string[] = []
  const add = (text: string) => {
    if (!risks.includes(text)) risks.push(text)
  }
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]
    const eq = raw.indexOf('=')
    const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw
    let value = raw.startsWith('--') && eq > 0 ? raw.slice(eq + 1) : undefined
    if (value === undefined && VALUE_FLAGS.has(flag)) value = args[++i] ?? ''
    if (value === undefined && /^-v.+/.test(raw)) value = raw.slice(2)
    switch (flag) {
      case '--privileged':
        add('The Docker command runs the container with full access to your computer (--privileged).')
        break
      case '--cap-add':
        add(`The Docker command gives the container extra system permissions (--cap-add ${value}).`)
        break
      case '--network':
      case '--net':
        if (value === 'host') add("The Docker command shares your computer's network with the container (--network host).")
        break
      case '--pid':
      case '--ipc':
      case '--userns':
        if (value === 'host') add(`The Docker command shares your computer's ${flag.slice(2)} namespace with the container (${flag} host).`)
        break
      case '-p':
      case '--publish':
        add(`The Docker command opens network port ${value} on your computer.`)
        break
      case '--device':
        add(`The Docker command gives the container access to the device ${value}.`)
        break
      case '--security-opt':
        add(`The Docker command changes the container's security settings (${value}).`)
        break
      default: {
        const isVolume = flag === '-v' || flag === '--volume' || /^-v.+/.test(raw)
        const isMount = flag === '--mount'
        if (!isVolume && !isMount) break
        const spec = value ?? ''
        const source = isMount ? (/(?:^|,)(?:source|src)=([^,]+)/.exec(spec)?.[1] ?? '') : (volumeSource(spec) ?? '')
        const hostPath = /[\\/]/.test(source) || source.startsWith('~') || /^[A-Za-z]:/.test(source)
        if (/docker\.sock|docker_engine/i.test(spec)) {
          add('The Docker command gives the container control over Docker itself (it mounts the Docker socket).')
        } else if (hostPath) {
          add(`The Docker command shares the folder ${source} with the container.`)
        }
      }
    }
  }
  return risks
}
