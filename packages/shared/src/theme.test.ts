import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  checkThemeContrast,
  contrastRatio,
  ensureContrast,
  suggestThemeFromPalette,
  themeCssVariables,
  themeHasBlockingIssues,
  themeInputSchema,
} from './theme.js';

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
  });
});

describe('ensureContrast', () => {
  it('darkens a light brand color until it passes against white', () => {
    const out = ensureContrast('#ffd400', '#ffffff', 4.5);
    expect(contrastRatio(out, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('leaves passing colors untouched', () => {
    expect(ensureContrast('#1f2937', '#ffffff', 4.5)).toBe('#1f2937');
  });
});

describe('theme', () => {
  it('ships an accessible default theme', () => {
    expect(themeHasBlockingIssues(DEFAULT_THEME)).toBe(false);
  });

  it('flags unreadable text on background as blocking', () => {
    const bad = { ...DEFAULT_THEME, foreground: '#dddddd' };
    const failing = checkThemeContrast(bad).filter((c) => !c.passes && c.severity === 'error');
    expect(failing.map((c) => c.id)).toContain('text-on-background');
    expect(themeHasBlockingIssues(bad)).toBe(true);
  });

  it('rejects anything that is not a strict hex color', () => {
    const attempt = themeInputSchema.safeParse({
      ...DEFAULT_THEME,
      primary: 'red; background: url(https://evil.test)',
    });
    expect(attempt.success).toBe(false);
  });

  it('derives only hex css variables', () => {
    for (const mode of ['light', 'dark'] as const) {
      const vars = themeCssVariables(DEFAULT_THEME, mode);
      for (const [k, v] of Object.entries(vars)) {
        if (k === '--radius') continue;
        expect(v).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});

describe('suggestThemeFromPalette', () => {
  it('builds a passing theme from a bright yellow logo', () => {
    const theme = suggestThemeFromPalette([
      [255, 255, 255],
      [255, 212, 0],
      [20, 20, 20],
    ]);
    expect(themeHasBlockingIssues(theme)).toBe(false);
    expect(contrastRatio(theme.primary, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('handles monochrome logos', () => {
    const theme = suggestThemeFromPalette([
      [255, 255, 255],
      [0, 0, 0],
    ]);
    expect(themeHasBlockingIssues(theme)).toBe(false);
  });

  it('falls back to the default theme for an empty palette', () => {
    expect(suggestThemeFromPalette([])).toEqual(DEFAULT_THEME);
  });
});
