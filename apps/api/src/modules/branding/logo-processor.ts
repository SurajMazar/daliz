import { Injectable } from '@nestjs/common';
import { LOGO_VARIANTS, suggestThemeFromPalette, type LogoVariant, type Rgb, type ThemeInput } from '@daliz/shared';
import { getColor, getPalette } from 'colorthief';
import createDOMPurify from 'dompurify';
import { fileTypeFromBuffer } from 'file-type';
import { JSDOM } from 'jsdom';
import sharp, { type Metadata } from 'sharp';
import { Errors } from '../../common/errors.js';
import { sha256Hex } from '../../common/crypto.js';

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const SVG_MAX_BYTES = 512 * 1024;
const MAX_PIXELS = 40_000_000; // decompression-bomb guard
const MAX_DIMENSION = 8000;
const MIN_SHORT_SIDE = 32;
const MIN_LONG_SIDE = 128;

const RASTER_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/webp', 'webp'],
]);

interface VariantSpec {
  width: number;
  height: number;
  /** 'inside' keeps the logo's aspect ratio with no canvas; 'contain' pads onto a square canvas. */
  fit: 'inside' | 'contain';
  background?: { r: number; g: number; b: number; alpha: number };
}

/** Pixel sizes are 2× the CSS display size so logos stay sharp on high-density screens. */
export const VARIANT_SPECS: Record<LogoVariant, VariantSpec> = {
  header: { width: 560, height: 96, fit: 'inside' },
  sidebar: { width: 480, height: 80, fit: 'inside' },
  login: { width: 640, height: 240, fit: 'inside' },
  email: { width: 400, height: 120, fit: 'inside' },
  mobile: { width: 320, height: 64, fit: 'inside' },
  'favicon-16': { width: 16, height: 16, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } },
  'favicon-32': { width: 32, height: 32, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } },
  'favicon-48': { width: 48, height: 48, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } },
  // iOS ignores transparency on home-screen icons, so this one gets an opaque background.
  'icon-180': { width: 180, height: 180, fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } },
  'icon-192': { width: 192, height: 192, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } },
  'icon-512': { width: 512, height: 512, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } },
};

export interface ProcessedLogo {
  format: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  hasTransparency: boolean;
  palette: Rgb[];
  dominant: Rgb;
  suggestedTheme: ThemeInput;
  warnings: string[];
  sanitizedOriginal: { body: Buffer; contentType: string; ext: string };
  variants: Record<LogoVariant, Buffer>;
}

const window = new JSDOM('').window;
const purify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);

function looksLikeSvg(buf: Buffer): boolean {
  const head = buf.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

/**
 * Sanitizes SVG markup: strips scripts, event handlers, foreignObject, and every external
 * reference, keeping only same-document fragment links (href="#...").
 */
export function sanitizeSvg(input: string): string {
  const clean = purify.sanitize(input, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'image', 'use', 'style', 'a'],
    FORBID_ATTR: ['style'],
    ALLOW_DATA_ATTR: false,
  });
  if (!clean || !/<svg[\s>]/i.test(clean)) throw Errors.unsupportedMedia('The SVG file could not be read safely.');
  if (/(?:xlink:)?href\s*=\s*["'](?!#)/i.test(clean) || /url\(\s*['"]?(?!#)/i.test(clean)) {
    throw Errors.unsupportedMedia('SVG logos cannot reference external resources.');
  }
  return clean;
}

@Injectable()
export class LogoProcessor {
  async process(input: Buffer, declaredMime: string): Promise<ProcessedLogo> {
    if (input.length === 0) throw Errors.badRequest('The file is empty.');
    if (input.length > LOGO_MAX_BYTES) throw Errors.payloadTooLarge('Logos must be 2 MB or smaller.');

    let format: string;
    let rasterSource: Buffer;
    let sanitizedOriginal: ProcessedLogo['sanitizedOriginal'];

    const detected = await fileTypeFromBuffer(input);
    if (detected && RASTER_TYPES.has(detected.mime)) {
      // Trust the bytes, not the client: the declared type must agree with the signature.
      if (declaredMime && declaredMime !== detected.mime && !(declaredMime === 'image/jpg' && detected.mime === 'image/jpeg')) {
        throw Errors.unsupportedMedia('The file contents don’t match its type.');
      }
      format = RASTER_TYPES.get(detected.mime)!;
      rasterSource = input;
      sanitizedOriginal = { body: Buffer.alloc(0), contentType: detected.mime, ext: detected.ext };
    } else if (!detected && looksLikeSvg(input)) {
      if (input.length > SVG_MAX_BYTES) throw Errors.payloadTooLarge('SVG logos must be 512 KB or smaller.');
      const clean = sanitizeSvg(input.toString('utf8'));
      format = 'svg';
      rasterSource = Buffer.from(clean, 'utf8');
      sanitizedOriginal = { body: rasterSource, contentType: 'image/svg+xml', ext: 'svg' };
    } else {
      throw Errors.unsupportedMedia('Upload a PNG, JPEG, WebP or SVG image.');
    }

    const image = () =>
      sharp(rasterSource, { limitInputPixels: MAX_PIXELS, density: format === 'svg' ? 300 : undefined, failOn: 'error' });

    let meta: Metadata;
    try {
      meta = await image().metadata();
    } catch {
      throw Errors.unsupportedMedia('The image could not be decoded.');
    }
    const width = meta.autoOrient?.width ?? meta.width ?? 0;
    const height = meta.autoOrient?.height ?? meta.height ?? 0;
    if (!width || !height) throw Errors.unsupportedMedia('The image has no dimensions.');
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) throw Errors.badRequest(`Logos can be at most ${MAX_DIMENSION}×${MAX_DIMENSION} pixels.`);
    if (format !== 'svg' && (Math.min(width, height) < MIN_SHORT_SIDE || Math.max(width, height) < MIN_LONG_SIDE)) {
      throw Errors.badRequest(`This logo is too small (${width}×${height}). Upload at least ${MIN_LONG_SIDE}px on the long side, or an SVG.`);
    }

    // Normalize: apply EXIF orientation, drop metadata, convert to sRGB PNG with alpha.
    const normalized = await image().autoOrient().toColorspace('srgb').ensureAlpha().png().toBuffer();
    if (format !== 'svg') {
      sanitizedOriginal = { body: normalized, contentType: 'image/png', ext: 'png' };
    }
    const stats = await sharp(normalized).stats();
    const hasTransparency = !stats.isOpaque;

    const warnings: string[] = [];
    const ratio = width / height;
    if (ratio > 8) warnings.push('This logo is very wide. It will be scaled down to fit headers, which can make it hard to read.');
    if (ratio < 1 / 3) warnings.push('This logo is very tall. Consider a horizontal version for headers and navigation.');
    if (format !== 'svg' && Math.max(width, height) < 512) warnings.push('This logo is low resolution and may look blurry on high-density screens. An SVG or a 1024px PNG works best.');
    if (!hasTransparency) warnings.push('This logo has a solid background. A transparent PNG or an SVG blends better with light and dark themes.');

    const variants = {} as Record<LogoVariant, Buffer>;
    for (const variant of LOGO_VARIANTS) {
      const spec = VARIANT_SPECS[variant];
      const pad = spec.fit === 'contain' ? Math.round(spec.width * 0.1) : 0;
      variants[variant] = await sharp(normalized)
        .resize({
          width: spec.width - pad * 2,
          height: spec.height - pad * 2,
          fit: spec.fit,
          withoutEnlargement: spec.fit === 'inside',
          background: spec.background ?? { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .extend(pad ? { top: pad, bottom: pad, left: pad, right: pad, background: spec.background! } : { top: 0, bottom: 0, left: 0, right: 0 })
        .flatten(spec.background && spec.background.alpha === 1 ? { background: spec.background } : false)
        .png({ compressionLevel: 9 })
        .toBuffer();
    }

    // Color Thief runs on the normalized PNG; transparent pixels are ignored by the quantizer.
    const paletteColors = (await getPalette(normalized, { colorCount: 8, quality: 5 })) ?? [];
    const dominantColor = await getColor(normalized, { quality: 5 });
    const palette = paletteColors.map((c) => c.array() as Rgb);
    const dominant = (dominantColor?.array() ?? palette[0] ?? [39, 83, 215]) as Rgb;

    return {
      format,
      bytes: input.length,
      sha256: sha256Hex(input),
      width,
      height,
      hasTransparency,
      palette,
      dominant,
      suggestedTheme: suggestThemeFromPalette(palette.length ? palette : [dominant]),
      warnings,
      sanitizedOriginal,
      variants,
    };
  }
}
