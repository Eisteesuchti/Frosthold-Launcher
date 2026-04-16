/**
 * Entfernt dist-build/ komplett, damit keine alten Installer/Blockmaps/win-unpacked liegen bleiben.
 * Wird vor dist:*-Builds ausgefuehrt.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const target = path.join(root, 'dist-build');

try {
  fs.rmSync(target, { recursive: true, force: true });
  console.log('dist-build bereinigt (alte Build-Artefakte entfernt).');
} catch (e) {
  console.warn('clean-dist:', e.message || e);
}
