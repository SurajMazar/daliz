/**
 * Theme engine primitives shared by the API (validation) and the web app (preview + apply).
 *
 * Tenants only ever supply a handful of validated hex colors. Every CSS variable the UI
 * consumes is *derived* here, so tenant input can never inject arbitrary CSS, and every
 * derived pair is checked against WCAG 2.2 contrast thresholds.
 */
import { z } from 'zod';

export type Rgb = readonly [number, number, number];

export const HEX_COLOR = /^#[0-9a-f]{6}$/;

export const hexColorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HEX_COLOR, 'Use a 6-digit hex color such as #1f6feb');

export const themeModeSchema = z.enum(['light', 'dark', 'system']);
export type ThemeMode = z.infer<typeof themeModeSchema>;

export const themeInputSchema = z.object({
  primary: hexColorSchema,
  secondary: hexColorSchema,
  accent: hexColorSchema,
  background: hexColorSchema,
  foreground: hexColorSchema,
  defaultMode: themeModeSchema,
  radius: z.enum(['none', 'sm', 'md', 'lg']),
});
export type ThemeInput = z.infer<typeof themeInputSchema>;

export const DEFAULT_THEME: ThemeInput = {
  primary: '#2753d7',
  secondary: '#eef2ff',
  accent: '#f3f0ff',
  background: '#ffffff',
  foreground: '#0f172a',
  defaultMode: 'system',
  radius: 'md',
};

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

export function hexToRgb(hex: string): Rgb {
  const m = HEX_COLOR.exec(hex.toLowerCase());
  if (!m) throw new Error(`Invalid hex color: ${hex}`);
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function luminance(color: string | Rgb): number {
  const [r, g, b] = typeof color === 'string' ? hexToRgb(color) : color;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colors, 1..21. */
export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb([h, s, l]: [number, number, number]): Rgb {
  const hue = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(hue + 1 / 3) * 255, f(hue) * 255, f(hue - 1 / 3) * 255];
}

/** Linear mix in sRGB. weight=0 returns a, weight=1 returns b. */
export function mix(a: string, b: string, weight: number): string {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  return rgbToHex([
    ra[0] + (rb[0] - ra[0]) * weight,
    ra[1] + (rb[1] - ra[1]) * weight,
    ra[2] + (rb[2] - ra[2]) * weight,
  ]);
}

const WHITE = '#ffffff';
const BLACK = '#000000';

/** Picks whichever of near-white / near-black reads best on top of `bg`. */
export function readableForeground(bg: string): string {
  return contrastRatio(bg, WHITE) >= contrastRatio(bg, '#0b0b0f') ? WHITE : '#0b0b0f';
}

/**
 * Shifts a color's lightness (keeping hue and saturation) until it reaches `target`
 * contrast against `against`. Returns the closest color to the original that passes.
 */
export function ensureContrast(color: string, against: string, target: number): string {
  if (contrastRatio(color, against) >= target) return color;
  const [h, s, l] = rgbToHsl(hexToRgb(color));
  const darker = luminance(against) > 0.18;
  for (let step = 1; step <= 100; step++) {
    const nl = darker ? l - step * 0.01 : l + step * 0.01;
    if (nl < 0 || nl > 1) break;
    const candidate = rgbToHex(hslToRgb([h, s, nl]));
    if (contrastRatio(candidate, against) >= target) return candidate;
  }
  return darker ? BLACK : WHITE;
}

// ---------------------------------------------------------------------------
// WCAG checks
// ---------------------------------------------------------------------------

export const WCAG_AA_TEXT = 4.5;
export const WCAG_AA_LARGE_TEXT = 3;
export const WCAG_AA_UI = 3;

export interface ContrastCheck {
  id: string;
  label: string;
  foreground: string;
  background: string;
  ratio: number;
  required: number;
  passes: boolean;
  /** Errors block saving; warnings are shown but allowed. */
  severity: 'error' | 'warning';
}

function check(
  id: string,
  label: string,
  foreground: string,
  background: string,
  required: number,
  severity: 'error' | 'warning',
): ContrastCheck {
  const ratio = Math.round(contrastRatio(foreground, background) * 100) / 100;
  return { id, label, foreground, background, ratio, required, passes: ratio >= required, severity };
}

export function checkThemeContrast(input: ThemeInput): ContrastCheck[] {
  const t = deriveThemeTokens(input, 'light');
  const d = deriveThemeTokens(input, 'dark');
  return [
    check('text-on-background', 'Body text on background', t.foreground, t.background, WCAG_AA_TEXT, 'error'),
    check('muted-text', 'Secondary text on background', t.mutedForeground, t.background, WCAG_AA_TEXT, 'error'),
    check('button-text', 'Primary button label', t.primaryForeground, t.primary, WCAG_AA_TEXT, 'error'),
    check('primary-on-background', 'Primary color against background', t.primary, t.background, WCAG_AA_UI, 'error'),
    check('primary-link', 'Primary color as link text', t.primary, t.background, WCAG_AA_TEXT, 'warning'),
    check('primary-on-white', 'Primary color against white', t.primary, WHITE, WCAG_AA_UI, 'warning'),
    check('primary-on-black', 'Primary color against black', t.primary, BLACK, WCAG_AA_UI, 'warning'),
    check('secondary-text', 'Secondary button label', t.secondaryForeground, t.secondary, WCAG_AA_TEXT, 'error'),
    check('accent-text', 'Text on accent', t.accentForeground, t.accent, WCAG_AA_TEXT, 'error'),
    check('dark-text', 'Dark mode: text on background', d.foreground, d.background, WCAG_AA_TEXT, 'error'),
    check('dark-primary', 'Dark mode: primary against background', d.primary, d.background, WCAG_AA_UI, 'error'),
    check('dark-button', 'Dark mode: primary button label', d.primaryForeground, d.primary, WCAG_AA_TEXT, 'error'),
  ];
}

export function themeHasBlockingIssues(input: ThemeInput): boolean {
  return checkThemeContrast(input).some((c) => c.severity === 'error' && !c.passes);
}

// ---------------------------------------------------------------------------
// Token derivation
// ---------------------------------------------------------------------------

export interface ThemeTokens {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  accent: string;
  accentForeground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarBorder: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  destructive: string;
  destructiveForeground: string;
  success: string;
  warning: string;
}

export const RADIUS_VALUES: Record<ThemeInput['radius'], string> = {
  none: '0rem',
  sm: '0.375rem',
  md: '0.625rem',
  lg: '0.875rem',
};

export function deriveThemeTokens(input: ThemeInput, mode: 'light' | 'dark'): ThemeTokens {
  if (mode === 'light') {
    const bg = input.background;
    const fg = input.foreground;
    const mutedFg = ensureContrast(mix(fg, bg, 0.4), bg, WCAG_AA_TEXT);
    return {
      background: bg,
      foreground: fg,
      card: bg,
      cardForeground: fg,
      popover: bg,
      popoverForeground: fg,
      primary: input.primary,
      primaryForeground: readableForeground(input.primary),
      secondary: input.secondary,
      secondaryForeground: ensureContrast(fg, input.secondary, WCAG_AA_TEXT),
      accent: input.accent,
      accentForeground: ensureContrast(fg, input.accent, WCAG_AA_TEXT),
      muted: mix(bg, fg, 0.05),
      mutedForeground: mutedFg,
      border: mix(bg, fg, 0.12),
      input: mix(bg, fg, 0.16),
      ring: input.primary,
      sidebar: mix(bg, input.primary, 0.03),
      sidebarForeground: fg,
      sidebarBorder: mix(bg, fg, 0.1),
      sidebarAccent: mix(bg, input.primary, 0.09),
      sidebarAccentForeground: ensureContrast(fg, mix(bg, input.primary, 0.09), WCAG_AA_TEXT),
      destructive: '#c4231c',
      destructiveForeground: WHITE,
      success: '#157f3d',
      warning: '#9a5b00',
    };
  }

  // Dark mode is derived: a deep neutral tinted with the brand hue.
  const [h] = rgbToHsl(hexToRgb(input.primary));
  const bg = rgbToHex(hslToRgb([h, 0.14, 0.075]));
  const fg = rgbToHex(hslToRgb([h, 0.1, 0.95]));
  const surface = rgbToHex(hslToRgb([h, 0.12, 0.11]));
  const primary = ensureContrast(input.primary, bg, 4.5);
  const secondary = rgbToHex(hslToRgb([h, 0.14, 0.18]));
  const accent = rgbToHex(hslToRgb([h, 0.18, 0.2]));
  return {
    background: bg,
    foreground: fg,
    card: surface,
    cardForeground: fg,
    popover: surface,
    popoverForeground: fg,
    primary,
    primaryForeground: readableForeground(primary),
    secondary,
    secondaryForeground: fg,
    accent,
    accentForeground: fg,
    muted: rgbToHex(hslToRgb([h, 0.12, 0.15])),
    mutedForeground: ensureContrast(mix(fg, bg, 0.35), bg, WCAG_AA_TEXT),
    border: rgbToHex(hslToRgb([h, 0.12, 0.2])),
    input: rgbToHex(hslToRgb([h, 0.12, 0.24])),
    ring: primary,
    sidebar: rgbToHex(hslToRgb([h, 0.14, 0.095])),
    sidebarForeground: fg,
    sidebarBorder: rgbToHex(hslToRgb([h, 0.12, 0.17])),
    sidebarAccent: rgbToHex(hslToRgb([h, 0.16, 0.17])),
    sidebarAccentForeground: fg,
    destructive: '#f0544c',
    destructiveForeground: '#0b0b0f',
    success: '#4ad07f',
    warning: '#f0b240',
  };
}

const TOKEN_TO_CSS_VAR: Record<keyof ThemeTokens, string> = {
  background: '--background',
  foreground: '--foreground',
  card: '--card',
  cardForeground: '--card-foreground',
  popover: '--popover',
  popoverForeground: '--popover-foreground',
  primary: '--primary',
  primaryForeground: '--primary-foreground',
  secondary: '--secondary',
  secondaryForeground: '--secondary-foreground',
  accent: '--accent',
  accentForeground: '--accent-foreground',
  muted: '--muted',
  mutedForeground: '--muted-foreground',
  border: '--border',
  input: '--input',
  ring: '--ring',
  sidebar: '--sidebar',
  sidebarForeground: '--sidebar-foreground',
  sidebarBorder: '--sidebar-border',
  sidebarAccent: '--sidebar-accent',
  sidebarAccentForeground: '--sidebar-accent-foreground',
  destructive: '--destructive',
  destructiveForeground: '--destructive-foreground',
  success: '--success',
  warning: '--warning',
};

/** CSS custom properties for a mode. Values are always validated hex strings. */
export function themeCssVariables(input: ThemeInput, mode: 'light' | 'dark'): Record<string, string> {
  const tokens = deriveThemeTokens(input, mode);
  const vars: Record<string, string> = { '--radius': RADIUS_VALUES[input.radius] };
  for (const [k, v] of Object.entries(tokens) as [keyof ThemeTokens, string][]) {
    if (!HEX_COLOR.test(v)) throw new Error(`Derived token ${k} is not a hex color`);
    vars[TOKEN_TO_CSS_VAR[k]] = v;
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Suggest a theme from an extracted logo palette (Color Thief output)
// ---------------------------------------------------------------------------

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Turns a dominant-color palette into a WCAG-compliant theme suggestion. The palette is
 * ordered by dominance. Near-white, near-black and grey swatches are ignored when choosing
 * brand colors, since logos usually sit on white/transparent backgrounds.
 */
export function suggestThemeFromPalette(palette: readonly Rgb[]): ThemeInput {
  const candidates = palette
    .map((rgb, index) => {
      const [h, s, l] = rgbToHsl(rgb);
      return { hex: rgbToHex(rgb), h, s, l, index };
    })
    .filter((c) => c.s >= 0.2 && c.l >= 0.12 && c.l <= 0.9);

  if (candidates.length === 0) {
    const first = palette[0];
    if (!first) return DEFAULT_THEME;
    // Monochrome logo: keep the neutral look but ensure contrast.
    const primary = ensureContrast(rgbToHex(first), WHITE, WCAG_AA_TEXT);
    return {
      ...DEFAULT_THEME,
      primary,
      secondary: mix(WHITE, primary, 0.06),
      accent: mix(WHITE, primary, 0.1),
      foreground: mix('#0b0b0f', primary, 0.08),
    };
  }

  // Prefer dominant colors, weighted towards saturated ones.
  const scored = [...candidates].sort(
    (a, b) => b.s * 1.2 - b.index * 0.15 - (a.s * 1.2 - a.index * 0.15),
  );
  const brand = scored[0]!;
  const primary = ensureContrast(brand.hex, WHITE, WCAG_AA_TEXT);

  const second = scored.find((c) => hueDistance(c.h, brand.h) >= 30);
  const third = scored.find(
    (c) => c !== second && hueDistance(c.h, brand.h) >= 30 && (!second || hueDistance(c.h, second.h) >= 30),
  );

  const secondary = mix(WHITE, second?.hex ?? primary, 0.1);
  const accent = mix(WHITE, third?.hex ?? second?.hex ?? primary, 0.14);
  const foreground = mix('#0b0b0f', primary, 0.1);

  return {
    primary,
    secondary,
    accent,
    background: WHITE,
    foreground: ensureContrast(foreground, WHITE, 12),
    defaultMode: 'system',
    radius: 'md',
  };
}
