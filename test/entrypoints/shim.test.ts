import { describe, expect, it } from 'vitest'
import { SHIM_MARKER, cliShimPlan, isDirOnPath, pathAdvice, pathFromEnv, shQuote, windowsBatchPath } from '@core/self/shim'

const winEnv = {
  LOCALAPPDATA: 'C:\\Users\\José\\AppData\\Local',
  APPDATA: 'C:\\Users\\José\\AppData\\Roaming',
  USERPROFILE: 'C:\\Users\\José',
  ProgramFiles: 'C:\\Program Files'
}

describe('Windows shim', () => {
  it('runs the app executable as Node with cli.js and keeps the env change local', () => {
    const plan = cliShimPlan(
      { exe: 'C:\\Users\\José\\AppData\\Local\\Programs\\Claude Setup\\claude-setup.exe', script: 'C:\\Users\\José\\AppData\\Local\\Programs\\Claude Setup\\resources\\app.asar\\out\\main\\cli.js', electron: true },
      'win32',
      'C:\\Users\\José\\.local\\bin',
      winEnv
    )
    expect(plan.path).toBe('C:\\Users\\José\\.local\\bin\\claude-setup.cmd')
    const lines = plan.content.split('\r\n')
    expect(lines[0]).toBe('@echo off')
    expect(plan.content).toContain(SHIM_MARKER)
    expect(lines).toContain('setlocal')
    expect(lines).toContain('set "ELECTRON_RUN_AS_NODE=1"')
    // Non-ASCII user name is replaced by a %VAR% reference so cmd.exe reads it correctly.
    expect(plan.content).toContain('"%LOCALAPPDATA%\\Programs\\Claude Setup\\claude-setup.exe" "%LOCALAPPDATA%\\Programs\\Claude Setup\\resources\\app.asar\\out\\main\\cli.js" %*')
    expect(plan.content).not.toContain('José')
    expect(plan.content).toContain('exit /b %ERRORLEVEL%')
    expect(plan.content.endsWith('\r\n')).toBe(true)
  })

  it('falls back to a UTF-8 code page for non-ASCII paths outside known folders', () => {
    const plan = cliShimPlan({ exe: 'D:\\Programmes\\Café\\claude-setup.exe', script: 'D:\\Programmes\\Café\\resources\\app.asar\\out\\main\\cli.js', electron: true }, 'win32', 'C:\\b', winEnv)
    expect(plan.content).toContain('chcp 65001 >nul')
    expect(plan.content).toContain('exit /b %CS_EXIT%')
  })

  it('escapes percent signs and omits ELECTRON_RUN_AS_NODE for node', () => {
    const plan = cliShimPlan({ exe: 'D:\\100%\\node.exe', script: 'D:\\100%\\cli.js', electron: false }, 'win32', 'C:\\b', {})
    expect(plan.content).toContain('"D:\\100%%\\node.exe" "D:\\100%%\\cli.js" %*')
    expect(plan.content).not.toContain('ELECTRON_RUN_AS_NODE')
  })

  it('windowsBatchPath prefers the longest matching folder variable', () => {
    expect(windowsBatchPath('C:\\Users\\José\\AppData\\Local\\X\\a.exe', winEnv)).toBe('%LOCALAPPDATA%\\X\\a.exe')
    expect(windowsBatchPath('C:\\Users\\José\\dev\\a.exe', winEnv)).toBe('%USERPROFILE%\\dev\\a.exe')
    expect(windowsBatchPath('c:\\users\\josé\\dev\\a.exe', winEnv)).toBe('%USERPROFILE%\\dev\\a.exe')
    expect(windowsBatchPath('E:\\tools\\a.exe', winEnv)).toBe('E:\\tools\\a.exe')
  })
})

describe('POSIX shim', () => {
  it('exports ELECTRON_RUN_AS_NODE and execs with quoted paths', () => {
    const plan = cliShimPlan(
      { exe: '/Applications/Claude Setup.app/Contents/MacOS/Claude Setup', script: "/Applications/Claude Setup.app/Contents/Resources/app.asar/out/main/cli.js", electron: true },
      'darwin',
      '/Users/u/.local/bin'
    )
    expect(plan.path).toBe('/Users/u/.local/bin/claude-setup')
    expect(plan.mode).toBe(0o755)
    expect(plan.content.startsWith('#!/bin/sh\n')).toBe(true)
    expect(plan.content).toContain('unset NODE_OPTIONS')
    expect(plan.content).toContain('ELECTRON_RUN_AS_NODE=1\nexport ELECTRON_RUN_AS_NODE')
    expect(plan.content).toContain(`exec '/Applications/Claude Setup.app/Contents/MacOS/Claude Setup' '/Applications/Claude Setup.app/Contents/Resources/app.asar/out/main/cli.js' "$@"`)
  })

  it('quotes single quotes safely', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`)
  })
})

describe('PATH detection', () => {
  it('Windows: case-insensitive, trailing slashes, %VARS% and quotes', () => {
    const env = { USERPROFILE: 'C:\\Users\\u' }
    expect(isDirOnPath('C:\\Users\\u\\.local\\bin', 'C:\\Windows;c:\\users\\U\\.local\\bin\\', 'win32', env)).toBe(true)
    expect(isDirOnPath('C:\\Users\\u\\.local\\bin', 'C:\\Windows;%USERPROFILE%\\.local\\bin', 'win32', env)).toBe(true)
    expect(isDirOnPath('C:\\Users\\u\\.local\\bin', '"C:\\Users\\u\\.local\\bin";C:\\x', 'win32', env)).toBe(true)
    expect(isDirOnPath('C:\\Users\\u\\.local\\bin', 'C:\\Windows;C:\\Users\\u\\.local', 'win32', env)).toBe(false)
  })

  it('POSIX: exact match, trailing slash ignored', () => {
    expect(isDirOnPath('/home/u/.local/bin', '/usr/bin:/home/u/.local/bin/', 'linux', {})).toBe(true)
    expect(isDirOnPath('/home/u/.local/bin', '/usr/bin:/home/U/.local/bin', 'linux', {})).toBe(false)
  })

  it('reads Path or PATH on Windows', () => {
    expect(pathFromEnv({ Path: 'A;B' }, 'win32')).toBe('A;B')
    expect(pathFromEnv({ PATH: 'a:b' }, 'linux')).toBe('a:b')
  })

  it('gives shell-specific advice', () => {
    expect(pathAdvice('C:\\Users\\u\\.local\\bin', 'win32', undefined)).toContain('Edit environment variables for your account')
    expect(pathAdvice('/Users/u/.local/bin', 'darwin', '/bin/zsh')).toContain('~/.zshrc')
    expect(pathAdvice('/home/u/.local/bin', 'linux', '/bin/bash')).toContain('~/.bashrc')
    expect(pathAdvice('/home/u/.local/bin', 'linux', '/usr/bin/fish')).toContain('fish_add_path')
  })
})
