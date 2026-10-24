/**
 * Opens the install wizard from anywhere (Discover cards, the details sheet, Home's popular tools).
 * A page renders <InstallWizardHost/> once; openInstallWizard() shows it.
 */
import { create } from 'zustand'
import type { CatalogServer } from '@shared/types'

export interface WizardRequest {
  /** Unique per opening (fresh wizard state each time). */
  id: number
  /** Install a catalog server… */
  catalogId?: string
  /** …already loaded (skips the lookup). */
  server?: CatalogServer
  /** …or add a custom server (Advanced). */
  custom?: boolean
}

interface WizardStore {
  request: WizardRequest | null
  open: (request: Omit<WizardRequest, 'id'>) => void
  close: () => void
}

let nextId = 1

export const useInstallWizard = create<WizardStore>()((set) => ({
  request: null,
  open: (request) => set({ request: { ...request, id: nextId++ } }),
  close: () => set({ request: null })
}))

/** Show the install wizard for a catalog server. */
export function openInstallWizard(server: CatalogServer | string): void {
  useInstallWizard.getState().open(typeof server === 'string' ? { catalogId: server } : { catalogId: server.id, server })
}

/** Show the wizard for a custom server (command or URL). */
export function openCustomWizard(): void {
  useInstallWizard.getState().open({ custom: true })
}
