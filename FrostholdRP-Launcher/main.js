const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
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

/** Liest launcher-bundled-defaults.json und schreibt fehlende Werte (v. a. client_dist_source) in frostmp-launcher.json — für Weitergabe ohne manuelle Config. */
function applyBundledDefaultsToDisk() {
  const py = getPythonScriptPath();
  if (!py) return;
  const cfgPath = path.join(path.dirname(py), 'frostmp-launcher.json');
  let bundled = null;
  try {
    const bp = path.join(__dirname, 'launcher-bundled-defaults.json');
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

function runPythonJson(args) {
  return new Promise((resolve, reject) => {
    const script = getPythonScriptPath();
    if (!script) {
      reject(new Error('FrostMP-Launcher.py nicht gefunden. Bitte Launcher-Ordner korrekt installieren.'));
      return;
    }
    const proc = spawn('python', [script, ...args], {
      cwd: path.dirname(script),
      windowsHide: true,
    });
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
    proc.on('error', reject);
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

app.whenReady().then(() => {
  applyBundledDefaultsToDisk();
  createWindow();
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
