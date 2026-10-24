/**
 * Icons for catalog categories. Registries and the core use slightly different ids ("browser" vs
 * "browser-web"), so ids are matched by keyword with a neutral fallback.
 */
import {
  Banknote,
  Bot,
  BookOpen,
  Brain,
  ChartColumn,
  Cloud,
  Code,
  Database,
  FolderOpen,
  Globe,
  LayoutGrid,
  ListChecks,
  MessageCircle,
  Palette,
  Search,
  ShieldCheck,
  Activity,
  Wrench,
  type LucideIcon
} from 'lucide-react'

const RULES: Array<[RegExp, LucideIcon]> = [
  [/develop|code|devtool/, Code],
  [/brows|web/, Globe],
  [/search|research/, Search],
  [/knowledge|docs\b|documentation/, BookOpen],
  [/file|storage/, FolderOpen],
  [/database|sql|data-?base/, Database],
  [/cloud|devops|infra/, Cloud],
  [/productiv|project|task/, ListChecks],
  [/communic|chat|messag|social/, MessageCircle],
  [/monitor|observ|log/, Activity],
  [/memory|note/, Brain],
  [/design|media|image|video/, Palette],
  [/financ|payment|commerce|crypto/, Banknote],
  [/analytic|data/, ChartColumn],
  [/secur/, ShieldCheck],
  [/\bai\b|^ai|model|llm/, Bot],
  [/util|tool/, Wrench]
]

/** Icon for a category id (falls back to a grid icon). */
export function categoryIcon(id: string): LucideIcon {
  const key = id.toLowerCase()
  for (const [re, icon] of RULES) if (re.test(key)) return icon
  return LayoutGrid
}
