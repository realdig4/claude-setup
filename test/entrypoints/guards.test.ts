import { describe, expect, it } from 'vitest'
import { CORE_METHODS, UI_METHODS } from '@shared/api'
import {
  extensionOf,
  isAllowedCoreCall,
  isAllowedUiCall,
  isOpenablePath,
  isSafeExternalUrl,
  isTrustedRendererUrl,
  rendererCsp
} from '../../src/main/guards'

describe('IPC allow-list', () => {
  it('accepts every method listed in CORE_METHODS', () => {
    for (const [ns, methods] of Object.entries(CORE_METHODS)) {
      for (const method of methods) expect(isAllowedCoreCall(ns, method)).toBe(true)
    }
  })

  it('rejects unknown namespaces, unknown methods and non-strings', () => {
    expect(isAllowedCoreCall('servers', 'deleteEverything')).toBe(false)
    expect(isAllowedCoreCall('fs', 'readFile')).toBe(false)
    expect(isAllowedCoreCall('ctx', 'secrets')).toBe(false)
    expect(isAllowedCoreCall(42, 'list')).toBe(false)
    expect(isAllowedCoreCall('servers', undefined)).toBe(false)
    expect(isAllowedCoreCall(null, null)).toBe(false)
  })

  it('is not fooled by prototype properties', () => {
    expect(isAllowedCoreCall('__proto__', 'constructor')).toBe(false)
    expect(isAllowedCoreCall('constructor', 'name')).toBe(false)
    expect(isAllowedCoreCall('toString', 'call')).toBe(false)
    expect(isAllowedCoreCall('servers', 'constructor')).toBe(false)
    expect(isAllowedCoreCall('servers', 'length')).toBe(false)
  })

  it('validates UI methods', () => {
    for (const m of UI_METHODS) expect(isAllowedUiCall(m)).toBe(true)
    expect(isAllowedUiCall('exec')).toBe(false)
    expect(isAllowedUiCall('__proto__')).toBe(false)
    expect(isAllowedUiCall(undefined)).toBe(false)
  })
})

describe('trusted renderer URLs', () => {
  it('trusts file:// pages and the dev server origin only', () => {
    expect(isTrustedRendererUrl('file:///C:/app/out/renderer/index.html')).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/#/models', 'http://localhost:5173')).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5174/', 'http://localhost:5173')).toBe(false)
    expect(isTrustedRendererUrl('https://evil.example/', 'http://localhost:5173')).toBe(false)
    expect(isTrustedRendererUrl('http://localhost:5173/')).toBe(false)
    expect(isTrustedRendererUrl('')).toBe(false)
    expect(isTrustedRendererUrl(undefined)).toBe(false)
    expect(isTrustedRendererUrl('not a url', 'also not a url')).toBe(false)
  })
})

describe('external links', () => {
  it('allows only http(s) URLs with a host', () => {
    expect(isSafeExternalUrl('https://github.com/x/y')).toBe(true)
    expect(isSafeExternalUrl('http://example.com')).toBe(true)
    expect(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('ms-settings:privacy')).toBe(false)
    expect(isSafeExternalUrl('smb://server/share')).toBe(false)
    expect(isSafeExternalUrl('https://' + 'a'.repeat(5000) + '.com')).toBe(false)
    expect(isSafeExternalUrl(123)).toBe(false)
  })
})

describe('openPath policy', () => {
  it('opens folders and config/text files but never programs or scripts', () => {
    expect(isOpenablePath('C:\\Users\\u\\AppData\\Roaming\\Claude', true)).toBe(true)
    expect(isOpenablePath('C:\\Users\\u\\.claude.json', false)).toBe(true)
    expect(isOpenablePath('/home/u/.config/Code/User/settings.json', false)).toBe(true)
    expect(isOpenablePath('/home/u/notes.MD', false)).toBe(true)
    for (const bad of ['C:\\x\\run.exe', 'C:\\x\\a.bat', 'C:\\x\\a.cmd', 'C:\\x\\a.ps1', 'C:\\x\\a.lnk', '/Applications/X.app', '/home/u/x.sh', '/home/u/x', 'C:\\x\\a.js']) {
      expect(isOpenablePath(bad, false)).toBe(false)
    }
  })

  it('extracts extensions from both path styles', () => {
    expect(extensionOf('C:\\a.b\\file.JSON')).toBe('.json')
    expect(extensionOf('/x/y/.bashrc')).toBe('')
    expect(extensionOf('/x/y/noext')).toBe('')
  })
})

describe('content security policy', () => {
  it('matches the production policy', () => {
    const csp = rendererCsp()
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("img-src 'self' data: https:")
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("font-src 'self' data:")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/)
  })

  it('relaxes scripts and allows the HMR websocket in development', () => {
    const csp = rendererCsp('http://localhost:5173')
    expect(csp).toMatch(/script-src 'self' 'unsafe-inline' http:\/\/localhost:5173/)
    expect(csp).toContain('ws://localhost:5173')
  })
})
