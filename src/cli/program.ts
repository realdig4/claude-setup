/** The `claude-setup` command tree (commander). Built per run so tests can inject a fake core. */
import { Command } from 'commander'
import { registerBackupCommands } from './commands/backups'
import { registerDoctorCommand } from './commands/doctor'
import { registerExtensionCommands } from './commands/ext'
import { registerInstallCommands } from './commands/install'
import { registerMcpCommands } from './commands/mcp'
import { registerModelCommands } from './commands/models'
import { registerProxyCommands } from './commands/proxy'
import { registerRefreshCommand } from './commands/refresh'
import { registerSecretCommands } from './commands/secret'
import { registerServerCommands } from './commands/servers'
import { registerTargetCommands } from './commands/targets'
import type { CliContext } from './context'

const EXAMPLES = `
Examples:
  claude-setup search github             Find MCP servers
  claude-setup install <id> -t desktop   Add one to Claude Desktop
  claude-setup list                      What is installed where
  claude-setup doctor --fix              Find and fix problems
  claude-setup models add                Use another model in Claude Code
  claude-setup mcp register              Let Claude manage its own setup`

/** Build the full command tree for one invocation. */
export function buildProgram(ctx: CliContext): Command {
  const program = new Command('claude-setup')
  program
    .description('Set up Claude from your terminal: MCP servers, other models, extensions and health checks. (Unofficial; not affiliated with Anthropic.)')
    .version(ctx.deps.version, '-v, --version', 'Show the version')
    .helpOption('-h, --help', 'Show help')
    .helpCommand('help [command]', 'Show help for a command')
    .option('--json', 'Print machine-readable JSON')
    .option('--no-color', 'Turn off colours')
    .option('--verbose', 'Show detailed log messages')
    .configureOutput({
      writeOut: (text) => void ctx.io.stdout.write(text),
      writeErr: (text) => void ctx.io.stderr.write(text),
      outputError: (text, write) => {
        ctx.usageErrorShown = true
        write(ctx.out.c.red(text))
      }
    })
    .configureHelp({ showGlobalOptions: true, sortSubcommands: false })
    .showHelpAfterError('(add --help to see how to use it)')
    .showSuggestionAfterError(true)
    .exitOverride()
    .addHelpText('after', EXAMPLES)

  program.hook('preAction', (_cmd, action) => {
    const g = action.optsWithGlobals<{ json?: boolean; color?: boolean; verbose?: boolean }>()
    ctx.out.configure({ json: !!g.json, color: g.color !== false, verbose: !!g.verbose })
  })

  registerServerCommands(program, ctx)
  registerInstallCommands(program, ctx)
  registerTargetCommands(program, ctx)
  registerDoctorCommand(program, ctx)
  registerModelCommands(program, ctx)
  registerProxyCommands(program, ctx)
  registerExtensionCommands(program, ctx)
  registerBackupCommands(program, ctx)
  registerSecretCommands(program, ctx)
  registerMcpCommands(program, ctx)
  registerRefreshCommand(program, ctx)
  return program
}
