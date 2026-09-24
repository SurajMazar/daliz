/**
 * Renders the Daliz mark into every icon size the platforms need:
 *   assets/brand/icons/icon-<size>.png  (web favicon, PWA, iOS, Windows, Linux, macOS)
 *   apps/desktop/resources/icons/appIcon.png (Neutralino window icon)
 * Native installers package these into .icns/.ico in the release pipeline.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = `${root}assets/brand/daliz-mark.svg`;
const SIZES = [16, 32, 48, 72, 96, 128, 144, 152, 180, 192, 256, 384, 512, 1024];

mkdirSync(`${root}assets/brand/icons`, { recursive: true });
mkdirSync(`${root}apps/desktop/resources/icons`, { recursive: true });
for (const size of SIZES) {
  await sharp(source, { density: 512 }).resize(size, size).png({ compressionLevel: 9 }).toFile(`${root}assets/brand/icons/icon-${size}.png`);
}
// Maskable PWA icon: the mark inside the 80% safe zone on a solid background.
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#2753d7' } })
  .composite([{ input: await sharp(source, { density: 512 }).resize(410, 410).png().toBuffer(), gravity: 'center' }])
  .png()
  .toFile(`${root}assets/brand/icons/icon-maskable-512.png`);
await sharp(source, { density: 512 }).resize(256, 256).png().toFile(`${root}apps/desktop/resources/icons/appIcon.png`);
console.log(`icons written for ${SIZES.join(', ')} px`);
