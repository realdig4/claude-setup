/**
 * Typed renderer-side client for the core. Usage:
 *   const page = await core.catalog.search({ query: 'github' })
 *   await ui.openExternal('https://…')
 *   useCoreEvent('progress', (p) => …)
 * Contract file (owner: lead).
 */
import { useEffect, useRef } from 'react'
import type { CoreApi, CoreEventName, CoreEvents, Namespace, UiApi } from '@shared/api'

type Promisified<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never }

function namespaceProxy<N extends Namespace>(ns: N): CoreApi[N] {
  return new Proxy({} as CoreApi[N], {
    get(_target, method: string) {
      return (...args: unknown[]) =>
        (window.api.call as (ns: string, method: string, ...args: unknown[]) => Promise<unknown>)(ns, method, ...args)
    }
  })
}

const cache = new Map<string, unknown>()

/** core.<namespace>.<method>(...) → Promise, over IPC. */
export const core: CoreApi = new Proxy({} as CoreApi, {
  get(_target, ns: string) {
    if (!cache.has(ns)) cache.set(ns, namespaceProxy(ns as Namespace))
    return cache.get(ns)
  }
})

/** GUI helpers implemented by the Electron main process. */
export const ui: Promisified<UiApi> = new Proxy({} as Promisified<UiApi>, {
  get(_target, method: string) {
    return (...args: unknown[]) => (window.api.ui as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...args)
  }
})

export const platform = (typeof window !== 'undefined' && window.api?.platform) || 'win32'

/** Subscribe to a core event for the lifetime of the component. */
export function useCoreEvent<K extends CoreEventName>(name: K, handler: (payload: CoreEvents[K]) => void): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    return window.api.onEvent((event) => {
      if (event.name === name) ref.current(event.payload as CoreEvents[K])
    })
  }, [name])
}

/** Normalize an unknown error (IPC errors arrive as Error with a prefixed message). */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
