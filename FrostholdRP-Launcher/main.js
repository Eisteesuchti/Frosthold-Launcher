const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const fs = require('fs');

function getConfigPath() {
  const py = getPythonScriptPath();
  if (py) {
    return path.join(path.dirname(py), 'frostmp-launcher.json');
  }
  return path.join(app.getPath('userData'), 'frostholdrp-launcher.json');
}

function loadLocalConfig() {
  const p = getConfigPath();
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveLocalConfig(obj) {
  fs.writeFileSync(getConfigPath(), JSON.stringify(obj, null, 2), 'utf8');
}

function getBundledDefaultsPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'launcher-bundled-defaults.json');
  }
  return path.join(__dirname, 'launcher-bundled-defaults.json');
}

/** Liest launcher-bundled-defaults.json und schreibt fehlende Werte (v. a. client_dist_source) in frostmp-launcher.json — für Weitergabe ohne manuelle Config. */
function applyBundledDefaultsToDisk() {
  const py = getPythonScriptPath();
  if (!py) return;
  const cfgPath = path.join(path.dirname(py), 'frostmp-launcher.json');
  let bundled = null;
  try {
    const bp = getBundledDefaultsPath();
    if (fs.existsSync(bp)) {
      bundled = JSON.parse(fs.readFileSync(bp, 'utf8'));
    }
  } catch (_) {}
  const defaults = {
    server_ip: '188.245.77.170',
    server_port: 7777,
    profile_id: 1,
    skyrim_dir: '',
    client_dist_source: '',
    status_url: 'http://188.245.77.170:3000/',
  };
  let existing = {};
  try {
    if (fs.existsSync(cfgPath)) {
      existing = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    }
  } catch (_) {}
  const merged = { ...defaults, ...existing };
  if (bundled && typeof bundled === 'object') {
    const bcd = String(bundled.client_dist_source || '').trim();
    if (!String(merged.client_dist_source || '').trim() && bcd) {
      merged.client_dist_source = bcd;
    }
    const bsu = String(bundled.status_url || '').trim();
    if (!String(merged.status_url || '').trim() && bsu) {
      merged.status_url = bsu;
    }
    const sip = String(bundled.server_ip || '').trim();
    if (!String(merged.server_ip || '').trim() && sip) {
      merged.server_ip = sip;
    }
  }
  merged.server_port = 7777;
  if (!merged.server_ip) merged.server_ip = defaults.server_ip;
  if (!merged.status_url) merged.status_url = defaults.status_url;
  if (merged.profile_id == null || merged.profile_id < 1) merged.profile_id = 1;
  try {
    const serialized = `${JSON.stringify(merged, null, 2)}\n`;
    let needWrite = true;
    if (fs.existsSync(cfgPath)) {
      try {
        if (fs.readFileSync(cfgPath, 'utf8') === serialized) needWrite = false;
      } catch (_) {}
    }
    if (needWrite) fs.writeFileSync(cfgPath, serialized, 'utf8');
  } catch (_) {}
}

function getPythonScriptPath() {
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'FrostMP-Launcher.py');
    if (fs.existsSync(p)) return p;
  }
  const here = __dirname;
  const candidates = [
    path.join(here, '..', 'FrostMP-Launcher.py'),
    path.join(process.cwd(), 'FrostMP-Launcher.py'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Mitgelieferte Python-Embedded-Runtime (npm run prepare-runtime) — Spieler brauchen kein systemweites Python. */
function getBundledPythonExe() {
  if (process.platform !== 'win32') return null;
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'python-runtime', 'python.exe'));
  }
  candidates.push(path.join(__dirname, 'python-runtime', 'python.exe'));
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function runPythonJson(args) {
  return new Promise((resolve, reject) => {
    const script = getPythonScriptPath();
    if (!script) {
      reject(new Error('FrostMP-Launcher.py nicht gefunden. Bitte Launcher-Ordner korrekt installieren.'));
      return;
    }
    const opts = {
      cwd: path.dirname(script),
      windowsHide: true,
    };

    const attempts = [];
    const bundled = getBundledPythonExe();
    if (bundled) attempts.push({ cmd: bundled, argv: [script, ...args] });
    attempts.push({ cmd: 'python', argv: [script, ...args] });
    if (process.platform === 'win32') {
      attempts.push({ cmd: 'py', argv: ['-3', script, ...args] });
    }

    let idx = 0;

    const startNext = () => {
      if (idx >= attempts.length) {
        const msg = app.isPackaged
          ? 'Die mitgelieferte Python-Runtime fehlt oder ist beschädigt. Bitte den Launcher neu installieren.'
          : 'Kein Python gefunden. Im Ordner FrostholdRP-Launcher „npm run prepare-runtime“ ausführen '
            + '(lädt die mitgelieferte Runtime), oder Python 3 auf dem System installieren.';
        reject(new Error(msg));
        return;
      }
      const { cmd, argv } = attempts[idx];
      const proc = spawn(cmd, argv, opts);
      let out = '';
      let err = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('close', (code) => {
        const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
        try {
          const j = JSON.parse(line);
          resolve({ code, json: j, stderr: err });
        } catch {
          resolve({ code, json: null, raw: out, stderr: err });
        }
      });
      proc.on('error', (e) => {
        if (e.code === 'ENOENT' || e.errno === 'ENOENT') {
          idx += 1;
          startNext();
        } else {
          reject(e);
        }
      });
    };
    startNext();
  });
}

let mainWindow = null;

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'logo.png');
  mainWindow = new BrowserWindow({
    width: 1350,
    height: 750,
    resizable: false,
    frame: false,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#05070d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function getDesktopPromptFlagPath() {
  return path.join(app.getPath('userData'), 'prompt-desktop-shortcut');
}

function createDesktopShortcutWindows() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      resolve(false);
      return;
    }
    const desktop = app.getPath('desktop');
    const target = process.execPath;
    const shortcut = path.join(desktop, 'FrostholdRP Launcher.lnk');
    const wd = path.dirname(target);
    const ps = [
      '$s=(New-Object -ComObject WScript.Shell).CreateShortcut(' + JSON.stringify(shortcut) + ');',
      '$s.TargetPath=' + JSON.stringify(target) + ';',
      '$s.WorkingDirectory=' + JSON.stringify(wd) + ';',
      '$s.IconLocation=' + JSON.stringify(`${target},0`) + ';',
      '$s.Save()',
    ].join('');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true },
      (err) => (err ? reject(err) : resolve(true)),
    );
  });
}

async function maybePromptDesktopFromInstaller() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const flag = getDesktopPromptFlagPath();
  try {
    if (!fs.existsSync(flag)) return;
    fs.unlinkSync(flag);
  } catch (_) {
    return;
  }
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const r = await dialog.showMessageBox(win || undefined, {
    type: 'question',
    buttons: ['Ja', 'Nein'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: 'Frosthold Installer',
    message: 'Soll eine Verknüpfung zum FrostholdRP Launcher auf dem Desktop erstellt werden?',
  });
  if (r.response === 0) {
    try {
      await createDesktopShortcutWindows();
    } catch (e) {
      dialog.showErrorBox('Verknüpfung', `Desktop-Verknüpfung konnte nicht erstellt werden:\n${e.message || e}`);
    }
  }
}

app.whenReady().then(() => {
  applyBundledDefaultsToDisk();
  createWindow();
  const schedulePrompt = () => setTimeout(() => maybePromptDesktopFromInstaller(), 450);
  if (mainWindow) {
    mainWindow.once('ready-to-show', schedulePrompt);
  }
  if (app.isPackaged) {
    setTimeout(() => maybePromptDesktopFromInstaller(), 4000);
  }
});
app.on('window-all-closed', () => app.quit());

ipcMain.handle('window-minimize', () => mainWindow?.minimize());
ipcMain.handle('window-close', () => mainWindow?.close());

ipcMain.handle('get-paths', async () => ({
  configPath: getConfigPath(),
  pythonScript: getPythonScriptPath(),
}));

ipcMain.handle('load-config', async () => {
  const local = loadLocalConfig();
  const defaults = {
    server_ip: '188.245.77.170',
    server_port: 7777,
    profile_id: 1,
    skyrim_dir: '',
    client_dist_source: '',
    status_url: 'http://188.245.77.170:3000/',
  };
  return { ...defaults, ...local };
});

ipcMain.handle('save-config', async (_e, cfg) => {
  const prev = loadLocalConfig();
  const defaults = {
    server_ip: '188.245.77.170',
    server_port: 7777,
    profile_id: 1,
    skyrim_dir: '',
    client_dist_source: '',
    status_url: 'http://188.245.77.170:3000/',
  };
  const merged = { ...defaults, ...prev };
  if (cfg && typeof cfg === 'object') {
    if (typeof cfg.server_ip === 'string') merged.server_ip = cfg.server_ip.trim() || defaults.server_ip;
    if (typeof cfg.skyrim_dir === 'string') merged.skyrim_dir = cfg.skyrim_dir.trim();
    if (typeof cfg.server_port === 'number' && Number.isFinite(cfg.server_port)) merged.server_port = cfg.server_port;
    if (typeof cfg.profile_id === 'number' && Number.isFinite(cfg.profile_id)) merged.profile_id = cfg.profile_id;
    if (typeof cfg.client_dist_source === 'string') merged.client_dist_source = cfg.client_dist_source.trim();
    if (typeof cfg.status_url === 'string') merged.status_url = cfg.status_url.trim();
  }
  merged.server_port = 7777;
  if (!merged.server_ip) merged.server_ip = defaults.server_ip;
  if (!merged.status_url) merged.status_url = defaults.status_url;
  if (merged.profile_id == null || merged.profile_id < 1) merged.profile_id = 1;
  saveLocalConfig(merged);
  return true;
});

ipcMain.handle('load-news-json', async () => {
  try {
    const p = path.join(__dirname, 'news.json');
    const raw = fs.readFileSync(p, 'utf8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('skyrim-status', async () => {
  try {
    const r = await runPythonJson(['--json-status']);
    return r.json || { error: 'bad_json', raw: r.raw, stderr: r.stderr };
  } catch (e) {
    return { error: String(e.message || e) };
  }
});

ipcMain.handle('play', async () => {
  const py = getPythonScriptPath();
  if (!py) {
    return { ok: false, error: 'python_script_missing', message: 'FrostMP-Launcher.py nicht gefunden (Ordner Frosthold Server).' };
  }
  try {
    const r = await runPythonJson(['--json-play']);
    if (r.json) return r.json;
    return { ok: false, error: 'bad_response', raw: r.raw, stderr: r.stderr };
  } catch (e) {
    return { ok: false, error: 'spawn', message: String(e.message || e) };
  }
});

ipcMain.handle('setup', async () => {
  const py = getPythonScriptPath();
  if (!py) {
    return { ok: false, error: 'python_script_missing', message: 'FrostMP-Launcher.py nicht gefunden (Ordner Frosthold Server).' };
  }
  try {
    const r = await runPythonJson(['--json-setup']);
    if (r.json) return r.json;
    return { ok: false, error: 'bad_response', raw: r.raw, stderr: r.stderr };
  } catch (e) {
    return { ok: false, error: 'spawn', message: String(e.message || e) };
  }
});

ipcMain.handle('open-external', async (_e, url) => {
  if (url && /^https?:\/\//i.test(url)) await shell.openExternal(url);
});

ipcMain.handle('frosthold-manifest', async () => {
  try {
    const p = path.join(__dirname, 'frosthold-manifest.json');
    if (fs.existsSync(p)) {
      return { ok: true, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
    }
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return { ok: false, error: 'missing' };
});

ipcMain.handle('app-meta', async () => ({
  isPackaged: app.isPackaged,
  version: app.getVersion(),
  name: app.getName(),
}));

ipcMain.handle('create-desktop-shortcut', async () => {
  try {
    await createDesktopShortcutWindows();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
});

ipcMain.handle('quick-health-check', async () => {
  let m = { ok: false };
  try {
    const p = path.join(__dirname, 'frosthold-manifest.json');
    if (fs.existsSync(p)) m = { ok: true, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (_) {}
  let status = null;
  try {
    const r = await runPythonJson(['--json-status']);
    status = r.json || { error: 'bad_json' };
  } catch (e) {
    status = { error: String(e.message || e) };
  }
  return { manifest: m, status };
});
