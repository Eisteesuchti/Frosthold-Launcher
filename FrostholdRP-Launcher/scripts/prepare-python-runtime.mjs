/**
 * Laedt Python 3.12 embeddable (amd64), aktiviert site-packages, installiert pip + py7zr.
 * Ausfuehren vor electron-builder: npm run prepare-runtime
 * Ergebnis: ./python-runtime/
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const rt = path.join(root, 'python-runtime');
const PY_VER = '3.12.7';
const ZIP_NAME = `python-${PY_VER}-embed-amd64.zip`;
const ZIP_URL = `https://www.python.org/ftp/python/${PY_VER}/${ZIP_NAME}`;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https.get(url, (res) => {
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
    }).on('error', reject);
  });
}

function expandZipWithPowerShell(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const ps = `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    stdio: 'inherit',
  });
}

function patchPth() {
  const files = readdirSync(rt).filter((f) => f.endsWith('._pth'));
  if (!files.length) throw new Error(`Keine ._pth in ${rt}`);
  const pthFile = path.join(rt, files[0]);
  const lines = ['python312.zip', '.', 'Lib\\site-packages', 'import site'];
  writeFileSync(pthFile, lines.join('\r\n') + '\r\n', 'utf8');
  console.log('Patched', pthFile);
}

async function main() {
  const marker = path.join(rt, 'Lib', 'site-packages', 'py7zr');
  if (existsSync(path.join(rt, 'python.exe')) && existsSync(marker)) {
    console.log('python-runtime ist bereits vollstaendig — ueberspringe (Ordner loeschen zum Neuaufbau).');
    return;
  }
  console.log('Python-Embedded-Runtime ->', rt);
  if (existsSync(rt)) {
    rmSync(rt, { recursive: true, force: true });
  }
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const zipPath = path.join(root, 'scripts', ZIP_NAME);
  console.log('Download', ZIP_URL);
  await download(ZIP_URL, zipPath);
  console.log('Entpacke…');
  expandZipWithPowerShell(zipPath, rt);
  fs.unlinkSync(zipPath);

  patchPth();

  const getPip = path.join(rt, 'get-pip.py');
  console.log('Download get-pip.py');
  await download(GET_PIP_URL, getPip);

  const py = path.join(rt, 'python.exe');
  console.log('pip installieren…');
  execFileSync(py, [getPip, '--no-warn-script-location'], { cwd: rt, stdio: 'inherit' });
  fs.unlinkSync(getPip);

  console.log('py7zr installieren (SKSE .7z)…');
  execFileSync(py, ['-m', 'pip', 'install', '--quiet', 'py7zr'], { cwd: rt, stdio: 'inherit' });

  execFileSync(py, ['-c', 'import py7zr; print("py7zr OK")'], { cwd: rt, stdio: 'inherit' });
  console.log('Fertig:', rt);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
