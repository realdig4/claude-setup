import { CircleCheck, CircleX, Info, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { Toaster as SonnerToaster, toast } from 'sonner'
import { errorMessage } from '../../lib/api'
import { useResolvedTheme } from '../../lib/hooks'

export { toast }

/**
 * Themed toast container (bottom-right). Mounted once by App — pages just call toast.success(…) etc.
 * Rendered into document.body so toasts stay clickable while a dialog is open.
 */
export function Toaster() {
  const theme = useResolvedTheme()
  return createPortal(
    <SonnerToaster
      theme={theme}
      position="bottom-right"
      offset={20}
      gap={10}
      visibleToasts={4}
      closeButton
      containerAriaLabel="Notifications"
      toastOptions={{ duration: 4500, closeButtonAriaLabel: 'Dismiss notification' }}
      icons={{
        success: <CircleCheck className="size-[18px]" aria-hidden="true" />,
        error: <CircleX className="size-[18px]" aria-hidden="true" />,
        warning: <TriangleAlert className="size-[18px]" aria-hidden="true" />,
        info: <Info className="size-[18px]" aria-hidden="true" />,
        loading: <LoaderCircle className="size-[18px] animate-spin" aria-hidden="true" />,
        close: <X className="size-3" aria-hidden="true" />
      }}
    />,
    document.body
  )
}

/** Anything shaped like an OpResult / TargetChangeResult. */
export interface ResultLike {
  ok: boolean
  message: string
  details?: string
}

/**
 * Show a success or error toast for a core result object.
 * @example toastResult(await core.servers.setEnabled(name, target, false))
 */
export function toastResult(result: ResultLike, opts: { successTitle?: string; errorTitle?: string } = {}): void {
  if (result.ok) {
    if (opts.successTitle) toast.success(opts.successTitle, { description: result.message })
    else toast.success(result.message, result.details ? { description: result.details } : undefined)
  } else {
    toast.error(opts.errorTitle ?? result.message, {
      description: opts.errorTitle ? result.message : result.details,
      duration: 8000
    })
  }
}

/**
 * Show a friendly error toast for a thrown error (IPC prefixes are stripped).
 * @example try { … } catch (err) { toastError(err, 'Couldn’t install the tool') }
 */
export function toastError(err: unknown, title = 'Something went wrong'): void {
  toast.error(title, { description: errorMessage(err), duration: 8000 })
}
