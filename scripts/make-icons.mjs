#!/usr/bin/env node
/**
 * Renders Claude Setup's icons with no dependencies (signed-distance shapes + a tiny PNG/ICO encoder):
 *   build/icon.png              1024×1024  macOS/Linux app icon (inset rounded square with shadow)
 *   build/icon.ico              16–256 px  Windows app icon (PNG-compressed entries, each rendered at its size)
 *   resources/icon.png          512×512    Linux window / notification icon
 *   resources/tray.png          32×32      Windows/Linux tray icon (colour)
 *   resources/trayTemplate.png  22×22      macOS menu-bar template (black glyph) + @2x (44×44)
 * Design: warm terracotta → amber gradient, white "sliders" glyph. Run: node scripts/make-icons.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── PNG encoder ──────────────────────────────────────────────────────────────
const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** Encode RGBA pixels (Uint8Array, width*height*4) as PNG, choosing a filter per row. */
function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  const prev = new Uint8Array(stride)
  const candidate = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride)
    let bestType = 0
    let bestScore = Infinity
    let best = null
    for (const type of [0, 1, 2]) {
      let score = 0
      for (let i = 0; i < stride; i++) {
        const left = i >= 4 ? row[i - 4] : 0
        const up = y > 0 ? prev[i] : 0
        const v = type === 0 ? row[i] : type === 1 ? (row[i] - left) & 0xff : (row[i] - up) & 0xff
        candidate[i] = v
        score += v < 128 ? v : 256 - v
      }
      if (score < bestScore) {
        bestScore = score
        bestType = type
        best = Uint8Array.from(candidate)
      }
    }
    raw[y * (stride + 1)] = bestType
    raw.set(best, y * (stride + 1) + 1)
    prev.set(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** ICO container with PNG-compressed images (Windows Vista and later). */
function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + 16 * images.length
  for (const { size, png } of images) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e[2] = 0
    e[3] = 0
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

// ── Shapes (signed distances in pixels) ──────────────────────────────────────
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const coverage = (d) => clamp01(0.5 - d)

function sdRoundRect(px, py, cx, cy, half, r) {
  const qx = Math.abs(px - cx) - (half - r)
  const qy = Math.abs(py - cy) - (half - r)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}

function sdCapsule(px, py, ax, ay, bx, by, r) {
  const pax = px - ax
  const pay = py - ay
  const bax = bx - ax
  const bay = by - ay
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay))
  return Math.hypot(pax - bax * h, pay - bay * h) - r
}

const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r

// ── Palette ──────────────────────────────────────────────────────────────────
const TERRACOTTA = [196, 94, 58]
const AMBER = [242, 171, 64]
const mix = (a, b, t) => a + (b - a) * t

/**
 * Sliders glyph coverage at (px, py) for a square of side `side` centred on (cx, cy):
 * three tracks with knobs, the track cut away around each knob.
 */
function glyphCoverage(px, py, cx, cy, side) {
  // Small sizes get relatively thicker strokes and more spacing so the glyph stays readable.
  const small = side < 40
  const track = Math.max(side * 0.058, 1.1) / 2
  const knob = Math.max(side * (small ? 0.082 : 0.076), 1.45)
  const gap = Math.max(side * 0.034, 0.6)
  const spread = small ? 0.25 : 0.21
  const x0 = cx - side * (small ? 0.31 : 0.29)
  const x1 = cx + side * (small ? 0.31 : 0.29)
  const rows = [
    { y: cy - side * spread, at: 0.28 },
    { y: cy, at: 0.72 },
    { y: cy + side * spread, at: 0.46 }
  ]
  let a = 0
  for (const row of rows) {
    const kx = x0 + (x1 - x0) * row.at
    const t = coverage(sdCapsule(px, py, x0, row.y, x1, row.y, track))
    const cut = coverage(sdCircle(px, py, kx, row.y, knob + gap))
    const k = coverage(sdCircle(px, py, kx, row.y, knob))
    a = Math.max(a, t * (1 - cut), k)
  }
  return a
}

/**
 * Render one icon.
 * variant 'app'      : gradient rounded square (inset `margin`), optional shadow, white glyph
 * variant 'template' : black glyph only (macOS menu bar)
 */
function render(size, { variant = 'app', margin = 0.0, radius = 0.225, shadow = false } = {}) {
  const px = new Uint8Array(size * size * 4)
  const side = size * (1 - 2 * margin)
  const half = side / 2
  const c = size / 2
  const r = side * radius
  const glyphSide = variant === 'template' ? size * 1.08 : side
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = x + 0.5
      const sy = y + 0.5
      const i = (y * size + x) * 4
      if (variant === 'template') {
        const g = glyphCoverage(sx, sy, c, c, glyphSide)
        px[i] = 0
        px[i + 1] = 0
        px[i + 2] = 0
        px[i + 3] = Math.round(g * 255)
        continue
      }
      const dSquare = sdRoundRect(sx, sy, c, c, half, r)
      const sq = coverage(dSquare)
      // Diagonal gradient (top-left terracotta → bottom-right amber) with a soft top highlight.
      const t = clamp01(((sx - (c - half)) + (sy - (c - half))) / (2 * side))
      const tt = t * t * (3 - 2 * t)
      let red = mix(TERRACOTTA[0], AMBER[0], tt)
      let green = mix(TERRACOTTA[1], AMBER[1], tt)
      let blue = mix(TERRACOTTA[2], AMBER[2], tt)
      const hl = clamp01(1 - Math.hypot(sx - (c - half * 0.45), sy - (c - half * 0.75)) / (side * 0.75)) * 0.1
      red = mix(red, 255, hl)
      green = mix(green, 255, hl)
      blue = mix(blue, 255, hl)
      const g = glyphCoverage(sx, sy, c, c, glyphSide) * sq
      red = mix(red, 255, g)
      green = mix(green, 255, g)
      blue = mix(blue, 255, g)
      let alpha = sq
      if (shadow && sq < 1) {
        // Soft drop shadow below the tile (macOS style), composited under it.
        const ds = sdRoundRect(sx, sy - size * 0.012, c, c, half, r)
        const blur = size * 0.022
        const sh = 0.28 * clamp01(1 - (ds + blur * 0.2) / blur) ** 2
        const outA = sq + sh * (1 - sq)
        if (outA > 0) {
          red = (red * sq) / outA
          green = (green * sq) / outA
          blue = (blue * sq) / outA
        }
        alpha = outA
      }
      px[i] = Math.round(red)
      px[i + 1] = Math.round(green)
      px[i + 2] = Math.round(blue)
      px[i + 3] = Math.round(alpha * 255)
    }
  }
  return encodePng(size, size, px)
}

function write(rel, data) {
  const file = join(ROOT, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
  console.log(`wrote ${rel} (${data.length.toLocaleString()} bytes)`)
}

// macOS/Linux app icon: 824 px tile on a 1024 canvas (Apple grid), with shadow.
write('build/icon.png', render(1024, { margin: 0.1, radius: 0.2237, shadow: true }))
// Windows icon: nearly full-bleed tile, every size rendered natively for crisp small icons.
write('build/icon.ico', encodeIco([16, 20, 24, 32, 40, 48, 64, 256].map((size) => ({ size, png: render(size, { margin: size <= 32 ? 0.02 : 0.04, radius: 0.2 }) }))))
write('resources/icon.png', render(512, { margin: 0.04, radius: 0.2 }))
write('resources/tray.png', render(32, { margin: 0.03, radius: 0.22 }))
write('resources/trayTemplate.png', render(22, { variant: 'template' }))
write('resources/trayTemplate@2x.png', render(44, { variant: 'template' }))
