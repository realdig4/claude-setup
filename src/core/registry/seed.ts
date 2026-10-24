/**
 * Hand-curated servers bundled with the app (source "seed"): the official reference servers (which are
 * not in any registry) and popular vendor servers, with friendly descriptions and verified install
 * options. Package versions and remote endpoints were checked on 2026-10-23 against npm, PyPI, the
 * official registry and the endpoints themselves (OAuth endpoints answer 401 + resource_metadata).
 *
 * To update: bump versions after checking https://registry.npmjs.org/<pkg>/latest or
 * https://pypi.org/pypi/<pkg>/json. Live registry data with newer versions of the same package
 * automatically wins at merge time (see dedupe.ts).
 */
import type { ArgSpec, EnvVarSpec, InstallOption } from '@shared/types'
import { dockerOption, npmOption, pypiOption, remoteOption } from './install'
import { nameKey, packageKey, parseRepoUrl, remoteKey, repoBaseKey, repoKey } from './keys'
import { makeServer } from './normalize'
import type { HeaderSpec, SourceEntry } from './types'
import { uniq } from './util'

const OAUTH = 'Sign in with your account when Claude asks (OAuth).'
const NO_SIGN_IN = 'No account or key needed.'
const NODE24 = 'Needs Node.js 24 or newer.'

export interface SeedServer {
  /** Stable catalog id (official registry name when the server has one). */
  id: string
  /** Official registry / package-declared name; prevents merging with other registered servers. */
  officialName?: string
  name: string
  /** Suggested config key (defaults to a slug of the name). */
  slug?: string
  description: string
  categories: string[]
  publisher: string
  repository?: string
  /** Subfolder of a monorepo. */
  subfolder?: string
  homepage?: string
  iconUrl?: string
  tags?: string[]
  official?: boolean
  install: InstallOption[]
  /** Extra matching keys (e.g. Docker images of the same server). */
  extraKeys?: string[]
}

const bearer = (description: string, opts: { required: boolean; helpUrl?: string; name?: string }): HeaderSpec => ({
  name: opts.name ?? 'Authorization',
  description,
  required: opts.required,
  secret: true,
  placeholder: 'Bearer <token>',
  template: 'Bearer {{value}}',
  helpUrl: opts.helpUrl
})

const secretEnv = (name: string, description: string, helpUrl?: string, required = true): EnvVarSpec => ({
  name,
  description,
  required,
  secret: true,
  helpUrl
})

const optionalEnv = (name: string, description: string, extra: Partial<EnvVarSpec> = {}): EnvVarSpec => ({
  name,
  description,
  required: false,
  secret: false,
  ...extra
})

const REF = 'https://github.com/modelcontextprotocol/servers'
const CONTEXT7_KEYS = 'https://context7.com/dashboard'
const GITHUB_TOKENS = 'https://github.com/settings/personal-access-tokens/new'
const FIRECRAWL_KEYS = 'https://firecrawl.dev/app/api-keys'

export const SEED_SERVERS: readonly SeedServer[] = [
  {
    id: 'io.github.modelcontextprotocol/server-filesystem',
    officialName: 'io.github.modelcontextprotocol/server-filesystem',
    name: 'Filesystem',
    description: 'Let Claude read, create and organise files in the folders you choose — and nothing outside them.',
    categories: ['files-storage'],
    publisher: 'Model Context Protocol',
    repository: REF,
    subfolder: 'src/filesystem',
    homepage: `${REF}/tree/main/src/filesystem`,
    tags: ['files', 'folders', 'local', 'reference'],
    official: true,
    install: [
      npmOption({
        package: '@modelcontextprotocol/server-filesystem',
        version: '2.0.0',
        packageArgs: ['{{arg:directories}}'],
        argsSpec: [
          { name: 'directories', description: 'Folders Claude may use (add one or more).', required: true, repeatable: true, format: 'directory' }
        ],
        notes: NODE24
      })
    ],
    extraKeys: ['oci:docker.io/mcp/filesystem']
  },
  {
    id: 'io.github.modelcontextprotocol/server-fetch',
    officialName: 'io.github.modelcontextprotocol/server-fetch',
    name: 'Fetch',
    description: 'Let Claude open any web page and read it as clean text. Great for summarising articles and docs.',
    categories: ['browser-web'],
    publisher: 'Model Context Protocol',
    repository: REF,
    subfolder: 'src/fetch',
    homepage: `${REF}/tree/main/src/fetch`,
    tags: ['web', 'markdown', 'reference'],
    official: true,
    install: [pypiOption({ package: 'mcp-server-fetch', version: '2026.10.19' })],
    extraKeys: ['oci:docker.io/mcp/fetch']
  },
  {
    id: 'io.github.modelcontextprotocol/server-memory',
    officialName: 'io.github.modelcontextprotocol/server-memory',
    name: 'Memory',
    description: 'Give Claude a long-term memory: it remembers people, projects and preferences between chats.',
    categories: ['ai-memory'],
    publisher: 'Model Context Protocol',
    repository: REF,
    subfolder: 'src/memory',
    homepage: `${REF}/tree/main/src/memory`,
    tags: ['memory', 'knowledge-graph', 'reference'],
    official: true,
    install: [
      npmOption({
        package: '@modelcontextprotocol/server-memory',
        version: '2.0.0',
        env: [optionalEnv('MEMORY_FILE_PATH', 'Where to keep the memory file (optional).', { format: 'path' })],
        notes: NODE24
      })
    ],
    extraKeys: ['oci:docker.io/mcp/memory']
  },
  {
    id: 'io.github.modelcontextprotocol/server-sequential-thinking',
    officialName: 'io.github.modelcontextprotocol/server-sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Helps Claude break hard problems into steps, revise its thinking and explore alternatives.',
    categories: ['ai-memory'],
    publisher: 'Model Context Protocol',
    repository: REF,
    subfolder: 'src/sequentialthinking',
    homepage: `${REF}/tree/main/src/sequentialthinking`,
    tags: ['reasoning', 'planning', 'reference'],
    official: true,
    install: [
      npmOption({
        package: '@modelcontextprotocol/server-sequential-thinking',
        version: '2.0.0',
        env: [optionalEnv('DISABLE_THOUGHT_LOGGING', 'Set to "true" to stop logging thoughts.', { format: 'boolean' })],
        notes: NODE24
      })
    ],
    extraKeys: ['oci:docker.io/mcp/sequentialthinking']
  },
  {
    id: 'io.github.modelcontextprotocol/server-time',
    officialName: 'io.github.modelcontextprotocol/server-time',
    name: 'Time',
    description: 'Current time and time-zone conversions, so Claude always knows what time it is anywhere.',
    categories: ['productivity'],
    publisher: 'Model Context Protocol',
    repository: REF,
    subfolder: 'src/time',
    homepage: `${REF}/tree/main/src/time`,
    tags: ['time', 'timezone', 'reference'],
    official: true,
    install: [
      pypiOption({
        package: 'mcp-server-time',
        version: '2026.10.19',
        packageArgs: ['--local-timezone', '{{arg:local-timezone}}'],
        argsSpec: [
          { name: 'local-timezone', description: 'Your time zone, e.g. Europe/Paris (optional — detected automatically).', required: false }
        ]
      })
    ],
    extraKeys: ['oci:docker.io/mcp/time']
  },
  {
    id: 'io.github.modelcontextprotocol/server-git',
    officialName: 'io.github.modelcontextprotocol/server-git',
    name: 'Git',
    description: 'Let Claude look through a Git repository: history, diffs, branches and commits.',
    categories: ['developer-tools'],
    publisher: 'Model Context Protocol',
    repository: REF,
    subfolder: 'src/git',
    homepage: `${REF}/tree/main/src/git`,
    tags: ['git', 'version-control', 'reference'],
    official: true,
    install: [
      pypiOption({
        package: 'mcp-server-git',
        version: '2026.10.19',
        packageArgs: ['--repository', '{{arg:repository}}'],
        argsSpec: [
          {
            name: 'repository',
            description: 'Repository folder (optional — Claude can also pick one per request).',
            required: false,
            format: 'directory'
          }
        ]
      })
    ],
    extraKeys: ['oci:docker.io/mcp/git']
  },
  {
    id: 'io.github.modelcontextprotocol/server-everything',
    officialName: 'io.github.modelcontextprotocol/server-everything',
    name: 'Everything (test server)',
    slug: 'everything',
    description: 'A test server that uses every MCP feature — handy for checking that your setup works.',
    categories: ['developer-tools'],
    publisher: 'Model Context Protocol',
    repository: REF,
    subfolder: 'src/everything',
    homepage: `${REF}/tree/main/src/everything`,
    tags: ['testing', 'reference'],
    official: true,
    install: [npmOption({ package: '@modelcontextprotocol/server-everything', version: '2.0.0', notes: NODE24 })]
  },
  {
    id: 'io.github.microsoft/playwright-mcp',
    officialName: 'io.github.microsoft/playwright-mcp',
    name: 'Playwright',
    description: 'Let Claude open and control a real browser: click, type, fill in forms and take screenshots.',
    categories: ['browser-web', 'developer-tools'],
    publisher: 'Microsoft',
    repository: 'https://github.com/microsoft/playwright-mcp',
    tags: ['browser', 'automation', 'testing'],
    official: true,
    install: [npmOption({ package: '@playwright/mcp', version: '0.0.83', notes: 'Downloads a browser the first time it runs.' })]
  },
  {
    id: 'io.github.ChromeDevTools/chrome-devtools-mcp',
    officialName: 'io.github.ChromeDevTools/chrome-devtools-mcp',
    name: 'Chrome DevTools',
    description: 'Let Claude drive Google Chrome to test pages, inspect network requests and measure performance.',
    categories: ['browser-web', 'developer-tools'],
    publisher: 'Google Chrome',
    repository: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    tags: ['browser', 'chrome', 'debugging'],
    official: true,
    install: [npmOption({ package: 'chrome-devtools-mcp', version: '1.12.0', notes: 'Needs Google Chrome installed.' })]
  },
  {
    id: 'io.github.upstash/context7',
    officialName: 'io.github.upstash/context7',
    name: 'Context7',
    description: 'Up-to-date documentation and code examples for thousands of libraries, right inside Claude.',
    categories: ['knowledge-docs', 'developer-tools'],
    publisher: 'Upstash',
    repository: 'https://github.com/upstash/context7',
    homepage: 'https://context7.com',
    iconUrl: 'https://raw.githubusercontent.com/upstash/context7/master/public/icon.png',
    tags: ['documentation', 'libraries', 'code-examples'],
    official: true,
    install: [
      remoteOption({
        url: 'https://mcp.context7.com/mcp',
        headers: [bearer('Context7 API key (optional — raises rate limits).', { required: false, helpUrl: CONTEXT7_KEYS })],
        notes: 'Works without an account; add a free API key for higher limits.'
      }),
      npmOption({
        package: '@upstash/context7-mcp',
        version: '4.4.4',
        env: [secretEnv('CONTEXT7_API_KEY', 'Context7 API key (optional — raises rate limits).', CONTEXT7_KEYS, false)]
      })
    ]
  },
  {
    id: 'cognitionai/deepwiki',
    name: 'DeepWiki',
    description: 'Ask questions about any public GitHub repository and get answers from its auto-generated wiki.',
    categories: ['knowledge-docs', 'developer-tools'],
    publisher: 'Cognition',
    repository: 'https://github.com/CognitionAI/deepwiki',
    homepage: 'https://deepwiki.com',
    tags: ['documentation', 'github', 'repositories'],
    official: true,
    install: [remoteOption({ url: 'https://mcp.deepwiki.com/mcp', notes: NO_SIGN_IN })]
  },
  {
    id: 'io.github.github/github-mcp-server',
    officialName: 'io.github.github/github-mcp-server',
    name: 'GitHub',
    description: 'Work with GitHub from Claude: browse code, manage issues and pull requests, check Actions runs.',
    categories: ['developer-tools'],
    publisher: 'GitHub',
    repository: 'https://github.com/github/github-mcp-server',
    iconUrl: 'https://avatars.githubusercontent.com/u/9919?s=200&v=4',
    tags: ['github', 'issues', 'pull-requests'],
    official: true,
    install: [
      remoteOption({
        url: 'https://api.githubcopilot.com/mcp/',
        headers: [
          bearer('GitHub personal access token.', {
            required: true,
            helpUrl: GITHUB_TOKENS
          })
        ],
        notes: 'Create a personal access token on GitHub and paste it here.'
      }),
      dockerOption({
        package: 'ghcr.io/github/github-mcp-server:2.0.3',
        env: [secretEnv('GITHUB_PERSONAL_ACCESS_TOKEN', 'GitHub personal access token.', GITHUB_TOKENS)]
      })
    ]
  },
  {
    id: 'com.notion/mcp',
    officialName: 'com.notion/mcp',
    name: 'Notion',
    description: 'Search, read and update your Notion pages and databases.',
    categories: ['productivity', 'knowledge-docs'],
    publisher: 'Notion',
    homepage: 'https://developers.notion.com/docs/mcp',
    tags: ['notes', 'wiki', 'docs'],
    official: true,
    install: [
      remoteOption({ url: 'https://mcp.notion.com/mcp', notes: OAUTH }),
      npmOption({
        package: '@notionhq/notion-mcp-server',
        version: '2.5.2',
        env: [secretEnv('NOTION_TOKEN', 'Notion integration token (starts with ntn_).', 'https://www.notion.so/profile/integrations')]
      })
    ]
  },
  {
    id: 'app.linear/linear',
    officialName: 'app.linear/linear',
    name: 'Linear',
    description: 'Find, create and update Linear issues, projects and comments.',
    categories: ['productivity'],
    publisher: 'Linear',
    homepage: 'https://linear.app/docs/mcp',
    iconUrl: 'https://static.linear.app/integrations/mcp/icon-256.png',
    tags: ['issues', 'project-management'],
    official: true,
    install: [remoteOption({ url: 'https://mcp.linear.app/mcp', notes: OAUTH })]
  },
  {
    id: 'io.github.getsentry/sentry-mcp',
    officialName: 'io.github.getsentry/sentry-mcp',
    name: 'Sentry',
    description: 'Look into errors and performance problems reported to Sentry and get help fixing them.',
    categories: ['cloud-devops', 'developer-tools'],
    publisher: 'Sentry',
    repository: 'https://github.com/getsentry/sentry-mcp',
    subfolder: 'packages/mcp-server',
    homepage: 'https://docs.sentry.io/product/sentry-mcp/',
    tags: ['errors', 'monitoring', 'debugging'],
    official: true,
    install: [
      remoteOption({ url: 'https://mcp.sentry.dev/mcp', notes: OAUTH }),
      npmOption({
        package: '@sentry/mcp-server',
        version: '0.42.0',
        env: [secretEnv('SENTRY_ACCESS_TOKEN', 'Sentry user auth token.', 'https://sentry.io/settings/account/api/auth-tokens/')]
      })
    ]
  },
  {
    id: 'io.github.brave/brave-search-mcp-server',
    officialName: 'io.github.brave/brave-search-mcp-server',
    name: 'Brave Search',
    description: 'Search the web, news, images and videos with Brave Search. Needs a free Brave Search API key.',
    categories: ['search'],
    publisher: 'Brave',
    repository: 'https://github.com/brave/brave-search-mcp-server',
    homepage: 'https://brave.com/search/api/',
    iconUrl: 'https://avatars.githubusercontent.com/u/12301619?s=200&v=4',
    tags: ['web-search', 'news', 'images'],
    official: true,
    install: [
      npmOption({
        package: '@brave/brave-search-mcp-server',
        version: '2.1.4',
        env: [secretEnv('BRAVE_API_KEY', 'Brave Search API key.', 'https://api-dashboard.search.brave.com/app/keys')]
      })
    ]
  },
  {
    id: 'com.microsoft/microsoft-learn-mcp',
    officialName: 'com.microsoft/microsoft-learn-mcp',
    name: 'Microsoft Learn Docs',
    slug: 'microsoft-learn',
    description: 'Trusted, up-to-date Microsoft documentation and code samples (Azure, .NET, Windows, Microsoft 365…).',
    categories: ['knowledge-docs'],
    publisher: 'Microsoft',
    repository: 'https://github.com/MicrosoftDocs/mcp',
    tags: ['documentation', 'azure', 'dotnet'],
    official: true,
    install: [remoteOption({ url: 'https://learn.microsoft.com/api/mcp', notes: NO_SIGN_IN })]
  },
  {
    id: 'seed:duckduckgo',
    name: 'DuckDuckGo Search',
    slug: 'duckduckgo',
    description: 'Free web search with DuckDuckGo — no account or API key needed.',
    categories: ['search'],
    publisher: 'nickclyde',
    repository: 'https://github.com/nickclyde/duckduckgo-mcp-server',
    tags: ['web-search', 'free'],
    install: [pypiOption({ package: 'duckduckgo-mcp-server', version: '0.7.0', notes: NO_SIGN_IN })],
    extraKeys: ['oci:docker.io/mcp/duckduckgo']
  },
  {
    id: 'ai.exa/exa',
    officialName: 'ai.exa/exa',
    name: 'Exa Search',
    slug: 'exa',
    description: 'Fast, high-quality web search and page reading built for AI. Works without an account.',
    categories: ['search'],
    publisher: 'Exa',
    repository: 'https://github.com/exa-labs/exa-mcp-server',
    homepage: 'https://exa.ai',
    tags: ['web-search', 'research'],
    official: true,
    install: [
      remoteOption({ url: 'https://mcp.exa.ai/mcp', notes: 'Works without an account (rate-limited).' }),
      npmOption({
        package: 'exa-mcp-server',
        version: '3.4.2',
        env: [secretEnv('EXA_API_KEY', 'Exa API key.', 'https://dashboard.exa.ai/api-keys')]
      })
    ]
  },
  {
    id: 'io.github.tavily-ai/tavily-mcp',
    officialName: 'io.github.tavily-ai/tavily-mcp',
    name: 'Tavily',
    description: 'Web search, extraction and crawling tuned for AI assistants. Needs a Tavily account.',
    categories: ['search', 'browser-web'],
    publisher: 'Tavily',
    repository: 'https://github.com/tavily-ai/tavily-mcp',
    homepage: 'https://tavily.com',
    tags: ['web-search', 'extraction'],
    official: true,
    install: [
      remoteOption({ url: 'https://mcp.tavily.com/mcp', notes: OAUTH }),
      npmOption({
        package: 'tavily-mcp',
        version: '0.2.22',
        env: [secretEnv('TAVILY_API_KEY', 'Tavily API key.', 'https://app.tavily.com/home')]
      })
    ]
  },
  {
    id: 'io.github.firecrawl/firecrawl-mcp-server',
    officialName: 'io.github.firecrawl/firecrawl-mcp-server',
    name: 'Firecrawl',
    description: 'Scrape, crawl and search websites and get clean content Claude can use.',
    categories: ['browser-web', 'search'],
    publisher: 'Firecrawl',
    repository: 'https://github.com/firecrawl/firecrawl-mcp-server',
    homepage: 'https://firecrawl.dev',
    tags: ['scraping', 'crawling'],
    official: true,
    install: [
      npmOption({
        package: 'firecrawl-mcp',
        version: '3.34.1',
        env: [secretEnv('FIRECRAWL_API_KEY', 'Firecrawl API key.', FIRECRAWL_KEYS)]
      }),
      remoteOption({
        url: 'https://mcp.firecrawl.dev/v2/mcp',
        headers: [bearer('Firecrawl API key (optional for a quick try).', { required: false, helpUrl: FIRECRAWL_KEYS })]
      })
    ]
  },
  {
    id: 'ai.perplexity/mcp-server',
    officialName: 'ai.perplexity/mcp-server',
    name: 'Perplexity',
    description: 'Real-time web answers and research with sources, powered by Perplexity. Needs a Perplexity API key.',
    categories: ['search'],
    publisher: 'Perplexity',
    homepage: 'https://docs.perplexity.ai/guides/mcp-server',
    tags: ['web-search', 'research'],
    official: true,
    install: [
      npmOption({
        package: '@perplexity-ai/mcp-server',
        version: '1.3.0',
        env: [secretEnv('PERPLEXITY_API_KEY', 'Perplexity API key.', 'https://www.perplexity.ai/account/api')]
      })
    ]
  },
  {
    id: 'io.github.wonderwhy-er/desktop-commander',
    officialName: 'io.github.wonderwhy-er/desktop-commander',
    name: 'Desktop Commander',
    description: 'Run terminal commands and edit files on your computer from Claude. Powerful — use with care.',
    categories: ['developer-tools', 'files-storage'],
    publisher: 'wonderwhy-er',
    repository: 'https://github.com/wonderwhy-er/DesktopCommanderMCP',
    tags: ['terminal', 'files', 'automation'],
    install: [npmOption({ package: '@wonderwhy-er/desktop-commander', version: '0.3.1', notes: 'Needs Node.js 22.12 or newer.' })]
  },
  {
    id: 'microsoft/markitdown',
    name: 'MarkItDown',
    slug: 'markitdown',
    description: 'Turn PDFs, Word, Excel, PowerPoint, images and more into text Claude can read.',
    categories: ['files-storage', 'knowledge-docs'],
    publisher: 'Microsoft',
    repository: 'https://github.com/microsoft/markitdown',
    subfolder: 'packages/markitdown-mcp',
    tags: ['pdf', 'office', 'conversion'],
    official: true,
    install: [pypiOption({ package: 'markitdown-mcp', version: '0.0.1a8' })],
    extraKeys: ['oci:docker.io/mcp/markitdown']
  },
  {
    id: 'com.supabase/mcp',
    officialName: 'com.supabase/mcp',
    name: 'Supabase',
    description: 'Manage your Supabase projects: query the database, run migrations and read logs.',
    categories: ['databases', 'cloud-devops'],
    publisher: 'Supabase',
    repository: 'https://github.com/supabase/mcp',
    subfolder: 'packages/mcp-server-supabase',
    homepage: 'https://supabase.com/mcp',
    tags: ['postgres', 'database', 'backend'],
    official: true,
    install: [
      remoteOption({ url: 'https://mcp.supabase.com/mcp', notes: OAUTH }),
      npmOption({
        package: '@supabase/mcp-server-supabase',
        version: '0.14.0',
        packageArgs: ['--project-ref', '{{arg:project-ref}}'],
        argsSpec: [{ name: 'project-ref', description: 'Limit to one project (optional, project reference id).', required: false }],
        env: [secretEnv('SUPABASE_ACCESS_TOKEN', 'Supabase personal access token.', 'https://supabase.com/dashboard/account/tokens')]
      })
    ]
  },
  {
    id: 'io.github.mongodb-js/mongodb-mcp-server',
    officialName: 'io.github.mongodb-js/mongodb-mcp-server',
    name: 'MongoDB',
    description: 'Query and manage MongoDB databases and Atlas clusters.',
    categories: ['databases'],
    publisher: 'MongoDB',
    repository: 'https://github.com/mongodb-js/mongodb-mcp-server',
    tags: ['mongodb', 'database', 'atlas'],
    official: true,
    install: [
      npmOption({
        package: 'mongodb-mcp-server',
        version: '3.1.0',
        env: [
          secretEnv(
            'MDB_MCP_CONNECTION_STRING',
            'Connection string, e.g. mongodb+srv://… (optional — you can also connect from the chat).',
            undefined,
            false
          ),
          optionalEnv('MDB_MCP_READ_ONLY', 'Set to "true" to block changes to your data.', { format: 'boolean' })
        ]
      })
    ]
  },
  {
    id: 'com.neon/mcp',
    officialName: 'com.neon/mcp',
    name: 'Neon',
    description: 'Create and manage Neon serverless Postgres databases.',
    categories: ['databases'],
    publisher: 'Neon',
    repository: 'https://github.com/neondatabase/mcp-server-neon',
    homepage: 'https://neon.com/docs/ai/neon-mcp-server',
    tags: ['postgres', 'database'],
    official: true,
    install: [remoteOption({ url: 'https://mcp.neon.tech/mcp', notes: OAUTH })]
  },
  {
    id: 'com.stripe/mcp',
    officialName: 'com.stripe/mcp',
    name: 'Stripe',
    description: 'Work with your Stripe account: customers, payments, invoices and more.',
    categories: ['finance-commerce'],
    publisher: 'Stripe',
    repository: 'https://github.com/stripe/agent-toolkit',
    homepage: 'https://docs.stripe.com/mcp',
    tags: ['payments', 'billing'],
    official: true,
    install: [remoteOption({ url: 'https://mcp.stripe.com', notes: OAUTH })]
  },
  {
    id: 'com.atlassian/atlassian-mcp-server',
    officialName: 'com.atlassian/atlassian-mcp-server',
    name: 'Atlassian (Jira & Confluence)',
    slug: 'atlassian',
    description: 'Search and update Jira issues and Confluence pages.',
    categories: ['productivity'],
    publisher: 'Atlassian',
    repository: 'https://github.com/atlassian/atlassian-mcp-server',
    homepage: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
    tags: ['jira', 'confluence', 'issues'],
    official: true,
    install: [remoteOption({ url: 'https://mcp.atlassian.com/v2/mcp', notes: OAUTH })]
  },
  {
    id: 'com.figma.mcp/mcp',
    officialName: 'com.figma.mcp/mcp',
    name: 'Figma',
    description: 'Bring Figma designs into Claude to turn them into code.',
    categories: ['design-media', 'developer-tools'],
    publisher: 'Figma',
    repository: 'https://github.com/figma/mcp-server-guide',
    tags: ['design', 'ui'],
    official: true,
    install: [remoteOption({ url: 'https://mcp.figma.com/mcp', notes: OAUTH })]
  },
  {
    id: 'com.canva.mcp/mcp',
    officialName: 'com.canva.mcp/mcp',
    name: 'Canva',
    description: 'Create, search and edit Canva designs.',
    categories: ['design-media'],
    publisher: 'Canva',
    tags: ['design', 'graphics'],
    official: true,
    install: [remoteOption({ url: 'https://mcp.canva.com/mcp', notes: OAUTH })]
  },
  {
    id: 'com.vercel/vercel-mcp',
    officialName: 'com.vercel/vercel-mcp',
    name: 'Vercel',
    description: 'Check deployments, logs and projects on Vercel.',
    categories: ['cloud-devops'],
    publisher: 'Vercel',
    repository: 'https://github.com/vercel/vercel-mcp-overview',
    tags: ['deployments', 'hosting'],
    official: true,
    install: [remoteOption({ url: 'https://mcp.vercel.com', notes: OAUTH })]
  },
  {
    id: 'com.cloudflare.mcp/mcp',
    officialName: 'com.cloudflare.mcp/mcp',
    name: 'Cloudflare',
    description: 'Cloudflare documentation (no account needed) plus tools for your Cloudflare account.',
    categories: ['cloud-devops', 'knowledge-docs'],
    publisher: 'Cloudflare',
    repository: 'https://github.com/cloudflare/mcp-server-cloudflare',
    tags: ['cloudflare', 'workers', 'documentation'],
    official: true,
    install: [
      remoteOption({ url: 'https://docs.mcp.cloudflare.com/mcp', label: 'Remote (Cloudflare docs)', notes: NO_SIGN_IN }),
      remoteOption({
        id: 'remote-2',
        url: 'https://bindings.mcp.cloudflare.com/mcp',
        label: 'Remote (Workers & storage)',
        notes: OAUTH
      }),
      remoteOption({
        id: 'remote-3',
        url: 'https://observability.mcp.cloudflare.com/mcp',
        label: 'Remote (logs & analytics)',
        notes: OAUTH
      })
    ]
  },
  {
    id: 'co.huggingface/hf-mcp-server',
    officialName: 'co.huggingface/hf-mcp-server',
    name: 'Hugging Face',
    description: 'Search models, datasets and papers on Hugging Face and use thousands of AI apps.',
    categories: ['ai-memory', 'data-analytics'],
    publisher: 'Hugging Face',
    homepage: 'https://huggingface.co/settings/mcp',
    tags: ['models', 'datasets', 'spaces'],
    official: true,
    install: [
      remoteOption({
        url: 'https://huggingface.co/mcp',
        headers: [
          bearer('Hugging Face token (optional — unlocks your private Spaces and higher limits).', {
            required: false,
            helpUrl: 'https://huggingface.co/settings/tokens'
          })
        ],
        notes: 'Works without an account.'
      })
    ]
  },
  {
    id: 'seed:aws-documentation',
    name: 'AWS Documentation',
    slug: 'aws-docs',
    description: 'Search and read the official AWS documentation. No AWS account needed.',
    categories: ['knowledge-docs', 'cloud-devops'],
    publisher: 'AWS Labs',
    repository: 'https://github.com/awslabs/mcp',
    subfolder: 'src/aws-documentation-mcp-server',
    tags: ['aws', 'documentation'],
    official: true,
    install: [
      pypiOption({
        package: 'awslabs.aws-documentation-mcp-server',
        version: '1.2.3',
        env: [
          optionalEnv('FASTMCP_LOG_LEVEL', 'Log level.', { default: 'ERROR' }),
          optionalEnv('AWS_DOCUMENTATION_PARTITION', 'Use "aws-cn" for AWS China documentation.', { default: 'aws' })
        ],
        notes: NO_SIGN_IN
      })
    ]
  },
  {
    id: 'seed:kubernetes',
    name: 'Kubernetes',
    description: 'Inspect and manage Kubernetes clusters with your existing kubeconfig.',
    categories: ['cloud-devops'],
    publisher: 'Flux159',
    repository: 'https://github.com/Flux159/mcp-server-kubernetes',
    tags: ['kubernetes', 'kubectl', 'clusters'],
    install: [
      npmOption({ package: 'mcp-server-kubernetes', version: '4.1.9', notes: 'Uses the clusters configured in your kubeconfig (kubectl).' })
    ],
    extraKeys: ['oci:docker.io/mcp/kubernetes']
  },
  {
    id: 'com.asana.mcp/asana',
    name: 'Asana',
    description: 'Manage Asana tasks, projects and goals.',
    categories: ['productivity'],
    publisher: 'Asana',
    tags: ['tasks', 'project-management'],
    official: true,
    install: [remoteOption({ url: 'https://mcp.asana.com/v2/mcp', notes: OAUTH })]
  },
  {
    id: 'com.slack.mcp/slack',
    name: 'Slack',
    description: 'Search and send Slack messages and read channels. Your workspace admin may need to approve it.',
    categories: ['communication'],
    publisher: 'Slack',
    tags: ['chat', 'messaging'],
    official: true,
    install: [remoteOption({ url: 'https://mcp.slack.com/mcp', notes: OAUTH })]
  },
  {
    id: 'com.zapier/mcp',
    officialName: 'com.zapier/mcp',
    name: 'Zapier',
    description: 'Connect Claude to thousands of apps through your Zapier actions.',
    categories: ['productivity'],
    publisher: 'Zapier',
    repository: 'https://github.com/zapier/zapier-mcp',
    homepage: 'https://docs.zapier.com/mcp/home',
    tags: ['automation', 'integrations'],
    official: true,
    install: [remoteOption({ url: 'https://mcp.zapier.com/api/v1/connect', notes: OAUTH })]
  },
  {
    id: 'com.monday/monday.com',
    officialName: 'com.monday/monday.com',
    name: 'monday.com',
    slug: 'monday',
    description: 'Work with your monday.com boards, items and updates.',
    categories: ['productivity'],
    publisher: 'monday.com',
    tags: ['boards', 'project-management'],
    official: true,
    install: [remoteOption({ url: 'https://mcp.monday.com/mcp', notes: OAUTH })]
  },
  {
    id: 'com.airtable/mcp',
    officialName: 'com.airtable/mcp',
    name: 'Airtable',
    description: 'Read and update your Airtable bases and records.',
    categories: ['productivity', 'databases'],
    publisher: 'Airtable',
    tags: ['spreadsheets', 'database'],
    official: true,
    install: [remoteOption({ url: 'https://mcp.airtable.com/mcp', notes: OAUTH })]
  },
  {
    id: 'com.hubspot.mcp/hubspot',
    name: 'HubSpot',
    description: 'Look up and update HubSpot CRM contacts, companies and deals.',
    categories: ['productivity'],
    publisher: 'HubSpot',
    tags: ['crm', 'sales'],
    official: true,
    install: [remoteOption({ url: 'https://mcp.hubspot.com/anthropic', notes: OAUTH })]
  }
]

/** Beginner-friendly picks shown on the home screen (ids from SEED_SERVERS), in display order. */
export const FEATURED_IDS: readonly string[] = [
  'io.github.modelcontextprotocol/server-filesystem',
  'io.github.modelcontextprotocol/server-fetch',
  'io.github.modelcontextprotocol/server-memory',
  'io.github.modelcontextprotocol/server-sequential-thinking',
  'io.github.modelcontextprotocol/server-time',
  'io.github.modelcontextprotocol/server-git',
  'io.github.microsoft/playwright-mcp',
  'io.github.ChromeDevTools/chrome-devtools-mcp',
  'io.github.upstash/context7',
  'cognitionai/deepwiki',
  'com.microsoft/microsoft-learn-mcp',
  'io.github.github/github-mcp-server',
  'com.notion/mcp',
  'app.linear/linear',
  'io.github.getsentry/sentry-mcp',
  'io.github.brave/brave-search-mcp-server'
]

/** Matching keys of a curated server. */
function seedKeys(def: SeedServer): { keys: string[]; softKeys: string[] } {
  const keys: string[] = []
  const softKeys: string[] = []
  if (def.officialName) keys.push(nameKey(def.officialName))
  for (const o of def.install) {
    if (o.kind === 'remote' && o.url) {
      const k = remoteKey(o.url)
      if (k) keys.push(k)
    } else if (o.package) {
      const type = o.kind === 'docker' ? 'oci' : o.kind
      const k = packageKey(type, o.package)
      if (k) keys.push(k)
    }
  }
  const repo = parseRepoUrl(def.repository, def.subfolder)
  if (repo) {
    keys.push(repoKey(repo))
    softKeys.push(repoBaseKey(repo))
  }
  keys.push(...(def.extraKeys ?? []))
  return { keys: uniq(keys), softKeys: uniq(softKeys) }
}

/** Curated servers as source entries. */
export function seedEntries(): SourceEntry[] {
  return SEED_SERVERS.map((def) => {
    const { keys, softKeys } = seedKeys(def)
    const entry: SourceEntry = {
      source: 'seed',
      sourceId: def.id,
      keys,
      softKeys,
      nameExplicit: true,
      server: makeServer('seed', {
        id: def.id,
        name: def.name,
        slug: def.slug,
        description: def.description,
        categories: def.categories,
        publisher: def.publisher,
        repository: def.repository,
        homepage: def.homepage,
        iconUrl: def.iconUrl,
        tags: def.tags,
        official: def.official,
        verified: true,
        install: def.install
      })
    }
    if (def.officialName) entry.guardName = def.officialName
    return entry
  })
}

/** Check helper used by tests: every placeholder in a curated option refers to a declared spec. */
export function undeclaredPlaceholders(option: InstallOption): string[] {
  const declared = new Set<string>([...(option.argsSpec ?? []).map((a: ArgSpec) => `arg:${a.name}`), ...option.env.map((e) => e.name)])
  const text = [option.url ?? '', ...(option.args ?? [])].join(' ')
  return [...text.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1]).filter((p) => !declared.has(p))
}
