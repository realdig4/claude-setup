import { Suspense, lazy, useEffect, useRef, type ComponentType, type ReactNode } from 'react'
import { AnimatePresence, MotionConfig, motion, useIsPresent } from 'motion/react'
import { LucideProvider } from 'lucide-react'
import { AppShell, MAIN_CONTENT_ID } from './components/layout/AppShell'
import { CommandPalette } from './components/layout/CommandPalette'
import { ErrorBoundary } from './components/layout/ErrorBoundary'
import { ConfirmHost } from './components/ui/ConfirmDialog'
import { Portal, useLayer } from './components/ui/overlay'
import { Skeleton, SkeletonCard } from './components/ui/Skeleton'
import { Toaster } from './components/ui/toast'
import { useCoreEvent } from './lib/api'
import { useSettings, useThemeSync } from './lib/hooks'
import { pageVariants } from './lib/motion'
import { getPage } from './lib/nav'
import { useAppStore } from './lib/store'
import { PAGE_COMPONENTS, prefetchPages, type OnboardingProps } from './pages'

/**
 * First-run onboarding hook point: if pages/onboarding/index.tsx exists (default export receiving
 * OnboardingProps), it is shown full-window until it calls onDone() (which saves settings.onboarded).
 */
const onboardingModules = import.meta.glob<{ default: ComponentType<OnboardingProps> }>('./pages/onboarding/index.tsx')
const loadOnboarding = Object.values(onboardingModules)[0]
const Onboarding = loadOnboarding ? lazy(loadOnboarding) : null

export interface AppProps {
  /** Development only: render this instead of the routed page (used by the ?gallery=1 browser preview). */
  devPage?: ReactNode
}

/** Root component: theme sync, shell, router, palette, confirm dialogs, toasts and onboarding. */
export default function App({ devPage }: AppProps = {}) {
  useThemeSync()
  const { settings } = useSettings()
  const loadSettings = useAppStore((s) => s.loadSettings)
  const pageId = useAppStore((s) => s.route.page)

  useCoreEvent('state', (event) => {
    if (event.key === 'settings') void loadSettings(true)
  })

  useEffect(() => {
    document.title = pageId === 'home' ? 'Claude Setup' : `${getPage(pageId).label} · Claude Setup`
  }, [pageId])

  useEffect(() => {
    const id = window.setTimeout(prefetchPages, 1500)
    return () => window.clearTimeout(id)
  }, [])

  return (
    <LucideProvider strokeWidth={1.75}>
      <MotionConfig reducedMotion="user">
        <AppShell>{devPage ?? <PageRouter />}</AppShell>
        <CommandPalette />
        <ConfirmHost />
        <Toaster />
        <AnimatePresence>
          {Onboarding && settings?.onboarded === false ? <OnboardingLayer key="onboarding" /> : null}
        </AnimatePresence>
      </MotionConfig>
    </LucideProvider>
  )
}

/** Animated page switcher. Each page has its own error boundary and loading skeleton. */
function PageRouter() {
  const route = useAppStore((s) => s.route)
  const Page = PAGE_COMPONENTS[route.page]
  return (
    <AnimatePresence mode="wait" onExitComplete={() => document.getElementById(MAIN_CONTENT_ID)?.scrollTo({ top: 0 })}>
      <motion.div key={route.page} variants={pageVariants} initial="initial" animate="enter" exit="exit">
        <ErrorBoundary key={route.page}>
          <Suspense fallback={<PageSkeleton />}>
            <Page params={route.params} />
          </Suspense>
        </ErrorBoundary>
      </motion.div>
    </AnimatePresence>
  )
}

function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading page">
      <div className="mb-8 flex items-start gap-4">
        <Skeleton className="size-11 rounded-xl" />
        <div className="flex-1 space-y-2.5 pt-1">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    </div>
  )
}

function OnboardingLayer() {
  const ref = useRef<HTMLDivElement>(null)
  const isPresent = useIsPresent()
  const update = useAppStore((s) => s.updateSettings)
  useLayer({ active: isPresent, ref })
  if (!Onboarding) return null
  // Rendered into document.body like every other modal layer: useLayer() makes #root inert while a
  // modal is open, so a layer living inside #root would block its own clicks.
  return (
    <Portal>
      <motion.div
        ref={ref}
        tabIndex={-1}
        className="fixed inset-0 z-40 flex flex-col bg-canvas text-fg outline-none"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.25 } }}
      >
        <div className="drag-region h-[var(--titlebar-height)] shrink-0" />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ErrorBoundary onReset={() => void update({ onboarded: true })}>
            <Suspense fallback={null}>
              <Onboarding onDone={() => void update({ onboarded: true })} />
            </Suspense>
          </ErrorBoundary>
        </div>
      </motion.div>
    </Portal>
  )
}
