/**
 * Page id → lazily loaded page component. Each page file default-exports a component that receives
 * `PageProps` ({ params }). Page owners replace the placeholder files and may add helpers under
 * pages/<area>/ (e.g. pages/discover/ServerCard.tsx).
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { PageId, PageProps } from '../lib/nav'

type PageModule = { default: ComponentType<PageProps> }

/**
 * Props for the optional first-run onboarding component (pages/onboarding/index.tsx, default export).
 * App shows it full-window while settings.onboarded is false; call onDone() when the user finishes or skips.
 */
export interface OnboardingProps {
  onDone: () => void
}

export const PAGE_LOADERS: Record<PageId, () => Promise<PageModule>> = {
  home: () => import('./HomePage'),
  discover: () => import('./DiscoverPage'),
  installed: () => import('./InstalledPage'),
  models: () => import('./ModelsPage'),
  extensions: () => import('./ExtensionsPage'),
  proxy: () => import('./ProxyPage'),
  doctor: () => import('./DoctorPage'),
  backups: () => import('./BackupsPage'),
  settings: () => import('./SettingsPage')
}

export const PAGE_COMPONENTS = Object.fromEntries(
  Object.entries(PAGE_LOADERS).map(([id, load]) => [id, lazy(load)])
) as Record<PageId, LazyExoticComponent<ComponentType<PageProps>>>

/** Warm up every page chunk in the background so first navigation is instant. */
export function prefetchPages(): void {
  for (const load of Object.values(PAGE_LOADERS)) void load().catch(() => {})
}
