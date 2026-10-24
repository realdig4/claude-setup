import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RotateCcw, RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '../ui/Button'
import { CodeBlock } from '../ui/CodeBlock'
import { Disclosure } from '../ui/Disclosure'
import { IconTile } from '../ui/IconTile'

export interface ErrorBoundaryProps {
  children: ReactNode
  /** 'page' (inside the shell, default) or 'app' (full window, used at the root). */
  variant?: 'page' | 'app'
  /** Called when the user presses "Try again" (state is reset before). */
  onReset?: () => void
}

interface ErrorBoundaryState {
  error: Error | null
  componentStack: string | null
}

/**
 * Catches render errors and shows a calm, friendly recovery screen instead of a blank window.
 * Pages are wrapped individually (one broken page never takes down the shell).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, componentStack: null }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null })
    // Surface in DevTools for developers; users see the friendly screen.
    console.error('[Claude Setup] UI error:', error, info.componentStack)
  }

  private reset = (): void => {
    this.setState({ error: null, componentStack: null })
    this.props.onReset?.()
  }

  override render(): ReactNode {
    const { error, componentStack } = this.state
    if (!error) return this.props.children
    const app = this.props.variant === 'app'
    const details = [error.stack ?? `${error.name}: ${error.message}`, componentStack ? `\nComponent stack:${componentStack}` : '']
      .join('')
      .trim()
    return (
      <div role="alert" className={app ? 'flex h-full items-center justify-center bg-canvas p-8 text-fg' : 'flex justify-center py-16'}>
        <div className="w-full max-w-[520px] rounded-2xl border border-line bg-surface p-7 shadow-lg">
          <div className="flex items-start gap-4">
            <IconTile icon={TriangleAlert} tone="danger" size="lg" />
            <div className="min-w-0 flex-1">
              <h2 className="text-[17px] leading-6 font-semibold tracking-[-0.01em]">
                {app ? 'Claude Setup ran into a problem' : 'This page ran into a problem'}
              </h2>
              <p className="mt-1 text-sm leading-6 text-fg-muted">
                Something unexpected happened while showing this screen. Your settings and config files are safe — nothing was
                changed.
              </p>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button variant="primary" leftIcon={RotateCcw} onClick={this.reset}>
              Try again
            </Button>
            <Button variant="outline" leftIcon={RefreshCw} onClick={() => window.location.reload()}>
              Reload app
            </Button>
          </div>
          <Disclosure title="Technical details" className="mt-5">
            <CodeBlock code={details} language="text" maxHeight={220} wrap />
          </Disclosure>
        </div>
      </div>
    )
  }
}
