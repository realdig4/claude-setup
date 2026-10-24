/**
 * Renderer entry. Loads fonts + styles, applies the cached theme before first paint, installs the
 * browser mock of window.api when running outside Electron (UI development / previews), then boots React.
 *
 * App code is imported dynamically on purpose: lib/api.ts reads window.api.platform at import time,
 * so the mock must be installed first.
 */
import '@fontsource-variable/inter/opsz.css'
import '@fontsource-variable/jetbrains-mono/wght.css'
import './styles/index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { isPageId } from './lib/nav'
import { applyInitialTheme } from './lib/theme'

applyInitialTheme()

/** Inside the Electron app (dev server or packaged file://) the mock must never be used. */
function isElectron(): boolean {
  return /\bElectron\//.test(navigator.userAgent) || window.location.protocol === 'file:'
}

/** Last-resort screen when the app cannot start at all (no React involved). */
function renderFatal(root: HTMLElement, title: string, detail: string): void {
  const wrap = document.createElement('div')
  wrap.className = 'flex h-full items-center justify-center bg-canvas p-8 text-fg'
  const card = document.createElement('div')
  card.className = 'w-full max-w-[480px] rounded-2xl border border-line bg-surface p-7 shadow-lg'
  const h = document.createElement('h1')
  h.className = 'text-[17px] font-semibold'
  h.textContent = title
  const p = document.createElement('p')
  p.className = 'mt-2 text-sm leading-6 text-fg-muted'
  p.textContent = detail
  const button = document.createElement('button')
  button.className = 'mt-5 h-9 rounded-lg bg-accent-solid px-3.5 text-sm font-medium text-accent-fg'
  button.textContent = 'Reload'
  button.addEventListener('click', () => window.location.reload())
  card.append(h, p, button)
  wrap.append(card)
  root.replaceChildren(wrap)
}

async function boot(): Promise<void> {
  const root = document.getElementById('root')
  if (!root) return

  const usingMock = !window.api
  if (usingMock) {
    if (isElectron()) {
      renderFatal(
        root,
        'Claude Setup couldn’t start',
        'The app’s background service did not load. Please reload, or reinstall Claude Setup if this keeps happening.'
      )
      return
    }
    // Plain browser (UI development): use realistic fake data instead of the real core.
    const { installMockApi } = await import('./mock')
    installMockApi()
  }

  const [{ default: App }, { ErrorBoundary }, { useAppStore }] = await Promise.all([
    import('./App'),
    import('./components/layout/ErrorBoundary'),
    import('./lib/store')
  ])

  const params = new URLSearchParams(window.location.search)
  // Deep link for previews / screenshots: ?page=discover
  const initialPage = params.get('page')
  if (isPageId(initialPage)) useAppStore.setState({ route: { page: initialPage, params: {} } })
  // Component gallery (browser preview only): ?gallery=1
  const Gallery = usingMock && params.has('gallery') ? (await import('./mock/Gallery')).default : null

  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary variant="app">
        <App devPage={Gallery ? <Gallery /> : undefined} />
      </ErrorBoundary>
    </StrictMode>
  )
}

boot().catch((err: unknown) => {
  const root = document.getElementById('root')
  const message = err instanceof Error ? err.message : String(err)
  if (root) renderFatal(root, 'Claude Setup couldn’t start', message)
  console.error('[Claude Setup] boot failed:', err)
})
