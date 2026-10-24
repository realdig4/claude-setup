/**
 * Small, dependency-free color helpers used by Monogram/ServerIcon and provider avatars.
 * Pure functions (no DOM) so they can be unit-tested in Node.
 */

/** FNV-1a 32-bit hash of a string (stable across runs and platforms). */
export function hashString(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

const WORD_SPLIT = /[\s\-_./:@]+/

/**
 * One or two uppercase letters that represent a name.
 * - "brave-search" → "BS", "Model Context Protocol" → "MC"
 * - "GitHub" → "GH" (inner capitals), "notion" → "N", "42crunch" → "4"
 */
export function initials(text: string, max: 1 | 2 = 2): string {
  const clean = text.trim().replace(/^@/, '')
  if (!clean) return '?'
  const words = clean.split(WORD_SPLIT).filter(Boolean)
  let letters: string
  if (words.length >= 2) {
    letters = words
      .slice(0, 2)
      .map((w) => firstChar(w))
      .join('')
  } else {
    const word = words[0] ?? clean
    const capitals = word.match(/\p{Lu}/gu) ?? []
    if (capitals.length >= 2 && /^\p{Lu}/u.test(word)) letters = capitals.slice(0, 2).join('')
    else letters = firstChar(word)
  }
  return letters.toUpperCase().slice(0, max)
}

function firstChar(word: string): string {
  return Array.from(word)[0] ?? ''
}

/** Hues (OKLCH degrees) that look good as monogram backgrounds in both themes. */
export const MONOGRAM_HUES: readonly number[] = [28, 48, 75, 110, 150, 172, 195, 222, 250, 275, 300, 330, 352]

export interface MonogramPalette {
  /** CSS background (a soft two-stop gradient). */
  background: string
  /** CSS text color with sufficient contrast on the background. */
  color: string
}

/** Deterministic, pleasant gradient for a seed string (e.g. a server id). */
export function monogramPalette(seed: string): MonogramPalette {
  const hash = hashString(seed)
  const hue = MONOGRAM_HUES[hash % MONOGRAM_HUES.length] ?? 28
  const shift = ((hash >>> 8) % 24) - 12
  const from = `oklch(0.66 0.13 ${hue})`
  const to = `oklch(0.56 0.14 ${(hue + 18 + shift + 360) % 360})`
  return { background: `linear-gradient(140deg, ${from}, ${to})`, color: '#ffffff' }
}

/** Parse "#rgb", "#rrggbb" (with or without #) into 0..255 channels. */
export function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const value = hex.trim().replace(/^#/, '')
  const full = value.length === 3 ? Array.from(value, (c) => c + c).join('') : value
  if (!/^[0-9a-f]{6}$/i.test(full)) return null
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  }
}

/** WCAG relative luminance (0 = black, 1 = white) of an sRGB hex color. */
export function relativeLuminance(hex: string): number | null {
  const rgb = parseHex(hex)
  if (!rgb) return null
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b)
}

/** WCAG contrast ratio between two hex colors (1..21). */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  if (la === null || lb === null) return null
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** Black-ish or white text, whichever reads better on the given background color. */
export function readableTextColor(background: string): string {
  const dark = '#1f1a17'
  const light = '#ffffff'
  const onLight = contrastRatio(background, dark)
  const onDark = contrastRatio(background, light)
  if (onLight === null || onDark === null) return light
  return onDark >= onLight ? light : dark
}

/** Palette for a brand color (e.g. ProviderPreset.color): solid background + readable text. */
export function brandPalette(color: string): MonogramPalette {
  if (!parseHex(color)) return monogramPalette(color)
  return { background: color, color: readableTextColor(color) }
}
