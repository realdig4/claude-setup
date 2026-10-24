/**
 * Browser mock of window.api for UI development outside Electron (`vite` preview, screenshots).
 * Never used inside the Electron app (main.tsx shows an error screen instead of fake data there).
 *
 * URL options:  ?theme=dark|light|system  ?mode=simple|advanced  ?onboarded=0|1
 *               ?platform=win32|darwin|linux  ?latency=0|fast  ?page=<page id> (handled by main.tsx)
 */
import type { AppSettings, OS } from '@shared/types'
import { writeCachedUi } from '../lib/theme'
import { createMockApi, mockCore, type MockOptions } from './api'
import { emit } from './runtime'
import { setTargetInstalled } from './servers'

export { createMockApi, mockCore, type MockOptions } from './api'

function detectPlatform(): OS {
  const ua = `${navigator.userAgent} ${navigator.platform ?? ''}`.toLowerCase()
  if (ua.includes('mac')) return 'darwin'
  if (ua.includes('linux') && !ua.includes('android')) return 'linux'
  return 'win32'
}

/** Install the mock as window.api (no-op when a real API is present). Returns the installed API. */
export function installMockApi(): void {
  if (window.api) return
  const params = new URLSearchParams(window.location.search)
  const settings: Partial<AppSettings> = {}
  const theme = params.get('theme')
  if (theme === 'light' || theme === 'dark' || theme === 'system') settings.theme = theme
  const mode = params.get('mode')
  if (mode === 'simple' || mode === 'advanced') settings.mode = mode
  const onboarded = params.get('onboarded')
  if (onboarded === '0' || onboarded === '1') settings.onboarded = onboarded === '1'
  const platformParam = params.get('platform')
  const platform: OS = platformParam === 'win32' || platformParam === 'darwin' || platformParam === 'linux' ? platformParam : detectPlatform()
  const latency = params.get('latency')

  const options: MockOptions = {
    platform,
    settings,
    latency: latency === '0' ? [0, 0] : latency === 'fast' ? [20, 60] : undefined,
    timeScale: latency === '0' ? 0 : undefined,
    ui: {
      async openExternal(url) {
        window.open(url, '_blank', 'noopener,noreferrer')
      },
      async copyText(text) {
        await navigator.clipboard.writeText(text)
      }
    }
  }

  // Make the first frame match the requested theme/mode (the store reads this cache on startup).
  writeCachedUi({ theme: settings.theme, mode: settings.mode })

  window.api = createMockApi(options)

  // Console helpers for UI work: window.__mock.emit('progress', {...}), window.__mock.setTargetInstalled('cursor', true)
  ;(window as unknown as { __mock: unknown }).__mock = { core: mockCore, emit, setTargetInstalled }

  // Like the real app, refresh a stale catalog shortly after start (exercises catalog events / status pill).
  if (params.get('refresh') !== '0' && latency !== '0') {
    window.setTimeout(() => void mockCore.catalog.refresh({ force: false }), 2500)
  }

  console.info('%cClaude Setup%c running with mock data (browser preview).', 'color:#D97757;font-weight:600', 'color:inherit')
}
