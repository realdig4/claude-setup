#!/usr/bin/env node
'use strict'
// npm / development entry for the `claude-setup-mcp` stdio MCP server. The real code is the bundled out/main/mcp.js.
// Never write to stdout here: it carries the MCP JSON-RPC stream.
const path = require('node:path')

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 12)) {
  process.stderr.write(`claude-setup-mcp needs Node.js 22.12 or newer (you have ${process.versions.node}). Get it from https://nodejs.org\n`)
  process.exit(1)
}

const entry = path.join(__dirname, '..', 'out', 'main', 'mcp.js')
try {
  require(entry)
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(entry)) {
    process.stderr.write('claude-setup-mcp has not been built yet. Run "npm run build" in the project folder first.\n')
    process.exit(1)
  }
  throw err
}
