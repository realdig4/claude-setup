import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigDocError, detectFormatting, editConfigDoc, getAt, jsonEqual, readConfigDoc } from '@core/targets/configDoc'
import { withSandbox } from '../helpers/sandbox'

describe('configDoc', () => {
  it('edits JSONC without losing comments, tabs or CRLF line endings', () =>
    withSandbox(async (sb) => {
      const file = join(sb.root, 'mcp.json')
      const original = '{\r\n\t// my servers\r\n\t"servers": {\r\n\t\t"a": { "type": "stdio", "command": "x" } // keep me\r\n\t},\r\n\t"inputs": [ { "id": "k", "type": "promptString" } ]\r\n}\r\n'
      await writeFile(file, original)
      await editConfigDoc(file, 'jsonc', [{ path: ['servers', 'b'], value: { type: 'http', url: 'https://x/mcp' } }])
      const text = await readFile(file, 'utf8')
      expect(text).toContain('// my servers')
      expect(text).toContain('// keep me')
      expect(text).toContain('"inputs": [ { "id": "k", "type": "promptString" } ]')
      expect(text).toContain('\t\t"b": {\r\n')
      expect(text.replace(/\r\n/g, '')).not.toContain('\n')
      const doc = await readConfigDoc(file, 'jsonc')
      expect(getAt(doc.data, ['servers', 'b', 'url'])).toBe('https://x/mcp')
      expect(getAt(doc.data, ['servers', 'a', 'command'])).toBe('x')
    }))

  it('creates the file and missing parents, and keeps big numbers intact in strict JSON', () =>
    withSandbox(async (sb) => {
      const file = join(sb.root, 'deep', 'dir', 'c.json')
      await editConfigDoc(file, 'json', [{ path: ['projects', 'C:/x', 'mcpServers', 'fs'], value: { command: 'npx' } }])
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ projects: { 'C:/x': { mcpServers: { fs: { command: 'npx' } } } } })

      const big = join(sb.root, 'big.json')
      await writeFile(big, '{\n  "userID": 12345678901234567890,\n  "mcpServers": {}\n}\n')
      await editConfigDoc(big, 'json', [{ path: ['mcpServers', 'a'], value: { command: 'x' } }])
      expect(await readFile(big, 'utf8')).toContain('"userID": 12345678901234567890')
    }))

  it('deleting something that does not exist is a no-op (no write)', () =>
    withSandbox(async (sb) => {
      const file = join(sb.root, 'c.json')
      await writeFile(file, '{"projects":{}}')
      await editConfigDoc(file, 'json', [{ path: ['projects', 'C:/none', 'mcpServers', 'x'], value: undefined }])
      expect(await readFile(file, 'utf8')).toBe('{"projects":{}}')
    }))

  it('refuses invalid strict JSON with a line number and leaves the file alone', () =>
    withSandbox(async (sb) => {
      const file = join(sb.root, 'claude.json')
      const broken = '{\n  "mcpServers": {\n    "a": { "command": "x", }\n  }\n}\n'
      await writeFile(file, broken)
      const doc = await readConfigDoc(file, 'json')
      expect(doc.valid).toBe(false)
      expect(doc.error).toMatch(/line 3/)
      await expect(editConfigDoc(file, 'json', [{ path: ['mcpServers', 'b'], value: { command: 'y' } }])).rejects.toBeInstanceOf(ConfigDocError)
      expect(await readFile(file, 'utf8')).toBe(broken)
      // The same text is acceptable JSONC (trailing comma).
      expect((await readConfigDoc(file, 'jsonc')).valid).toBe(true)
    }))

  it('refuses to write into a non-object parent', () =>
    withSandbox(async (sb) => {
      const file = join(sb.root, 'c.json')
      await writeFile(file, '{ "mcpServers": [] }')
      await expect(editConfigDoc(file, 'json', [{ path: ['mcpServers', 'a'], value: {} }])).rejects.toMatchObject({ kind: 'structure' })
      await writeFile(file, '[]')
      expect((await readConfigDoc(file, 'json')).valid).toBe(false)
    }))

  it('handles a UTF-8 BOM, an empty file and a missing file', () =>
    withSandbox(async (sb) => {
      const bom = join(sb.root, 'bom.json')
      await writeFile(bom, '\uFEFF{"preferences":{"a":1}}')
      expect((await readConfigDoc(bom, 'json')).data).toEqual({ preferences: { a: 1 } })
      await editConfigDoc(bom, 'json', [{ path: ['mcpServers', 'x'], value: { command: 'c' } }])
      const text = await readFile(bom, 'utf8')
      expect(text.charCodeAt(0)).not.toBe(0xfeff)
      expect(JSON.parse(text)).toEqual({ preferences: { a: 1 }, mcpServers: { x: { command: 'c' } } })

      const empty = join(sb.root, 'empty.json')
      await writeFile(empty, '   \n')
      expect(await readConfigDoc(empty, 'json')).toMatchObject({ exists: true, valid: true, data: {} })
      expect(await readConfigDoc(join(sb.root, 'missing.json'), 'json')).toMatchObject({ exists: false, valid: true })
    }))

  it('serializes concurrent edits to the same file', () =>
    withSandbox(async (sb) => {
      const file = join(sb.root, 'c.json')
      await mkdir(sb.root, { recursive: true })
      await Promise.all(Array.from({ length: 8 }, (_, i) => editConfigDoc(file, 'json', [{ path: ['mcpServers', `s${i}`], value: { command: `c${i}` } }])))
      const doc = await readConfigDoc(file, 'json')
      expect(Object.keys(doc.data.mcpServers as object).sort()).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'])
    }))

  it('edits a symlinked config at its target so the link survives', () =>
    withSandbox(async (sb) => {
      const real = join(sb.root, 'dotfiles', 'claude.json')
      const link = join(sb.root, 'link.json')
      await mkdir(join(sb.root, 'dotfiles'), { recursive: true })
      await writeFile(real, '{"keep":1}')
      try {
        await symlink(real, link, 'file')
      } catch {
        return // creating symlinks needs Developer Mode / admin on Windows
      }
      await editConfigDoc(link, 'json', [{ path: ['mcpServers', 'a'], value: { command: 'x' } }])
      expect((await lstat(link)).isSymbolicLink()).toBe(true)
      expect(JSON.parse(await readFile(real, 'utf8'))).toEqual({ keep: 1, mcpServers: { a: { command: 'x' } } })
    }))

  it('detects formatting and compares JSON structurally', () => {
    expect(detectFormatting('{\n    "a": 1\n}')).toMatchObject({ insertSpaces: true, tabSize: 4, eol: '\n' })
    expect(detectFormatting('{\r\n\t"a": 1\r\n}')).toMatchObject({ insertSpaces: false, eol: '\r\n' })
    expect(jsonEqual({ a: [1, { b: 2 }], c: undefined }, { a: [1, { b: 2 }] })).toBe(true)
    expect(jsonEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
  })
})
