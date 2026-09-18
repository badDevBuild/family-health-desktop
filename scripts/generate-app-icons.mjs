import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stdout } from 'node:process';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const root = resolve(import.meta.dirname, '..');
const buildRoot = join(root, 'build');
const iconset = join(buildRoot, 'icon.iconset');
const svg = await readFile(join(buildRoot, 'icon.svg'));
const image = await loadImage(svg);

await rm(iconset, { recursive: true, force: true });
await mkdir(iconset, { recursive: true });

async function render(size, destination) {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, size, size);
  context.drawImage(image, 0, 0, size, size);
  await writeFile(destination, canvas.toBuffer('image/png'));
}

await render(1024, join(buildRoot, 'icon.png'));
for (const size of [16, 32, 128, 256, 512]) {
  await render(size, join(iconset, `icon_${size}x${size}.png`));
  await render(size * 2, join(iconset, `icon_${size}x${size}@2x.png`));
}

stdout.write(`Generated icon PNG and iconset in ${buildRoot}\n`);
