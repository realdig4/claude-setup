import { FolderOpen, Info, Sparkles } from 'lucide-react'
import type { AppSettings, OS } from '@shared/types'
import { AdvancedOnly, Button, Card, CardContent, KeyValue, Monogram, PathText, Skeleton, toast } from '@renderer/components/ui'
import { core, ui } from '@renderer/lib/api'
import { useAsync } from '@renderer/lib/hooks'

/** The first-run welcome screen exists in this build (pages/onboarding). */
const HAS_ONBOARDING = Object.keys(import.meta.glob('../onboarding/index.tsx')).length > 0

const OS_NAMES: Record<OS, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

export interface AboutSectionProps {
  update: (patch: Partial<AppSettings>) => Promise<boolean>
}

/** Data folder, version and platform, the welcome screen, and the "unofficial" notice. */
export function AboutSection({ update }: AboutSectionProps) {
  const info = useAsync(() => core.app.info(), [])

  const openDataFolder = async (): Promise<void> => {
    if (!info.data) return
    try {
      const problem = await ui.openPath(info.data.dataDir)
      if (problem) toast.error('Couldn’t open the folder', { description: problem })
    } catch {
      toast.error('Couldn’t open the folder', { description: info.data.dataDir })
    }
  }

  return (
    <Card>
      <CardContent className="space-y-6 pt-6">
        <div className="flex items-center gap-4">
          <Monogram text="Claude Setup" letters="CS" color="#D97757" size="lg" />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-fg">{info.data?.name ?? 'Claude Setup'}</h3>
            {info.data ? (
              <p className="text-[13px] text-fg-muted">
                Version {info.data.version} · {OS_NAMES[info.data.platform]} ({info.data.arch})
                {info.data.packaged ? '' : ' · development build'}
              </p>
            ) : (
              <Skeleton className="mt-1 h-3.5 w-48" />
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {HAS_ONBOARDING ? (
              <Button size="sm" variant="ghost" leftIcon={Sparkles} onClick={() => void update({ onboarded: false })}>
                Show the welcome screen
              </Button>
            ) : null}
            <Button size="sm" leftIcon={FolderOpen} disabled={!info.data} onClick={() => void openDataFolder()}>
              Open data folder
            </Button>
          </div>
        </div>

        <AdvancedOnly>
          {info.data ? (
            <KeyValue
              items={[
                { label: 'Data folder', value: <PathText path={info.data.dataDir} copy reveal max={80} /> },
                { label: 'Running as', value: info.data.surface === 'gui' ? 'Desktop app' : info.data.surface },
                { label: 'Platform', value: `${info.data.platform} · ${info.data.arch}`, mono: true }
              ]}
            />
          ) : null}
        </AdvancedOnly>

        <div className="flex items-start gap-3 rounded-xl border border-line bg-surface-2/60 px-4 py-3.5">
          <Info className="mt-0.5 size-[18px] shrink-0 text-fg-muted" aria-hidden="true" />
          <div className="text-[13.5px] leading-[1.55]">
            <p className="font-semibold text-fg">Unofficial — not affiliated with Anthropic</p>
            <p className="mt-0.5 text-fg-muted">
              Claude Setup is an independent tool for Claude. It isn’t made, endorsed or supported by Anthropic. Claude is a trademark of
              Anthropic.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
