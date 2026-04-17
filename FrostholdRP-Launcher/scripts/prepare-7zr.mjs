/**
 * Laedt die offizielle 7zr.exe (standalone reduced 7-Zip console extractor)
 * von 7-zip.org in ./bin/7zr.exe.
 *
 * Hintergrund: py7zr kann BCJ2-gefilterte .7z-Archive (wie SKSE von
 * skse.silverlock.org) nicht entpacken. 7zr.exe ist die schlanke
 * offizielle Alternative (~600 KB) und unterstuetzt alle 7z-Filter,
 * inklusive BCJ2.
 *
 * Wird automatisch vor jedem dist:*-Build ausgefuehrt (siehe package.json).
 */
import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream, mkdirSync, existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const binDir = path.join(root, 'bin');
const target = path.join(binDir, '7zr.exe');

const URL_7ZR = 'https://www.7-zip.org/a/7zr.exe';
// Minimalgroesse fuer Plausibilitaets-Check (aktuelle Version ist ~600 KB).
const MIN_BYTES = 200 * 1024;

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          try {
            fs.unlinkSync(dest);
          } catch (_) {}
          return download(res.headers.location, dest).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          file.close();
          try {
            fs.unlinkSync(dest);
          } catch (_) {}
          return reject(new Error(`HTTP ${res.statusCode} ${url}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', reject);
  });
}

async function main() {
  if (existsSync(target)) {
    const size = fs.statSync(target).size;
    if (size >= MIN_BYTES) {
      console.log(`7zr.exe bereits vorhanden (${size} bytes) — ueberspringe.`);
      return;
    }
    console.log(`7zr.exe vorhanden, aber zu klein (${size} bytes) — neu laden.`);
    fs.unlinkSync(target);
  }
  mkdirSync(binDir, { recursive: true });
  console.log('Download', URL_7ZR, '->', target);
  await download(URL_7ZR, target);
  const size = fs.statSync(target).size;
  if (size < MIN_BYTES) {
    throw new Error(`7zr.exe Download zu klein (${size} bytes) — Abbruch.`);
  }
  console.log(`Fertig: ${target} (${size} bytes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
