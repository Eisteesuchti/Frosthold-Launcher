/**
 * 1) electron-builder --publish always → GitHub Release + latest.yml + Installer
 * 2) git commit + push (Repo-Wurzel = ein Ordner ueber FrostholdRP-Launcher)
 *
 * Benoetigt: GH_TOKEN oder GITHUB_TOKEN (PAT mit repo), git push bereits eingerichtet.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const launcherDir = path.join(__dirname, '..');
const repoRoot = path.join(launcherDir, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(launcherDir, 'package.json'), 'utf8'));
const version = pkg.version;

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.error(
    'Fehler: GH_TOKEN oder GITHUB_TOKEN setzen (GitHub Personal Access Token mit repo-Berechtigung).',
  );
  process.exit(1);
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: process.env });
}

/** Unter Windows schlaegt execFileSync('npm.cmd', …) oft mit EINVAL fehl — Shell nutzen. */
function runNpmDistPublish(cwd) {
  if (process.platform === 'win32') {
    execSync('npm run dist:publish', { cwd, stdio: 'inherit', env: process.env, shell: true });
  } else {
    execFileSync('npm', ['run', 'dist:publish'], { cwd, stdio: 'inherit', env: process.env });
  }
}

console.log(`[release] Launcher v${version}: npm run dist:publish …`);
runNpmDistPublish(launcherDir);

const candidates = [
  'FrostholdRP-Launcher',
  'frostmp_core.py',
  'frostmp_gui.py',
  'FrostMP-Launcher.py',
  '.cursor/rules',
];
const toAdd = candidates.filter((p) => fs.existsSync(path.join(repoRoot, p)));

if (toAdd.length === 0) {
  console.warn('[release] Keine bekannten Pfade zum Staging gefunden.');
} else {
  console.log('[release] Git: add', toAdd.join(', '));
  run('git', ['add', ...toAdd], repoRoot);
}

const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
  cwd: repoRoot,
  encoding: 'utf8',
});

if (!staged.trim()) {
  console.log('[release] Git: nichts zu committen (keine gestagten Aenderungen).');
} else {
  run('git', ['commit', '-m', `Release FrostholdRP Launcher v${version}`], repoRoot);
}

let branch = 'main';
try {
  branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
} catch (_) {}

console.log(`[release] Git: push origin ${branch} …`);
run('git', ['push', 'origin', branch], repoRoot);

console.log('[release] Fertig (GitHub Release-Assets + Repo-Push).');
