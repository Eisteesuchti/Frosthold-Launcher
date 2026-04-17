/**
 * Laedt das offizielle Microsoft Visual C++ 2015-2022 Redistributable (x64)
 * von aka.ms nach ./bin/vc_redist.x64.exe.
 *
 * Hintergrund: SkyrimPlatform.dll / MpClientPlugin.dll brauchen
 * VCRUNTIME140.dll, VCRUNTIME140_1.dll und MSVCP140.dll. Auf frischen
 * Windows-Installationen fehlt das oft — Skyrim startet dann zwar
 * vanilla, stirbt aber sofort wenn skse64_loader.exe die Plugins laden
 * will ("Crash vor dem Hauptmenue").
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
const target = path.join(binDir, 'vc_redist.x64.exe');

// aka.ms ist ein Redirect-Shortener von Microsoft, der auf den aktuellen
// offiziellen Download zeigt (derzeit ~25 MB).
const URL_VCREDIST = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
// Plausibilitaets-Check: vc_redist.x64.exe ist seit Jahren >= 10 MB.
const MIN_BYTES = 10 * 1024 * 1024;
// Mehrfache Redirect-Hops zulassen (aka.ms → download.visualstudio.microsoft.com).
const MAX_REDIRECTS = 8;

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https
      .get(url, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          file.close();
          try {
            fs.unlinkSync(dest);
          } catch (_) {}
          if (redirects >= MAX_REDIRECTS) {
            return reject(new Error(`Zu viele Redirects (${MAX_REDIRECTS}) fuer ${url}`));
          }
          return download(res.headers.location, dest, redirects + 1).then(resolve).catch(reject);
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
      console.log(`vc_redist.x64.exe bereits vorhanden (${size} bytes) — ueberspringe.`);
      return;
    }
    console.log(`vc_redist.x64.exe vorhanden, aber zu klein (${size} bytes) — neu laden.`);
    fs.unlinkSync(target);
  }
  mkdirSync(binDir, { recursive: true });
  console.log('Download', URL_VCREDIST, '->', target);
  await download(URL_VCREDIST, target);
  const size = fs.statSync(target).size;
  if (size < MIN_BYTES) {
    throw new Error(`vc_redist.x64.exe Download zu klein (${size} bytes) — Abbruch.`);
  }
  console.log(`Fertig: ${target} (${size} bytes)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
