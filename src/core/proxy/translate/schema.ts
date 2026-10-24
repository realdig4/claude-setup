/**
 * Tool input-schema cleanup for OpenAI-compatible upstreams.
 *
 * Claude Code's tool schemas are JSON Schema 2020-12 (`$schema`, `exclusiveMinimum`, `additionalProperties`…);
 * MCP tools often add `$defs`/`$ref` (Pydantic) or type arrays. The walk is schema-aware: it only treats
 * values of schema keywords as schemas, so a property that happens to be *named* `$schema` survives.
 *
 *  - 'default': drop `$schema` / `$comment`, guarantee an object root with `properties`.
 *  - 'gemini':  reduce to the OpenAPI 3.0 subset Gemini accepts — inline `$ref`, `oneOf`→`anyOf`,
 *               `const`→`enum`, type arrays → `nullable`/`anyOf`, exclusive bounds → inclusive, drop
 *               unsupported keywords and formats.
 */
import type { SchemaFlavor } from '../quirks'
import { isObject, type JsonObject } from '../wire'

const SCHEMA_VALUED = new Set([
  'items',
  'additionalItems',
  'contains',
  'additionalProperties',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedProperties',
  'unevaluatedItems'
])
const SCHEMA_ARRAYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
const DROPPED = new Set(['$schema', '$comment'])

const GEMINI_KEYWORDS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'maxItems',
  'minItems',
  'properties',
  'required',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'anyOf',
  'propertyOrdering',
  'default',
  'items',
  'minimum',
  'maximum'
])
const GEMINI_STRING_FORMATS = new Set(['enum', 'date-time'])
const GEMINI_NUMBER_FORMATS = new Set(['float', 'double', 'int32', 'int64'])
const MAX_DEPTH = 24
const MAX_REF_EXPANSIONS = 4

function mapValues(obj: JsonObject, fn: (value: unknown) => unknown): JsonObject {
  const out: JsonObject = {}
  for (const [key, value] of Object.entries(obj)) out[key] = fn(value)
  return out
}

function cleanDefault(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(cleanDefault)
  if (!isObject(node)) return node
  const out: JsonObject = {}
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED.has(key)) continue
    if (SCHEMA_VALUED.has(key)) out[key] = cleanDefault(value)
    else if (SCHEMA_ARRAYS.has(key)) out[key] = Array.isArray(value) ? value.map(cleanDefault) : value
    else if (SCHEMA_MAPS.has(key)) out[key] = isObject(value) ? mapValues(value, cleanDefault) : value
    else out[key] = structuredClone(value)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini flavor
// ─────────────────────────────────────────────────────────────────────────────

function resolveRef(ref: string, defs: JsonObject): JsonObject | undefined {
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref)
  if (!match) return undefined
  const name = decodeURIComponent(match[1].replace(/~1/g, '/').replace(/~0/g, '~'))
  const target = defs[name]
  return isObject(target) ? target : undefined
}

function mergeAllOf(node: JsonObject): JsonObject {
  const parts = Array.isArray(node.allOf) ? node.allOf.filter(isObject) : []
  const merged: JsonObject = { ...node }
  delete merged.allOf
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (key === 'properties' && isObject(value)) {
        merged.properties = { ...(isObject(merged.properties) ? merged.properties : {}), ...value }
      } else if (key === 'required' && Array.isArray(value)) {
        merged.required = [...new Set([...(Array.isArray(merged.required) ? merged.required : []), ...value])]
      } else if (merged[key] === undefined) merged[key] = value
    }
  }
  return merged
}

function normalizeTypes(node: JsonObject): JsonObject {
  const n = { ...node }
  if (Array.isArray(n.oneOf)) {
    if (!Array.isArray(n.anyOf)) n.anyOf = n.oneOf
    delete n.oneOf
  }
  if ('const' in n && n.enum === undefined) n.enum = [n.const]
  if (Array.isArray(n.type)) {
    const types = n.type.filter((t): t is string => typeof t === 'string')
    const nonNull = types.filter((t) => t !== 'null')
    if (types.includes('null')) n.nullable = true
    if (nonNull.length === 1) n.type = nonNull[0]
    else {
      delete n.type
      if (nonNull.length > 1 && !Array.isArray(n.anyOf)) n.anyOf = nonNull.map((type) => ({ type }))
    }
  }
  if (typeof n.exclusiveMinimum === 'number' && n.minimum === undefined) {
    n.minimum = n.type === 'integer' ? Math.floor(n.exclusiveMinimum) + 1 : n.exclusiveMinimum
  }
  if (typeof n.exclusiveMaximum === 'number' && n.maximum === undefined) {
    n.maximum = n.type === 'integer' ? Math.ceil(n.exclusiveMaximum) - 1 : n.exclusiveMaximum
  }
  return n
}

function geminiNode(input: unknown, defs: JsonObject, depth: number, refs: number): JsonObject {
  if (!isObject(input) || depth > MAX_DEPTH) return {}
  let node: JsonObject = input
  if (typeof node.$ref === 'string') {
    const { $ref, ...rest } = node
    const target = refs < MAX_REF_EXPANSIONS ? resolveRef($ref as string, defs) : undefined
    if (!target) return { type: 'object', ...(typeof rest.description === 'string' ? { description: rest.description } : {}) }
    return geminiNode({ ...target, ...rest }, defs, depth + 1, refs + 1)
  }
  if (Array.isArray(node.allOf)) node = mergeAllOf(node)
  node = normalizeTypes(node)

  const out: JsonObject = {}
  for (const [key, value] of Object.entries(node)) {
    if (!GEMINI_KEYWORDS.has(key)) continue
    if (key === 'properties') {
      if (isObject(value)) out.properties = mapValues(value, (v) => geminiNode(v, defs, depth + 1, refs))
    } else if (key === 'items') {
      out.items = geminiNode(Array.isArray(value) ? value[0] : value, defs, depth + 1, refs)
    } else if (key === 'anyOf') {
      if (Array.isArray(value)) out.anyOf = value.map((v) => geminiNode(v, defs, depth + 1, refs))
    } else if (key === 'format') {
      const numeric = node.type === 'number' || node.type === 'integer'
      const allowed = node.type === 'string' ? GEMINI_STRING_FORMATS : numeric ? GEMINI_NUMBER_FORMATS : null
      if (typeof value === 'string' && allowed?.has(value)) out.format = value
    } else if (key === 'enum') {
      if (Array.isArray(value) && (node.type === undefined || node.type === 'string')) {
        out.enum = value.filter((v) => v !== null).map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
        if (node.type === undefined) out.type = 'string'
      }
    } else if (key === 'type') {
      if (typeof value === 'string' && value !== 'null') out.type = value
    } else {
      out[key] = structuredClone(value)
    }
  }

  if (Array.isArray(out.anyOf)) {
    const list = out.anyOf as JsonObject[]
    const nonNull = list.filter((s) => s.type !== 'null' && Object.keys(s).length > 0)
    if (nonNull.length !== list.length) out.nullable = true
    if (nonNull.length === 1) {
      delete out.anyOf
      for (const [k, v] of Object.entries(nonNull[0])) if (out[k] === undefined) out[k] = v
    } else if (nonNull.length === 0) delete out.anyOf
    else out.anyOf = nonNull
  }
  if (out.anyOf && out.type) delete out.type
  if (Array.isArray(out.required)) {
    const props = isObject(out.properties) ? out.properties : {}
    const required = out.required.filter((r): r is string => typeof r === 'string' && r in props)
    if (required.length) out.required = required
    else delete out.required
  }
  return out
}

function collectDefs(root: JsonObject): JsonObject {
  return {
    ...(isObject(root.definitions) ? root.definitions : {}),
    ...(isObject(root.$defs) ? root.$defs : {})
  }
}

/** A cleaned copy of an Anthropic tool `input_schema`, valid as OpenAI function `parameters`. */
export function cleanToolSchema(schema: unknown, flavor: SchemaFlavor = 'default'): JsonObject {
  const root = isObject(schema) ? schema : {}
  const out = flavor === 'gemini' ? geminiNode(root, collectDefs(root), 0, 0) : (cleanDefault(root) as JsonObject)
  if (out.type === undefined && !Array.isArray(out.anyOf)) out.type = 'object'
  if (out.type === 'object' && !isObject(out.properties)) out.properties = {}
  return out
}
