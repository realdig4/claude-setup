/**
 * Mock: CatalogApi — a hand-curated set of real, popular MCP servers with realistic install options,
 * env specs and registry metadata (shapes match src/shared/types.ts).
 */
import type { CatalogApi } from '@shared/api'
import type { CatalogQuery, CatalogServer, CatalogSource, CatalogSourceStatus, CatalogStats, CategoryInfo, InstallOption } from '@shared/types'
import { currentSettings } from './misc'
import { clone, daysAgo, emit, hoursAgo, log, sleep } from './runtime'

const MCP_REPO = 'https://github.com/modelcontextprotocol/servers'
const MCP_ICON = 'https://github.com/modelcontextprotocol.png?size=96'
const gh = (org: string): string => `https://github.com/${org}.png?size=96`

const npm = (pkg: string, extra: Partial<InstallOption> = {}): InstallOption => ({
  id: 'npm',
  kind: 'npm',
  label: 'Node.js (npx)',
  package: pkg,
  runtime: 'node',
  transport: 'stdio',
  env: [],
  ...extra
})

const pypi = (pkg: string, extra: Partial<InstallOption> = {}): InstallOption => ({
  id: 'pypi',
  kind: 'pypi',
  label: 'Python (uvx)',
  package: pkg,
  runtime: 'uv',
  transport: 'stdio',
  env: [],
  ...extra
})

const docker = (image: string, extra: Partial<InstallOption> = {}): InstallOption => ({
  id: 'docker',
  kind: 'docker',
  label: 'Docker',
  package: image,
  runtime: 'docker',
  transport: 'stdio',
  env: [],
  ...extra
})

const remote = (url: string, label: string, extra: Partial<InstallOption> = {}): InstallOption => ({
  id: 'remote',
  kind: 'remote',
  label,
  runtime: 'none',
  transport: 'http',
  url,
  env: [],
  ...extra
})

export const CATEGORY_LABELS: Record<string, string> = {
  'developer-tools': 'Developer tools',
  files: 'Files & documents',
  browser: 'Browser & web',
  search: 'Search & research',
  databases: 'Databases',
  productivity: 'Productivity',
  communication: 'Communication',
  cloud: 'Cloud & DevOps',
  monitoring: 'Monitoring',
  knowledge: 'Memory & notes',
  design: 'Design',
  finance: 'Finance & payments',
  ai: 'AI & models',
  documentation: 'Documentation',
  utilities: 'Utilities'
}

/** ~30 real servers spanning every category. */
export const CATALOG: CatalogServer[] = [
  {
    id: 'io.github.modelcontextprotocol/filesystem',
    name: 'Filesystem',
    slug: 'filesystem',
    description: 'Let Claude read, search and edit files in the folders you choose.',
    longDescription:
      'Secure file operations with access limited to the folders you allow. Claude can read and write files, create folders, move files and search by name or content.',
    publisher: 'Model Context Protocol',
    repository: MCP_REPO,
    homepage: `${MCP_REPO}/tree/main/src/filesystem`,
    iconUrl: MCP_ICON,
    categories: ['files'],
    tags: ['files', 'local', 'reference'],
    sources: ['official', 'github', 'docker', 'seed'],
    official: true,
    verified: true,
    popularity: 97,
    stars: 79_400,
    updatedAt: daysAgo(6),
    version: '2026.10.1',
    install: [
      npm('@modelcontextprotocol/server-filesystem', {
        version: '2026.10.1',
        argsSpec: [{ name: 'directories', description: 'Folders Claude may access', required: true, repeatable: true, format: 'directory' }]
      }),
      docker('mcp/filesystem', {
        argsSpec: [{ name: 'directories', description: 'Folders Claude may access', required: true, repeatable: true, format: 'directory' }],
        notes: 'Folders are mounted under /projects inside the container.'
      })
    ]
  },
  {
    id: 'io.github.github/github-mcp-server',
    name: 'GitHub',
    slug: 'github',
    description: 'Work with repositories, issues, pull requests and code reviews on GitHub.',
    longDescription: 'GitHub’s official server. Browse code, manage issues and pull requests, review changes and check CI runs.',
    publisher: 'GitHub',
    repository: 'https://github.com/github/github-mcp-server',
    iconUrl: gh('github'),
    categories: ['developer-tools'],
    tags: ['git', 'issues', 'pull requests', 'code review'],
    sources: ['official', 'github', 'anthropic', 'docker', 'seed'],
    official: true,
    verified: true,
    popularity: 99,
    stars: 24_800,
    updatedAt: daysAgo(2),
    version: '2.0.3',
    install: [
      remote('https://api.githubcopilot.com/mcp/', 'Hosted by GitHub (recommended)', {
        headers: [
          {
            name: 'Authorization',
            description: 'Your GitHub personal access token, written as "Bearer <token>"',
            required: true,
            secret: true,
            placeholder: 'Bearer ghp_…',
            helpUrl: 'https://github.com/settings/personal-access-tokens/new'
          }
        ],
        notes: 'Nothing to install on your computer.'
      }),
      docker('ghcr.io/github/github-mcp-server', {
        version: '2.0.3',
        env: [
          {
            name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
            description: 'A personal access token with access to your repositories',
            required: true,
            secret: true,
            placeholder: 'ghp_…',
            helpUrl: 'https://github.com/settings/personal-access-tokens/new'
          },
          {
            name: 'GITHUB_READ_ONLY',
            description: 'Only allow reading — Claude can’t change anything on GitHub',
            required: false,
            secret: false,
            format: 'boolean'
          },
          {
            name: 'GITHUB_TOOLSETS',
            description: 'Which groups of tools to turn on (comma-separated)',
            required: false,
            secret: false,
            placeholder: 'repos,issues,pull_requests'
          }
        ]
      })
    ]
  },
  {
    id: 'com.microsoft/playwright-mcp',
    name: 'Playwright',
    slug: 'playwright',
    description: 'Let Claude open web pages, click, type and take screenshots in a real browser.',
    publisher: 'Microsoft',
    repository: 'https://github.com/microsoft/playwright-mcp',
    iconUrl: gh('microsoft'),
    categories: ['browser', 'developer-tools'],
    tags: ['browser', 'testing', 'automation', 'screenshots'],
    sources: ['official', 'github', 'docker', 'cline', 'seed'],
    official: true,
    verified: true,
    popularity: 95,
    stars: 22_100,
    updatedAt: daysAgo(4),
    version: '0.0.48',
    install: [npm('@playwright/mcp', { version: 'latest', notes: 'Downloads a browser the first time it runs.' })]
  },
  {
    id: 'io.github.upstash/context7',
    name: 'Context7',
    slug: 'context7',
    description: 'Up-to-date, version-specific documentation for thousands of libraries, right in your prompt.',
    publisher: 'Upstash',
    repository: 'https://github.com/upstash/context7',
    homepage: 'https://context7.com',
    iconUrl: gh('upstash'),
    categories: ['documentation', 'developer-tools'],
    tags: ['docs', 'libraries', 'coding'],
    sources: ['official', 'github', 'smithery', 'cline', 'seed'],
    official: true,
    verified: true,
    popularity: 96,
    stars: 38_900,
    updatedAt: daysAgo(1),
    version: '4.4.4',
    install: [
      remote('https://mcp.context7.com/mcp', 'Hosted (recommended)', {
        headers: [
          { name: 'CONTEXT7_API_KEY', description: 'Optional key for higher rate limits', required: false, secret: true, helpUrl: 'https://context7.com/dashboard' }
        ]
      }),
      npm('@upstash/context7-mcp', { version: '4.4.4' })
    ]
  },
  {
    id: 'com.notion/mcp',
    name: 'Notion',
    slug: 'notion',
    description: 'Search, read and update your Notion pages and databases.',
    publisher: 'Notion',
    homepage: 'https://developers.notion.com/docs/mcp',
    iconUrl: gh('makenotion'),
    categories: ['productivity', 'knowledge'],
    tags: ['notes', 'wiki', 'docs'],
    sources: ['anthropic', 'official', 'seed'],
    official: true,
    verified: true,
    popularity: 92,
    updatedAt: daysAgo(9),
    version: '1.0.0',
    install: [remote('https://mcp.notion.com/mcp', 'Hosted by Notion', { notes: 'You’ll sign in to Notion in your browser the first time.' })]
  },
  {
    id: 'io.github.brave/brave-search-mcp-server',
    name: 'Brave Search',
    slug: 'brave-search',
    description: 'Private web, news and image search powered by the Brave Search API.',
    publisher: 'Brave',
    repository: 'https://github.com/brave/brave-search-mcp-server',
    iconUrl: gh('brave'),
    categories: ['search'],
    tags: ['web search', 'news', 'images'],
    sources: ['official', 'github', 'docker', 'seed'],
    official: true,
    verified: true,
    popularity: 90,
    stars: 1_450,
    updatedAt: daysAgo(12),
    version: '2.1.3',
    install: [
      npm('@brave/brave-search-mcp-server', {
        version: '2.1.3',
        env: [
          {
            name: 'BRAVE_API_KEY',
            description: 'Your Brave Search API key (the free plan works)',
            required: true,
            secret: true,
            placeholder: 'BSA…',
            helpUrl: 'https://brave.com/search/api/'
          }
        ]
      })
    ]
  },
  {
    id: 'io.github.crystaldba/postgres-mcp',
    name: 'Postgres',
    slug: 'postgres',
    description: 'Explore schemas, run safe read-only queries and get index tuning advice for PostgreSQL.',
    publisher: 'Crystal DBA',
    repository: 'https://github.com/crystaldba/postgres-mcp',
    categories: ['databases'],
    tags: ['sql', 'postgresql', 'database'],
    sources: ['official', 'github', 'docker', 'seed'],
    verified: true,
    popularity: 84,
    stars: 1_720,
    updatedAt: daysAgo(20),
    version: '0.4.2',
    install: [
      pypi('postgres-mcp', {
        version: '0.4.2',
        args: ['postgres-mcp', '--access-mode=restricted'],
        env: [
          {
            name: 'DATABASE_URI',
            description: 'Connection string, e.g. postgresql://user:password@localhost:5432/mydb',
            required: true,
            secret: true,
            placeholder: 'postgresql://…',
            format: 'url'
          }
        ]
      }),
      docker('crystaldba/postgres-mcp', {
        env: [{ name: 'DATABASE_URI', description: 'Connection string', required: true, secret: true, placeholder: 'postgresql://…', format: 'url' }]
      })
    ]
  },
  {
    id: 'io.github.designcomputer/mysql_mcp_server',
    name: 'MySQL',
    slug: 'mysql',
    description: 'Let Claude list tables, read data and run SQL queries on a MySQL database.',
    publisher: 'designcomputer',
    repository: 'https://github.com/designcomputer/mysql_mcp_server',
    categories: ['databases'],
    tags: ['sql', 'mysql', 'database'],
    sources: ['github', 'smithery', 'awesome', 'seed'],
    popularity: 68,
    stars: 1_050,
    updatedAt: daysAgo(26),
    version: '0.2.2',
    install: [
      pypi('mysql-mcp-server', {
        version: '0.2.2',
        args: ['--from', 'mysql-mcp-server', 'mysql_mcp_server'],
        env: [
          { name: 'MYSQL_HOST', description: 'Where the database runs', required: true, secret: false, default: 'localhost' },
          { name: 'MYSQL_PORT', description: 'Usually 3306', required: false, secret: false, format: 'number', default: '3306' },
          { name: 'MYSQL_USER', description: 'A database user (a read-only user is safest)', required: true, secret: false },
          { name: 'MYSQL_PASSWORD', description: 'That user’s password', required: true, secret: true },
          { name: 'MYSQL_DATABASE', description: 'The database Claude may use', required: true, secret: false }
        ]
      })
    ]
  },
  {
    id: 'com.slack/mcp',
    name: 'Slack',
    slug: 'slack',
    description: 'Read channels, search messages and post updates in your Slack workspace.',
    publisher: 'Slack',
    homepage: 'https://api.slack.com',
    iconUrl: gh('slackapi'),
    categories: ['communication'],
    tags: ['chat', 'messages', 'team'],
    sources: ['anthropic', 'seed'],
    official: true,
    verified: true,
    popularity: 88,
    updatedAt: daysAgo(15),
    version: '1.0.0',
    install: [remote('https://mcp.slack.com/mcp', 'Hosted by Slack', { notes: 'Sign in with Slack the first time you use it.' })]
  },
  {
    id: 'io.sentry/mcp',
    name: 'Sentry',
    slug: 'sentry',
    description: 'Look up errors, stack traces and releases from Sentry while you debug.',
    publisher: 'Sentry',
    repository: 'https://github.com/getsentry/sentry-mcp',
    iconUrl: gh('getsentry'),
    categories: ['monitoring', 'developer-tools'],
    tags: ['errors', 'debugging', 'observability'],
    sources: ['anthropic', 'official', 'github', 'seed'],
    official: true,
    verified: true,
    popularity: 83,
    stars: 640,
    updatedAt: daysAgo(3),
    version: '0.21.0',
    install: [remote('https://mcp.sentry.dev/mcp', 'Hosted by Sentry')]
  },
  {
    id: 'io.github.modelcontextprotocol/memory',
    name: 'Memory',
    slug: 'memory',
    description: 'Give Claude a long-term memory: a local knowledge graph of people, projects and facts.',
    publisher: 'Model Context Protocol',
    repository: MCP_REPO,
    iconUrl: MCP_ICON,
    categories: ['knowledge'],
    tags: ['memory', 'knowledge graph', 'local'],
    sources: ['official', 'github', 'docker', 'seed'],
    official: true,
    verified: true,
    popularity: 89,
    stars: 79_400,
    updatedAt: daysAgo(6),
    version: '2026.10.1',
    install: [
      npm('@modelcontextprotocol/server-memory', {
        version: '2026.10.1',
        env: [{ name: 'MEMORY_FILE_PATH', description: 'Where to keep the memory file', required: false, secret: false, format: 'path', placeholder: 'memory.jsonl' }]
      })
    ]
  },
  {
    id: 'io.github.modelcontextprotocol/fetch',
    name: 'Fetch',
    slug: 'fetch',
    description: 'Fetch any web page and turn it into clean Markdown for Claude to read.',
    publisher: 'Model Context Protocol',
    repository: MCP_REPO,
    iconUrl: MCP_ICON,
    categories: ['browser', 'utilities'],
    tags: ['web', 'markdown', 'http'],
    sources: ['official', 'github', 'docker', 'seed'],
    official: true,
    verified: true,
    popularity: 87,
    stars: 79_400,
    updatedAt: daysAgo(6),
    version: '2026.10.1',
    install: [pypi('mcp-server-fetch', { version: '2026.10.1' }), docker('mcp/fetch')]
  },
  {
    id: 'io.github.modelcontextprotocol/time',
    name: 'Time',
    slug: 'time',
    description: 'Current time and time-zone conversions, so Claude always knows what time it is.',
    publisher: 'Model Context Protocol',
    repository: MCP_REPO,
    iconUrl: MCP_ICON,
    categories: ['utilities'],
    tags: ['time', 'timezone'],
    sources: ['official', 'github', 'docker', 'seed'],
    official: true,
    verified: true,
    popularity: 78,
    stars: 79_400,
    updatedAt: daysAgo(6),
    version: '2026.10.1',
    install: [
      pypi('mcp-server-time', {
        argsSpec: [{ name: 'local-timezone', description: 'Your time zone, e.g. Europe/Berlin', required: false, format: 'string' }]
      })
    ]
  },
  {
    id: 'io.github.modelcontextprotocol/sequentialthinking',
    name: 'Sequential Thinking',
    slug: 'sequential-thinking',
    description: 'Helps Claude break hard problems into steps and revise its plan as it goes.',
    publisher: 'Model Context Protocol',
    repository: MCP_REPO,
    iconUrl: MCP_ICON,
    categories: ['ai'],
    tags: ['reasoning', 'planning'],
    sources: ['official', 'github', 'docker', 'seed'],
    official: true,
    verified: true,
    popularity: 86,
    stars: 79_400,
    updatedAt: daysAgo(6),
    version: '2026.10.1',
    install: [npm('@modelcontextprotocol/server-sequential-thinking')]
  },
  {
    id: 'app.linear/mcp',
    name: 'Linear',
    slug: 'linear',
    description: 'Create and update Linear issues, projects and cycles from a conversation.',
    publisher: 'Linear',
    homepage: 'https://linear.app/docs/mcp',
    iconUrl: gh('linear'),
    categories: ['productivity', 'developer-tools'],
    tags: ['issues', 'project management'],
    sources: ['anthropic', 'official', 'seed'],
    official: true,
    verified: true,
    popularity: 85,
    updatedAt: daysAgo(10),
    version: '1.0.0',
    install: [remote('https://mcp.linear.app/mcp', 'Hosted by Linear')]
  },
  {
    id: 'com.figma/mcp',
    name: 'Figma',
    slug: 'figma',
    description: 'Bring Figma designs, components and variables into Claude for design-to-code work.',
    publisher: 'Figma',
    homepage: 'https://help.figma.com',
    iconUrl: gh('figma'),
    categories: ['design'],
    tags: ['design', 'ui', 'frontend'],
    sources: ['anthropic', 'official', 'seed'],
    official: true,
    verified: true,
    popularity: 82,
    updatedAt: daysAgo(8),
    version: '1.0.0',
    install: [remote('https://mcp.figma.com/mcp', 'Hosted by Figma')]
  },
  {
    id: 'com.supabase/mcp',
    name: 'Supabase',
    slug: 'supabase',
    description: 'Manage Supabase projects: tables, migrations, edge functions and logs.',
    publisher: 'Supabase',
    repository: 'https://github.com/supabase-community/supabase-mcp',
    iconUrl: gh('supabase'),
    categories: ['databases', 'cloud'],
    tags: ['postgres', 'backend', 'auth'],
    sources: ['anthropic', 'official', 'github', 'seed'],
    official: true,
    verified: true,
    popularity: 86,
    stars: 2_300,
    updatedAt: daysAgo(5),
    version: '0.6.1',
    install: [
      remote('https://mcp.supabase.com/mcp', 'Hosted by Supabase (recommended)'),
      npm('@supabase/mcp-server-supabase', {
        env: [
          {
            name: 'SUPABASE_ACCESS_TOKEN',
            description: 'Personal access token from your Supabase account',
            required: true,
            secret: true,
            placeholder: 'sbp_…',
            helpUrl: 'https://supabase.com/dashboard/account/tokens'
          }
        ],
        argsSpec: [{ name: 'project-ref', description: 'Limit access to one project (optional)', required: false }]
      })
    ]
  },
  {
    id: 'com.stripe/mcp',
    name: 'Stripe',
    slug: 'stripe',
    description: 'Look up customers, payments and subscriptions, and create payment links.',
    publisher: 'Stripe',
    homepage: 'https://docs.stripe.com/mcp',
    iconUrl: gh('stripe'),
    categories: ['finance'],
    tags: ['payments', 'billing'],
    sources: ['anthropic', 'official', 'seed'],
    official: true,
    verified: true,
    popularity: 80,
    updatedAt: daysAgo(11),
    version: '0.3.0',
    install: [
      remote('https://mcp.stripe.com', 'Hosted by Stripe (recommended)'),
      npm('@stripe/mcp', {
        args: ['-y', '@stripe/mcp', '--tools=all'],
        env: [
          {
            name: 'STRIPE_SECRET_KEY',
            description: 'A restricted API key is recommended',
            required: true,
            secret: true,
            placeholder: 'rk_live_…',
            helpUrl: 'https://dashboard.stripe.com/apikeys'
          }
        ]
      })
    ]
  },
  {
    id: 'io.github.ChromeDevTools/chrome-devtools-mcp',
    name: 'Chrome DevTools',
    slug: 'chrome-devtools',
    description: 'Inspect, debug and profile pages in a live Chrome browser.',
    publisher: 'Google Chrome',
    repository: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    iconUrl: gh('ChromeDevTools'),
    categories: ['browser', 'developer-tools'],
    tags: ['chrome', 'performance', 'debugging'],
    sources: ['official', 'github', 'seed'],
    official: true,
    verified: true,
    popularity: 88,
    stars: 15_600,
    updatedAt: daysAgo(2),
    version: '0.9.0',
    install: [npm('chrome-devtools-mcp', { version: 'latest', notes: 'Needs Google Chrome installed.' })]
  },
  {
    id: 'com.atlassian/atlassian-mcp-server',
    name: 'Atlassian',
    slug: 'atlassian',
    description: 'Search and update Jira issues and Confluence pages.',
    publisher: 'Atlassian',
    iconUrl: gh('atlassian'),
    categories: ['productivity'],
    tags: ['jira', 'confluence', 'issues', 'wiki'],
    sources: ['anthropic', 'official', 'seed'],
    official: true,
    verified: true,
    popularity: 81,
    updatedAt: daysAgo(14),
    version: '1.0.0',
    install: [remote('https://mcp.atlassian.com/v1/sse', 'Hosted by Atlassian', { transport: 'sse' })]
  },
  {
    id: 'com.cloudflare/docs',
    name: 'Cloudflare Docs',
    slug: 'cloudflare-docs',
    description: 'Search Cloudflare’s developer documentation — no account needed.',
    publisher: 'Cloudflare',
    iconUrl: gh('cloudflare'),
    categories: ['documentation', 'cloud'],
    tags: ['docs', 'workers', 'cdn'],
    sources: ['anthropic', 'official', 'seed'],
    official: true,
    verified: true,
    popularity: 70,
    updatedAt: daysAgo(18),
    version: '1.0.0',
    install: [remote('https://docs.mcp.cloudflare.com/mcp', 'Hosted by Cloudflare')]
  },
  {
    id: 'io.github.modelcontextprotocol/sqlite',
    name: 'SQLite',
    slug: 'sqlite',
    description: 'Query and analyze a local SQLite database file.',
    publisher: 'Model Context Protocol',
    repository: MCP_REPO,
    categories: ['databases'],
    tags: ['sql', 'local', 'analytics'],
    sources: ['official', 'docker', 'seed'],
    verified: true,
    popularity: 72,
    updatedAt: daysAgo(40),
    version: '2025.4.25',
    install: [pypi('mcp-server-sqlite', { argsSpec: [{ name: 'db-path', description: 'Path to the .db file', required: true, format: 'path' }] })]
  },
  {
    id: 'ai.exa/exa',
    name: 'Exa Search',
    slug: 'exa',
    description: 'AI-native web search and page crawling for research tasks.',
    publisher: 'Exa',
    repository: 'https://github.com/exa-labs/exa-mcp-server',
    iconUrl: gh('exa-labs'),
    categories: ['search'],
    tags: ['web search', 'research', 'crawl'],
    sources: ['official', 'github', 'smithery', 'seed'],
    official: true,
    verified: true,
    popularity: 79,
    stars: 3_100,
    updatedAt: daysAgo(7),
    version: '3.1.0',
    install: [
      remote('https://mcp.exa.ai/mcp', 'Hosted by Exa (recommended)'),
      npm('exa-mcp-server', {
        env: [{ name: 'EXA_API_KEY', description: 'Your Exa API key', required: true, secret: true, helpUrl: 'https://dashboard.exa.ai/api-keys' }]
      })
    ]
  },
  {
    id: 'io.github.MarkusPfundstein/mcp-obsidian',
    name: 'Obsidian',
    slug: 'obsidian',
    description: 'Read and search notes in your Obsidian vault (uses the Local REST API plugin).',
    publisher: 'Markus Pfundstein',
    repository: 'https://github.com/MarkusPfundstein/mcp-obsidian',
    categories: ['knowledge', 'productivity'],
    tags: ['notes', 'markdown', 'local'],
    sources: ['github', 'smithery', 'cline', 'awesome', 'seed'],
    popularity: 74,
    stars: 2_400,
    updatedAt: daysAgo(33),
    version: '0.2.2',
    install: [
      pypi('mcp-obsidian', {
        env: [
          { name: 'OBSIDIAN_API_KEY', description: 'From the Local REST API plugin settings in Obsidian', required: true, secret: true },
          { name: 'OBSIDIAN_HOST', description: 'Usually 127.0.0.1', required: false, secret: false, default: '127.0.0.1' }
        ]
      })
    ]
  },
  {
    id: 'io.github.modelcontextprotocol/git',
    name: 'Git',
    slug: 'git',
    description: 'Read history, diffs and branches of local Git repositories.',
    publisher: 'Model Context Protocol',
    repository: MCP_REPO,
    iconUrl: MCP_ICON,
    categories: ['developer-tools'],
    tags: ['git', 'version control', 'local'],
    sources: ['official', 'github', 'docker', 'seed'],
    official: true,
    verified: true,
    popularity: 76,
    stars: 79_400,
    updatedAt: daysAgo(6),
    version: '2026.10.1',
    install: [pypi('mcp-server-git', { argsSpec: [{ name: 'repository', description: 'Path to a Git repository', required: false, format: 'directory' }] })]
  },
  {
    id: 'io.github.containers/kubernetes-mcp-server',
    name: 'Kubernetes',
    slug: 'kubernetes',
    description: 'Inspect pods, logs and resources in your Kubernetes clusters.',
    publisher: 'Red Hat',
    repository: 'https://github.com/containers/kubernetes-mcp-server',
    iconUrl: gh('containers'),
    categories: ['cloud', 'developer-tools'],
    tags: ['k8s', 'devops', 'containers'],
    sources: ['official', 'github', 'docker', 'seed'],
    verified: true,
    popularity: 73,
    stars: 980,
    updatedAt: daysAgo(9),
    version: '0.0.53',
    install: [npm('kubernetes-mcp-server', { notes: 'Uses your current kubeconfig context.' })]
  },
  {
    id: 'co.huggingface/hf-mcp-server',
    name: 'Hugging Face',
    slug: 'hugging-face',
    description: 'Search models, datasets and Spaces on the Hugging Face Hub.',
    publisher: 'Hugging Face',
    iconUrl: gh('huggingface'),
    categories: ['ai'],
    tags: ['models', 'datasets', 'machine learning'],
    sources: ['anthropic', 'official', 'seed'],
    official: true,
    verified: true,
    popularity: 77,
    updatedAt: daysAgo(4),
    version: '1.0.0',
    install: [remote('https://huggingface.co/mcp', 'Hosted by Hugging Face')]
  },
  {
    id: 'com.microsoft/learn',
    name: 'Microsoft Learn',
    slug: 'microsoft-learn',
    description: 'Trusted, up-to-date answers from official Microsoft documentation.',
    publisher: 'Microsoft',
    iconUrl: gh('microsoft'),
    categories: ['documentation'],
    tags: ['docs', 'azure', '.net'],
    sources: ['official', 'github', 'seed'],
    official: true,
    verified: true,
    popularity: 71,
    updatedAt: daysAgo(13),
    version: '1.0.0',
    install: [remote('https://learn.microsoft.com/api/mcp', 'Hosted by Microsoft')]
  },
  {
    id: 'io.github.modelcontextprotocol/everything',
    name: 'Everything (test server)',
    slug: 'everything',
    description: 'A reference server that exercises every MCP feature — handy for testing your setup.',
    publisher: 'Model Context Protocol',
    repository: MCP_REPO,
    iconUrl: MCP_ICON,
    categories: ['developer-tools'],
    tags: ['testing', 'reference'],
    sources: ['official', 'github', 'seed'],
    official: true,
    verified: true,
    popularity: 60,
    stars: 79_400,
    updatedAt: daysAgo(6),
    version: '2026.10.1',
    install: [npm('@modelcontextprotocol/server-everything')]
  },
  {
    id: 'io.github.home-assistant/mcp',
    name: 'Home Assistant',
    slug: 'home-assistant',
    description: 'Control lights, sensors and automations in your smart home.',
    publisher: 'Home Assistant',
    repository: 'https://github.com/home-assistant/core',
    categories: ['utilities'],
    tags: ['smart home', 'iot'],
    sources: ['awesome', 'seed'],
    popularity: 58,
    updatedAt: daysAgo(21),
    install: [
      remote('http://homeassistant.local:8123/api/mcp', 'Your Home Assistant server', {
        headers: [
          {
            name: 'Authorization',
            description: 'A long-lived access token, written as "Bearer <token>"',
            required: true,
            secret: true,
            placeholder: 'Bearer eyJ…'
          }
        ],
        notes: 'Turn on the “Model Context Protocol Server” integration in Home Assistant first.'
      })
    ]
  }
]

const FEATURED = ['filesystem', 'github', 'context7', 'playwright', 'notion', 'brave-search', 'memory', 'fetch']

const SOURCE_COUNTS: Record<CatalogSource, number> = {
  official: 49_088,
  anthropic: 327,
  github: 604,
  smithery: 20_775,
  docker: 317,
  cline: 199,
  awesome: 4_610,
  glama: 0,
  pulsemcp: 0,
  seed: CATALOG.length
}

let refreshing = false
let lastRefreshed = hoursAgo(3)

export function findCatalogServer(id: string): CatalogServer | undefined {
  return CATALOG.find((s) => s.id === id || s.slug === id)
}

/** True when the server can be used without any required secret (in at least one install option). */
export function needsNoKey(server: CatalogServer): boolean {
  return server.install.some(
    (opt) => !opt.env.some((e) => e.required && e.secret) && !(opt.headers ?? []).some((h) => h.required && h.secret)
  )
}

function relevance(server: CatalogServer, words: string[]): number {
  if (words.length === 0) return server.popularity ?? 0
  let score = 0
  const name = server.name.toLowerCase()
  for (const word of words) {
    if (name === word || server.slug === word) score += 100
    else if (name.startsWith(word)) score += 60
    else if (name.includes(word)) score += 40
    if (server.tags.some((t) => t.toLowerCase().includes(word))) score += 20
    if (server.description.toLowerCase().includes(word)) score += 10
  }
  return score + (server.popularity ?? 0) / 10
}

function matchesQuery(server: CatalogServer, words: string[]): boolean {
  const haystack = [server.name, server.slug, server.description, server.publisher ?? '', ...server.tags, ...server.categories]
    .join(' ')
    .toLowerCase()
  return words.every((w) => haystack.includes(w))
}

function sourceStatuses(): CatalogSourceStatus[] {
  const enabled = currentSettings().sources
  return (Object.keys(SOURCE_COUNTS) as CatalogSource[]).map((source) => ({
    source,
    enabled: enabled[source],
    count: enabled[source] ? SOURCE_COUNTS[source] : 0,
    lastFetched: enabled[source] ? lastRefreshed : undefined,
    error: source === 'glama' && enabled.glama ? 'Add a Glama API key in Settings to use this source.' : undefined
  }))
}

function stats(): CatalogStats {
  return { total: 57_906, sources: sourceStatuses(), lastRefreshed, refreshing }
}

export const catalogApi: CatalogApi = {
  async search(query: CatalogQuery) {
    const words = (query.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    let items = CATALOG.filter((s) => matchesQuery(s, words))
    if (query.category) items = items.filter((s) => s.categories.includes(query.category as string))
    if (query.source) items = items.filter((s) => s.sources.includes(query.source as CatalogSource))
    if (query.remoteOnly) items = items.filter((s) => s.install.some((o) => o.kind === 'remote'))
    if (query.noKeyRequired) items = items.filter(needsNoKey)
    const sort = query.sort ?? (words.length ? 'relevance' : 'popular')
    items = [...items].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'updated') return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
      if (sort === 'popular') return (b.popularity ?? 0) - (a.popularity ?? 0)
      return relevance(b, words) - relevance(a, words)
    })
    const offset = Math.max(0, query.offset ?? 0)
    const limit = Math.max(1, Math.min(100, query.limit ?? 24))
    return clone({ items: items.slice(offset, offset + limit), total: items.length, offset, limit })
  },

  async get(id) {
    return clone(findCatalogServer(id) ?? null)
  },

  async categories(): Promise<CategoryInfo[]> {
    const counts = new Map<string, number>()
    for (const server of CATALOG) for (const c of server.categories) counts.set(c, (counts.get(c) ?? 0) + 1)
    return [...counts.entries()]
      .map(([id, count]) => ({ id, label: CATEGORY_LABELS[id] ?? id, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  },

  async featured() {
    return clone(FEATURED.map((slug) => findCatalogServer(slug)).filter((s): s is CatalogServer => !!s))
  },

  async stats() {
    return clone(stats())
  },

  async refresh() {
    if (refreshing) return clone(stats())
    refreshing = true
    emit('catalog', { phase: 'start', message: 'Refreshing the tool catalog…' })
    log('info', 'catalog', 'Refresh started')
    const enabled = sourceStatuses().filter((s) => s.enabled)
    for (const source of enabled) {
      await sleep(350)
      emit('catalog', { phase: 'source', source: source.source, count: source.count, message: `Fetched ${source.source}` })
    }
    refreshing = false
    lastRefreshed = new Date().toISOString()
    emit('catalog', { phase: 'done', count: stats().total, message: 'Catalog is up to date' })
    log('info', 'catalog', 'Refresh finished')
    return clone(stats())
  }
}
