/**
 * First-run onboarding (shown full-window by App while settings.onboarded is false):
 * welcome → what we found (apps + helpers, with installs) → Simple or Advanced → done.
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import type { RuntimeName } from '@shared/types'
import { Button, Stepper } from '@renderer/components/ui'
import { Wordmark } from '@renderer/components/layout/Brand'
import { core } from '@renderer/lib/api'
import { refreshTargets, useAsync, useTargets } from '@renderer/lib/hooks'
import { EASE_OUT } from '@renderer/lib/motion'
import { useAppStore } from '@renderer/lib/store'
import type { OnboardingProps } from '../../index'
import { DetectStep, StepHeading, StyleStep, WelcomeStep } from './steps'

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'apps', label: 'Your apps' },
  { id: 'style', label: 'Your style' }
]

const HEADINGS = [
  { title: 'Welcome to Claude Setup', subtitle: 'Set up Claude in a few clicks — no config files and no terminal needed.' },
  { title: 'Here’s what we found', subtitle: 'Claude Setup looked for Claude apps and the helpers that tools need. Nothing has been changed.' },
  { title: 'How would you like it?', subtitle: 'Pick the style that suits you. Everything works in both.' }
]

/** The onboarding flow. */
export default function Onboarding({ onDone }: OnboardingProps) {
  const [step, setStep] = useState(0)
  const startMode = useAppStore((s) => s.mode)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [mode, setMode] = useState<'simple' | 'advanced'>(startMode)
  const [finishing, setFinishing] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const firstRender = useRef(true)

  const targets = useTargets()
  const runtimes = useAsync(() => core.runtimes.detect(), [], { enabled: step >= 1 })

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    heading.current?.focus({ preventScroll: true })
    heading.current?.closest('.overflow-y-auto')?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [step])

  const onInstalled = (id: RuntimeName): void => {
    void runtimes.reload()
    if (id === 'claude' || id === 'code') void refreshTargets()
  }

  const finish = async (): Promise<void> => {
    if (finishing) return
    setFinishing(true)
    // Save the mode first, then mark onboarding done (one after the other, so neither response overwrites the other).
    if (mode !== useAppStore.getState().mode) await updateSettings({ mode })
    onDone()
  }

  const last = step === STEPS.length - 1
  const { title, subtitle } = HEADINGS[step] ?? HEADINGS[0]!

  return (
    <div className="relative flex min-h-full justify-center px-6 pt-4 pb-12">
      <div aria-hidden="true" className="hero-glow pointer-events-none absolute inset-x-0 top-0 h-[420px] opacity-80" />
      <div className="relative flex w-full max-w-[640px] flex-col">
        <header className="mb-8 flex items-center justify-between gap-4">
          <Wordmark />
          <Button variant="ghost" size="sm" onClick={() => void finish()} disabled={finishing}>
            Skip for now
          </Button>
        </header>

        <Stepper steps={STEPS} current={step} onStepClick={finishing ? undefined : setStep} className="mb-8 px-1" />

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0, transition: { duration: 0.24, ease: EASE_OUT } }}
            exit={{ opacity: 0, x: -12, transition: { duration: 0.14 } }}
          >
            <StepHeading ref={heading} title={title} subtitle={subtitle} />
            {step === 0 ? <WelcomeStep /> : null}
            {step === 1 ? (
              <DetectStep
                targets={targets.targets}
                targetsReady={targets.ready}
                targetsError={targets.error}
                onRetryTargets={() => void targets.reload()}
                runtimes={runtimes.data}
                runtimesError={runtimes.error}
                onRetryRuntimes={() => void runtimes.reload()}
                onInstalled={onInstalled}
                advanced={mode === 'advanced'}
              />
            ) : null}
            {step === 2 ? <StyleStep mode={mode} onChange={setMode} /> : null}
          </motion.div>
        </AnimatePresence>

        <footer className="mt-10 flex items-center justify-between gap-3 border-t border-line pt-5">
          {step > 0 ? (
            <Button variant="ghost" leftIcon={ArrowLeft} onClick={() => setStep((s) => s - 1)} disabled={finishing}>
              Back
            </Button>
          ) : (
            <span />
          )}
          {last ? (
            <Button variant="primary" size="lg" leftIcon={Check} loading={finishing} onClick={() => void finish()}>
              Start using Claude Setup
            </Button>
          ) : (
            <Button variant="primary" size="lg" rightIcon={ArrowRight} onClick={() => setStep((s) => s + 1)} data-autofocus>
              {step === 0 ? 'Get started' : 'Continue'}
            </Button>
          )}
        </footer>
      </div>
    </div>
  )
}
