import sharp from 'sharp';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgPath = resolve(__dirname, '../public/icon.svg');
const svgBuffer = readFileSync(svgPath);

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

for (const size of sizes) {
  await sharp(svgBuffer)
    .resize(size, size)
    .png()
    .toFile(resolve(__dirname, `../public/icons/icon-${size}x${size}.png`));
  console.log(`✓ icon-${size}x${size}.png`);
}

// apple-touch-icon (180x180)
await sharp(svgBuffer)
  .resize(180, 180)
  .png()
  .toFile(resolve(__dirname, '../public/apple-touch-icon.png'));
console.log('✓ apple-touch-icon.png');

// favicon (32x32)
await sharp(svgBuffer)
  .resize(32, 32)
  .png()
  .toFile(resolve(__dirname, '../public/favicon-32x32.png'));
console.log('✓ favicon-32x32.png');

console.log('\nAll icons generated successfully!');
