import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'print');
const HTML = 'file://' + path.join(ROOT, 'public', 'print', 'vistaprint-export.html');

const FACES = ['original-front', 'green-front'];

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
await page.goto(HTML, { waitUntil: 'networkidle0' });

for (const id of FACES) {
  const el = await page.$(`#${id}`);
  if (!el) {
    console.warn('missing', id);
    continue;
  }
  const out = path.join(OUT, `${id}.png`);
  await el.screenshot({ path: out });
  console.log('wrote', out);
}

await browser.close();
