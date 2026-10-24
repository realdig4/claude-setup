/**
 * Normalised category taxonomy. Every registry uses its own labels (Docker "devops", Cline
 * "browser-automation", Anthropic use cases, GitHub topics, awesome-list headings…); they are
 * mapped onto these ids. CatalogServer.categories holds ids from CATEGORIES.
 */

export interface CategoryDef {
  id: string
  label: string
}

export const CATEGORIES: readonly CategoryDef[] = [
  { id: 'developer-tools', label: 'Developer Tools' },
  { id: 'browser-web', label: 'Browser & Web' },
  { id: 'search', label: 'Search' },
  { id: 'files-storage', label: 'Files & Storage' },
  { id: 'databases', label: 'Databases' },
  { id: 'cloud-devops', label: 'Cloud & DevOps' },
  { id: 'productivity', label: 'Productivity' },
  { id: 'communication', label: 'Communication' },
  { id: 'ai-memory', label: 'AI & Memory' },
  { id: 'data-analytics', label: 'Data & Analytics' },
  { id: 'design-media', label: 'Design & Media' },
  { id: 'finance-commerce', label: 'Finance & Commerce' },
  { id: 'security', label: 'Security' },
  { id: 'knowledge-docs', label: 'Knowledge & Docs' },
  { id: 'other', label: 'Other' }
]

const IDS = new Set(CATEGORIES.map((c) => c.id))

/** Label of a category id ("Other" for unknown ids). */
export function categoryLabel(id: string): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? 'Other'
}

/** Resolve a user-supplied category (id, label or source label) to a taxonomy id. */
export function resolveCategory(value: string | undefined): string | undefined {
  if (!value) return undefined
  const v = value.trim().toLowerCase()
  if (!v) return undefined
  if (IDS.has(v)) return v
  const byLabel = CATEGORIES.find((c) => c.label.toLowerCase() === v)
  if (byLabel) return byLabel.id
  return SOURCE_CATEGORY_MAP[normalizeLabel(v)] ?? undefined
}

function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Explicit categories published by sources (Docker, Cline, Anthropic use cases, awesome headings, Glama…). */
const SOURCE_CATEGORY_MAP: Record<string, string> = {
  // developer tools
  'developer-tools': 'developer-tools',
  'developer-tool': 'developer-tools',
  development: 'developer-tools',
  devtools: 'developer-tools',
  code: 'developer-tools',
  coding: 'developer-tools',
  'coding-agents': 'developer-tools',
  'code-execution': 'developer-tools',
  'command-line': 'developer-tools',
  'version-control': 'developer-tools',
  tools: 'developer-tools',
  quality: 'developer-tools',
  'os-automation': 'developer-tools',
  'embedded-system': 'developer-tools',
  'architecture-and-design': 'developer-tools',
  // browser & web
  web: 'browser-web',
  'browser-automation': 'browser-web',
  'web-scraping': 'browser-web',
  browser: 'browser-web',
  scraping: 'browser-web',
  // search
  search: 'search',
  'search-and-data-extraction': 'search',
  news: 'search',
  // files & storage
  'file-systems': 'files-storage',
  filesystem: 'files-storage',
  'cloud-storage': 'files-storage',
  storage: 'files-storage',
  // databases
  database: 'databases',
  databases: 'databases',
  'data-platforms': 'databases',
  // cloud & devops
  devops: 'cloud-devops',
  monitoring: 'cloud-devops',
  'cloud-platforms': 'cloud-devops',
  cloud: 'cloud-devops',
  infrastructure: 'cloud-devops',
  virtualization: 'cloud-devops',
  'cost-management': 'cloud-devops',
  observability: 'cloud-devops',
  // productivity
  productivity: 'productivity',
  'workplace-and-productivity': 'productivity',
  'product-management': 'productivity',
  'note-taking': 'productivity',
  'calendar-management': 'productivity',
  automation: 'productivity',
  business: 'productivity',
  crm: 'productivity',
  'sales-and-marketing': 'productivity',
  marketing: 'productivity',
  'customer-support': 'productivity',
  'support-and-service-management': 'productivity',
  'customer-data-platforms': 'productivity',
  aggregators: 'productivity',
  jobs: 'productivity',
  'agreements-coordination': 'productivity',
  // communication
  communication: 'communication',
  messaging: 'communication',
  'social-media': 'communication',
  email: 'communication',
  // ai & memory
  ai: 'ai-memory',
  'ai-ml': 'ai-memory',
  'knowledge-memory': 'ai-memory',
  'knowledge-and-memory': 'ai-memory',
  'conversational-ai': 'ai-memory',
  rag: 'ai-memory',
  'end-to-end-rag-platforms': 'ai-memory',
  memory: 'ai-memory',
  // data & analytics
  analytics: 'data-analytics',
  'data-analytics': 'data-analytics',
  data: 'data-analytics',
  'data-visualization': 'data-analytics',
  'data-science-tools': 'data-analytics',
  'research-data': 'data-analytics',
  geospatial: 'data-analytics',
  maps: 'data-analytics',
  'location-services': 'data-analytics',
  // design & media
  design: 'design-media',
  creative: 'design-media',
  media: 'design-media',
  video: 'design-media',
  'image-video-processing': 'design-media',
  'multimedia-process': 'design-media',
  'entertainment-media': 'design-media',
  'speech-processing': 'design-media',
  'speech-to-text': 'design-media',
  'text-to-speech': 'design-media',
  podcasts: 'design-media',
  'art-and-culture': 'design-media',
  gaming: 'design-media',
  games: 'design-media',
  // finance & commerce
  finance: 'finance-commerce',
  'financial-services': 'finance-commerce',
  'finance-fintech': 'finance-commerce',
  'finance-and-fintech': 'finance-commerce',
  fintech: 'finance-commerce',
  payments: 'finance-commerce',
  commerce: 'finance-commerce',
  'e-commerce': 'finance-commerce',
  ecommerce: 'finance-commerce',
  'ecommerce-retail': 'finance-commerce',
  blockchain: 'finance-commerce',
  'real-estate': 'finance-commerce',
  // security
  security: 'security',
  identity: 'security',
  cryptography: 'security',
  // knowledge & docs
  documentation: 'knowledge-docs',
  knowledge: 'knowledge-docs',
  research: 'knowledge-docs',
  education: 'knowledge-docs',
  legal: 'knowledge-docs',
  'life-sciences': 'knowledge-docs',
  'bio': 'knowledge-docs',
  'biology-medicine-and-bioinformatics': 'knowledge-docs',
  'translation-services': 'knowledge-docs',
  // other
  health: 'other',
  healthcare: 'other',
  'health-and-wellness': 'other',
  travel: 'other',
  'travel-and-transportation': 'other',
  iot: 'other',
  'industrial-iot': 'other',
  'home-automation': 'other',
  sports: 'other',
  'environment-and-nature': 'other',
  'aerospace-and-astrodynamics': 'other',
  'spirituality-and-esoterica': 'other',
  delivery: 'other',
  accessibility: 'other',
  boating: 'other',
  'other-tools-and-integrations': 'other',
  license: 'other'
}

/** Case-insensitive whole-word regex from alternatives (regex syntax allowed; dots are literal). */
function words(...alternatives: string[]): RegExp {
  return new RegExp(`\\b(${alternatives.map((a) => a.replace(/\./g, '\\.')).join('|')})\\b`, 'i')
}

/** Keyword rules applied to name, description and tags (weights are additive). */
const KEYWORD_RULES: Array<{ id: string; weight: number; re: RegExp }> = [
  {
    id: 'browser-web',
    weight: 3,
    re: words(
      'browser',
      'playwright',
      'puppeteer',
      'selenium',
      'headless',
      'chrom(e|ium)',
      'scrap(e|er|ing)',
      'crawl(er|ing)?',
      'web ?pages?',
      'devtools',
      'websites?',
      'fetch(es|ing)? (urls?|web)',
      'html'
    )
  },
  {
    id: 'search',
    weight: 3,
    re: words(
      'search engines?',
      'web search',
      'serp',
      'brave search',
      'tavily',
      'exa',
      'perplexity',
      'duckduckgo',
      'bing',
      'kagi',
      'google search',
      'searxng',
      'you.com'
    )
  },
  { id: 'search', weight: 1, re: words('search(es|ing)?') },
  {
    id: 'files-storage',
    weight: 3,
    re: words(
      'file ?systems?',
      'files?',
      'folders?',
      'director(y|ies)',
      'google drive',
      'dropbox',
      'onedrive',
      'box.com',
      's3',
      'object storage',
      'storage',
      'sharepoint',
      'pdfs?',
      'documents? conversion',
      'markdown conversion',
      'zip'
    )
  },
  {
    id: 'databases',
    weight: 4,
    re: words(
      'databases?',
      'sql',
      'postgres(ql)?',
      'mysql',
      'mariadb',
      'sqlite',
      'mongo(db)?',
      'redis',
      'supabase',
      'neo4j',
      'clickhouse',
      'bigquery',
      'snowflake',
      'duckdb',
      'elasticsearch',
      'opensearch',
      'cassandra',
      'dynamodb',
      'firestore',
      'firebase',
      'prisma',
      'neon',
      'pinecone',
      'qdrant',
      'weaviate',
      'chroma(db)?',
      'milvus',
      'vector (db|database|store)',
      'couchbase',
      'cockroach(db)?',
      'oracle db'
    )
  },
  {
    id: 'cloud-devops',
    weight: 3,
    re: words(
      'aws',
      'amazon web services',
      'azure',
      'gcp',
      'google cloud',
      'kubernetes',
      'k8s',
      'kubectl',
      'helm',
      'docker',
      'containers?',
      'terraform',
      'pulumi',
      'ansible',
      'devops',
      'ci/cd',
      'github actions',
      'jenkins',
      'circleci',
      'deploy(ment|s)?',
      'cloudflare',
      'vercel',
      'netlify',
      'heroku',
      'render.com',
      'fly.io',
      'monitoring',
      'observability',
      'grafana',
      'prometheus',
      'datadog',
      'new relic',
      'sentry',
      'logs?',
      'logging',
      'incidents?',
      'pagerduty',
      'opsgenie',
      'infrastructure',
      'serverless',
      'lambda'
    )
  },
  {
    id: 'developer-tools',
    weight: 3,
    re: words(
      'git',
      'github',
      'gitlab',
      'bitbucket',
      'code ?bases?',
      'coding',
      'developers?',
      'programming',
      'ide',
      'lsp',
      'language server',
      'debugg(er|ing)',
      'unit tests?',
      'testing',
      'linters?',
      'compilers?',
      'repositor(y|ies)',
      'pull requests?',
      'code review',
      'refactor(ing)?',
      'npm',
      'pypi',
      'sdk',
      'api (testing|client)',
      'postman',
      'openapi',
      'swagger',
      'xcode',
      'android studio',
      'unity',
      'terminal',
      'shell',
      'commands?',
      'cli'
    )
  },
  {
    id: 'productivity',
    weight: 3,
    re: words(
      'notion',
      'todo(ist)?',
      'tasks?',
      'calendars?',
      'project management',
      'asana',
      'linear',
      'trello',
      'jira',
      'clickup',
      'monday.com',
      'airtable',
      'spreadsheets?',
      'google sheets',
      'excel',
      'google docs',
      'office',
      'word documents?',
      'confluence',
      'crm',
      'salesforce',
      'hubspot',
      'zapier',
      'n8n',
      'make.com',
      'workflows?',
      'automation',
      'meetings?',
      'schedul(e|ing)',
      'notes?',
      'evernote'
    )
  },
  {
    id: 'communication',
    weight: 3,
    re: words(
      'slack',
      'discord',
      'e-?mails?',
      'gmail',
      'outlook',
      'telegram',
      'whatsapp',
      'microsoft teams',
      'sms',
      'twilio',
      'chat(s|ting)?',
      'messag(es|ing)',
      'zoom',
      'mattermost',
      'matrix',
      'signal',
      'imessage',
      'twitter',
      'x.com',
      'linkedin',
      'reddit',
      'bluesky',
      'mastodon',
      'social media'
    )
  },
  {
    id: 'ai-memory',
    weight: 3,
    re: words(
      'memory',
      'memories',
      'knowledge graphs?',
      'embeddings?',
      'rag',
      'retrieval',
      'llms?',
      'language models?',
      'openai',
      'gemini',
      'hugging ?face',
      'ai models?',
      'agents? orchestration',
      'multi-agent',
      'reasoning',
      'sequential thinking',
      'thinking',
      'prompts?',
      'context management',
      'long-term memory'
    )
  },
  {
    id: 'data-analytics',
    weight: 3,
    re: words(
      'analytics',
      'data analysis',
      'metrics',
      'dashboards?',
      'business intelligence',
      'tableau',
      'looker',
      'power ?bi',
      'metabase',
      'csv',
      'pandas',
      'jupyter',
      'notebooks?',
      'statistics',
      'google analytics',
      'mixpanel',
      'amplitude',
      'posthog',
      'charts?',
      'visuali[sz]ations?',
      'datasets?',
      'etl',
      'data warehouse',
      'maps?',
      'geocod(e|ing)',
      'weather',
      'open data',
      'government data',
      'census',
      'gis',
      'geospatial'
    )
  },
  {
    id: 'design-media',
    weight: 3,
    re: words(
      'figma',
      'design(s|ers?)?',
      'images?',
      'photos?',
      'videos?',
      'audio',
      'music',
      'youtube',
      'spotify',
      'canva',
      '3d',
      'blender',
      'svg',
      'icons?',
      'media',
      'podcasts?',
      'text[- ]to[- ]speech',
      'tts',
      'speech',
      'voice',
      'elevenlabs',
      'ffmpeg',
      'image generation',
      'midjourney',
      'stable diffusion',
      'dall-?e',
      'animations?',
      'fonts?'
    )
  },
  {
    id: 'finance-commerce',
    weight: 3,
    re: words(
      'finance',
      'financial',
      'stocks?',
      'stock market',
      'trading',
      'crypto(currency)?',
      'blockchain',
      'bitcoin',
      'ethereum',
      'solana',
      'defi',
      'crypto wallets?',
      'payment processing',
      'stripe',
      'paypal',
      'shopify',
      'e-?commerce',
      'online stores?',
      'banking',
      'banks?',
      'invoices?',
      'invoicing',
      'accounting',
      'quickbooks',
      'xero',
      'tax(es)?',
      'market data',
      'checkout',
      'credit (checks?|scores?)',
      'loans?',
      'mortgages?',
      'treasury',
      'sec filings?',
      'insider (trades|trading)'
    )
  },
  {
    id: 'security',
    weight: 4,
    re: words(
      'security',
      'vulnerabilit(y|ies)',
      'pentest(ing)?',
      'penetration testing',
      'cve',
      'threat (intel|intelligence)',
      'malware',
      'siem',
      'firewalls?',
      'osint',
      'secrets? scanning',
      'compliance',
      'audit logs?',
      'zero trust',
      'okta',
      'identity',
      'iam'
    )
  },
  {
    id: 'knowledge-docs',
    weight: 3,
    re: words(
      'documentation',
      'docs',
      'wiki(pedia)?',
      'knowledge base',
      'obsidian',
      'research papers?',
      'arxiv',
      'pubmed',
      'scholar',
      'library docs',
      'api docs',
      'context7',
      'deepwiki',
      'learn',
      'tutorials?',
      'books?',
      'dictionary',
      'translation',
      'rss',
      'news',
      'legal',
      'laws?',
      'court',
      'statutes?',
      'regulations?',
      'case law',
      'textbooks?',
      'encyclopedia'
    )
  }
]

export interface ClassifyInput {
  name?: string
  description?: string
  tags?: string[]
  /** Explicit category labels from the source(s). */
  sourceCategories?: string[]
}

/**
 * Pick up to `max` taxonomy ids for a server. Explicit source categories weigh most; keyword
 * matches over name/description/tags break ties. Always returns at least one id ("other").
 */
export function classify(input: ClassifyInput, max = 3): string[] {
  const scores = new Map<string, number>()
  const add = (id: string, w: number) => scores.set(id, (scores.get(id) ?? 0) + w)
  for (const raw of input.sourceCategories ?? []) {
    const id = resolveCategory(raw)
    if (id) add(id, id === 'other' ? 1 : 6)
  }
  const name = input.name ?? ''
  const text = `${name} ${input.description ?? ''} ${(input.tags ?? []).join(' ')}`
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(name)) add(rule.id, rule.weight * 2)
    else if (rule.re.test(text)) add(rule.id, rule.weight)
  }
  for (const tag of input.tags ?? []) {
    const id = SOURCE_CATEGORY_MAP[normalizeLabel(tag)]
    if (id && id !== 'other') add(id, 2)
  }
  const ranked = [...scores.entries()]
    .filter(([id, s]) => id !== 'other' && s >= 3)
    .sort((a, b) => b[1] - a[1])
  if (!ranked.length) return ['other']
  const top = ranked[0][1]
  return ranked
    .filter(([, s]) => s >= Math.max(3, top * 0.45))
    .slice(0, max)
    .map(([id]) => id)
}
