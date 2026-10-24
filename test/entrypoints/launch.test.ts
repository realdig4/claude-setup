import { describe, expect, it } from 'vitest'
import { cliLaunchFromConfig, guiSelfLaunch, sameLaunch, selfLaunchFromEntry, unstableLocationReason } from '@core/self/launch'

describe('guiSelfLaunch', () => {
  it('packaged Windows build runs mcp.js inside app.asar with ELECTRON_RUN_AS_NODE', () => {
    const r = guiSelfLaunch({
      platform: 'win32',
      packaged: true,
      execPath: 'C:\\Users\\u\\AppData\\Local\\Programs\\Claude Setup\\claude-setup.exe',
      resourcesPath: 'C:\\Users\\u\\AppData\\Local\\Programs\\Claude Setup\\resources',
      appPath: 'C:\\Users\\u\\AppData\\Local\\Programs\\Claude Setup\\resources\\app.asar',
      env: {}
    })
    expect(r.unavailableReason).toBeUndefined()
    expect(r.config).toEqual({
      type: 'stdio',
      command: 'C:\\Users\\u\\AppData\\Local\\Programs\\Claude Setup\\claude-setup.exe',
      args: ['C:\\Users\\u\\AppData\\Local\\Programs\\Claude Setup\\resources\\app.asar\\out\\main\\mcp.js'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
  })

  it('development uses the project out/ folder', () => {
    const r = guiSelfLaunch({
      platform: 'linux',
      packaged: false,
      execPath: '/work/app/node_modules/electron/dist/electron',
      resourcesPath: '/work/app/node_modules/electron/dist/resources',
      appPath: '/work/app',
      env: {}
    })
    expect(r.config?.args).toEqual(['/work/app/out/main/mcp.js'])
    expect(r.config?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('macOS packaged app inside /Applications is registrable', () => {
    const r = guiSelfLaunch({
      platform: 'darwin',
      packaged: true,
      execPath: '/Applications/Claude Setup.app/Contents/MacOS/Claude Setup',
      resourcesPath: '/Applications/Claude Setup.app/Contents/Resources',
      appPath: '/Applications/Claude Setup.app/Contents/Resources/app.asar',
      env: {}
    })
    expect(r.config?.args).toEqual(['/Applications/Claude Setup.app/Contents/Resources/app.asar/out/main/mcp.js'])
  })
})

describe('unstable locations are never registered', () => {
  it('portable Windows build', () => {
    const r = guiSelfLaunch({
      platform: 'win32',
      packaged: true,
      execPath: 'C:\\Users\\u\\AppData\\Local\\Temp\\2abc\\claude-setup.exe',
      resourcesPath: 'C:\\Users\\u\\AppData\\Local\\Temp\\2abc\\resources',
      appPath: 'C:\\Users\\u\\AppData\\Local\\Temp\\2abc\\resources\\app.asar',
      env: { PORTABLE_EXECUTABLE_FILE: 'D:\\claude-setup-portable.exe' }
    })
    expect(r.config).toBeUndefined()
    expect(r.unavailableReason).toMatch(/portable/i)
  })

  it('macOS App Translocation and disk images', () => {
    expect(unstableLocationReason({ platform: 'darwin', execPath: '/private/var/folders/x/T/AppTranslocation/ABC/d/Claude Setup.app/Contents/MacOS/Claude Setup', env: {} })).toMatch(/Applications/)
    expect(unstableLocationReason({ platform: 'darwin', execPath: '/Volumes/Claude Setup/Claude Setup.app/Contents/MacOS/Claude Setup', env: {} })).toMatch(/disk image/)
  })

  it('AppImage', () => {
    expect(unstableLocationReason({ platform: 'linux', execPath: '/tmp/.mount_ClaudeX/claude-setup', env: {} })).toMatch(/AppImage/)
    expect(unstableLocationReason({ platform: 'linux', execPath: '/opt/x/claude-setup', env: { APPIMAGE: '/home/u/Claude.AppImage' } })).toMatch(/AppImage/)
  })

  it('npx cache', () => {
    const r = selfLaunchFromEntry({
      platform: 'linux',
      execPath: '/usr/bin/node',
      entryDir: '/home/u/.npm/_npx/1a2b/node_modules/claude-setup/out/main',
      electron: false,
      env: {}
    })
    expect(r.config).toBeUndefined()
    expect(r.unavailableReason).toMatch(/npx/)
  })

  it('a normal deb install is fine', () => {
    expect(unstableLocationReason({ platform: 'linux', execPath: '/opt/Claude Setup/claude-setup', env: {} })).toBeUndefined()
  })
})

describe('node-run copies (npm global / dev)', () => {
  it('uses node without ELECTRON_RUN_AS_NODE', () => {
    const r = selfLaunchFromEntry({ platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe', entryDir: 'C:\\npm\\node_modules\\claude-setup\\out\\main', electron: false, env: {} })
    expect(r.config).toEqual({ type: 'stdio', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\npm\\node_modules\\claude-setup\\out\\main\\mcp.js'] })
  })
})

describe('cliLaunchFromConfig', () => {
  it('puts cli.js next to mcp.js with the same executable', () => {
    expect(
      cliLaunchFromConfig({ type: 'stdio', command: 'C:\\A\\claude-setup.exe', args: ['C:\\A\\resources\\app.asar\\out\\main\\mcp.js'], env: { ELECTRON_RUN_AS_NODE: '1' } }, 'win32')
    ).toEqual({ exe: 'C:\\A\\claude-setup.exe', script: 'C:\\A\\resources\\app.asar\\out\\main\\cli.js', electron: true })
    expect(cliLaunchFromConfig({ type: 'stdio', command: '/usr/bin/node', args: ['/x/out/main/mcp.js'] }, 'linux')).toEqual({
      exe: '/usr/bin/node',
      script: '/x/out/main/cli.js',
      electron: false
    })
  })

  it('refuses configs that are not ours', () => {
    expect(cliLaunchFromConfig(undefined, 'win32')).toBeUndefined()
    expect(cliLaunchFromConfig({ type: 'stdio', command: 'npx', args: ['-y', 'something'] }, 'linux')).toBeUndefined()
  })
})

describe('sameLaunch', () => {
  it('compares command, args and env (order-insensitive env)', () => {
    const a = { type: 'stdio' as const, command: 'x', args: ['a'], env: { A: '1', B: '2' } }
    expect(sameLaunch(a, { type: 'stdio', command: 'x', args: ['a'], env: { B: '2', A: '1' } })).toBe(true)
    expect(sameLaunch(a, { type: 'stdio', command: 'y', args: ['a'], env: { A: '1', B: '2' } })).toBe(false)
    expect(sameLaunch(a, { type: 'stdio', command: 'x', args: ['b'], env: { A: '1', B: '2' } })).toBe(false)
  })
})
