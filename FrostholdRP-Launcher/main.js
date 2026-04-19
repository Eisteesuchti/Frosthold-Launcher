const { app, BrowserWindow, ipcMain, shell, dialog, net } = require('electron');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const DEFAULT_STATUS_URL = 'http://188.245.77.170:3212/health';

function normalizeStatusUrl(u) {
  const s = String(u || '').trim() || DEFAULT_STATUS_URL;
  if (s.includes('/health')) return s;
  return s.replace(/\/$/, '') + '/';
}

/** HTTP(S)-Ping im Main-Prozess — umgeht CORS (Renderer-fetch von file:// schlaegt sonst fehl). */
function pingServerStatusFromMain(statusUrl) {
  return new Promise((resolve) => {
    const url = normalizeStatusUrl(statusUrl);
    let finished = false;
    const done = (payload) => {
      if (finished) return;
      finished = true;
      resolve(payload);
    };
    let req;
    try {
      req = net.request({ method: 'GET', url });
    } catch (e) {
      done({ ok: false, error: String(e.message || e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        req.abort();
      } catch (_) {}
      done({ ok: false, error: 'timeout' });
    }, 5000);
    req.setHeader('User-Agent', 'FrostholdRP-Launcher/1.0');
    req.on('response', (res) => {
      const code = res.statusCode || 0;
      res.on('data', () => {});
      res.on('end', () => {
        clearTimeout(timer);
        done({ ok: code >= 200 && code < 300, statusCode: code });
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, error: String(err.message || err) });
    });
    req.end();
  });
}

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
    // profile_id: 0 = "noch kein Discord-Login". Ein gueltiger profile_id wird
    // ausschliesslich vom Chat-Server nach erfolgreicher Discord-OAuth-Exchange
    // vergeben (deterministisch aus Discord-User-ID). Ohne Login bleibt der Wert
    // 0 und der Python-Core verweigert den Spielstart mit error=login_required.
    profile_id: 0,
    skyrim_dir: '',
    client_dist_source: '',
    status_url: DEFAULT_STATUS_URL,
    frosthold_chat_enabled: false,
    frosthold_chat_ws_url: '',
    frosthold_chat_user_id: '',
    frosthold_chat_secret: '',
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
    if (bundled.frosthold_chat_enabled === true && merged.frosthold_chat_enabled !== true) {
      merged.frosthold_chat_enabled = true;
    }
    const cwsu = String(bundled.frosthold_chat_ws_url || '').trim();
    if (!String(merged.frosthold_chat_ws_url || '').trim() && cwsu) {
      merged.frosthold_chat_ws_url = cwsu;
    }
    const cuid = String(bundled.frosthold_chat_user_id || '').trim();
    if (!String(merged.frosthold_chat_user_id || '').trim() && cuid) {
      merged.frosthold_chat_user_id = cuid;
    }
    const csec = String(bundled.frosthold_chat_secret || '').trim();
    if (!String(merged.frosthold_chat_secret || '').trim() && csec) {
      merged.frosthold_chat_secret = csec;
    }
  }
  merged.server_port = 7777;
  if (!merged.server_ip) merged.server_ip = defaults.server_ip;
  if (!merged.status_url) merged.status_url = defaults.status_url;
  // profile_id NIE automatisch auf 1 ziehen — nur Discord-Login darf ihn setzen.
  if (merged.profile_id == null || typeof merged.profile_id !== 'number' || merged.profile_id < 0) {
    merged.profile_id = 0;
  }
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

/** Mitgelieferter 7zr.exe (npm run prepare-7zr) — entpackt SKSE (.7z mit BCJ2-Filter),
 *  wo py7zr an BCJ2 scheitert. Spieler brauchen kein vorinstalliertes 7-Zip. */
function getBundled7zrExe() {
  if (process.platform !== 'win32') return null;
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'bin', '7zr.exe'));
  }
  candidates.push(path.join(__dirname, 'bin', '7zr.exe'));
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Mitgeliefertes VC++ 2015-2022 Redistributable (x64) — wird vom Python-Core
 *  ausgefuehrt, wenn das Redist auf dem System fehlt (Skyrim crasht sonst via
 *  skse64_loader.exe vor dem Hauptmenue, weil Skyrim Platform seine DLLs nicht
 *  laden kann). */
function getBundledVcRedistExe() {
  if (process.platform !== 'win32') return null;
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'bin', 'vc_redist.x64.exe'));
  }
  candidates.push(path.join(__dirname, 'bin', 'vc_redist.x64.exe'));
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Startet den Python-Subprozess und parst stdout zeilenweise als JSON.
 *
 * Protokoll zwischen Python und Launcher:
 * - Jede Zeile ist ein eigenes JSON-Objekt.
 * - Zeilen mit "event" ("progress" | "status") werden live an onProgress gemeldet
 *   und an den Renderer fuer den Download-Balken weitergereicht.
 * - Die letzte Zeile ohne "event"-Feld ist das Endresultat (gleiches Format
 *   wie vorher: { ok, error, message, ... }).
 *
 * @param {string[]} args CLI-Argumente fuer FrostMP-Launcher.py (z. B. ["--json-play"]).
 * @param {(evt: object) => void} [onProgress] Optionaler Live-Callback fuer "event"-Zeilen.
 */
function runPythonJson(args, onProgress) {
  return new Promise((resolve, reject) => {
    const script = getPythonScriptPath();
    if (!script) {
      reject(new Error('FrostMP-Launcher.py nicht gefunden. Bitte Launcher-Ordner korrekt installieren.'));
      return;
    }
    const env = { ...process.env };
    const bundled7zr = getBundled7zrExe();
    if (bundled7zr) {
      env.FROSTMP_BUNDLED_7ZR = bundled7zr;
    }
    const bundledVcRedist = getBundledVcRedistExe();
    if (bundledVcRedist) {
      env.FROSTMP_BUNDLED_VCREDIST = bundledVcRedist;
    }
    // Python soll stdout line-buffered schreiben, damit Progress-Events sofort
    // ankommen und nicht erst am Prozess-Ende. -u deaktiviert die Buffering-
    // Optimierung der Runtime.
    env.PYTHONUNBUFFERED = '1';
    const opts = {
      cwd: path.dirname(script),
      windowsHide: true,
      env,
    };

    const attempts = [];
    const bundled = getBundledPythonExe();
    if (bundled) attempts.push({ cmd: bundled, argv: ['-u', script, ...args] });
    attempts.push({ cmd: 'python', argv: ['-u', script, ...args] });
    if (process.platform === 'win32') {
      attempts.push({ cmd: 'py', argv: ['-3', '-u', script, ...args] });
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
      let lineBuf = '';
      let finalResult = null;

      const handleLine = (rawLine) => {
        const line = rawLine.trim();
        if (!line) return;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object' && typeof parsed.event === 'string') {
            if (typeof onProgress === 'function') {
              try { onProgress(parsed); } catch (_) {}
            }
            // Progress-Events auch global per IPC an alle offenen Fenster broadcasten
            // (Renderer haengt den Listener vor dem Click-Handler an).
            try {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('install-progress', parsed);
              }
            } catch (_) {}
          } else {
            finalResult = parsed;
          }
        } catch (_) {
          // Nicht-JSON-Zeilen ignorieren (z. B. print-Debug aus Python).
        }
      };

      proc.stdout.on('data', (d) => {
        const s = d.toString();
        out += s;
        lineBuf += s;
        let nl;
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          const rawLine = lineBuf.slice(0, nl).replace(/\r$/, '');
          lineBuf = lineBuf.slice(nl + 1);
          handleLine(rawLine);
        }
      });
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('close', (code) => {
        // Letzter unvollstaendiger Chunk noch einmal durchfuettern.
        if (lineBuf.trim()) handleLine(lineBuf);
        if (finalResult === null) {
          // Fallback auf legacy-Verhalten: letzte beliebige JSON-Zeile in stdout.
          const lines = out.trim().split(/\r?\n/).filter(Boolean);
          for (let i = lines.length - 1; i >= 0 && finalResult === null; i -= 1) {
            try {
              const j = JSON.parse(lines[i]);
              if (j && typeof j === 'object' && typeof j.event !== 'string') {
                finalResult = j;
              }
            } catch (_) {}
          }
        }
        if (finalResult !== null) {
          resolve({ code, json: finalResult, stderr: err });
        } else {
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

function isPortableExecutable() {
  return !!(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
}

// ───────────────────────────────────────────────────────────────────────────
// UAC-Relaunch: Wenn Skyrim unter C:\Program Files (x86)\… liegt, kann der
// nicht-elevated Prozess dort nicht schreiben. Wir bieten dem User an, den
// Launcher automatisch mit Admin-Rechten neu zu starten.
//
// Ablauf:
//   1) Python meldet error=needs_elevation (mit path=…).
//   2) Renderer ruft ipc 'relaunch-as-admin' auf.
//   3) Wir starten eine neue Launcher-Instanz per PowerShell
//      `Start-Process -Verb RunAs` (das triggert den UAC-Dialog).
//   4) Wenn der UAC-Prompt bestaetigt wird, schliessen wir die aktuelle
//      Instanz — die neue kommt hoch mit Admin-Token.
//   5) Wenn der UAC-Prompt abgelehnt wird (User klickt Abbrechen), werfen
//      wir einen Fehler zurueck und die aktuelle Instanz bleibt offen.
// ───────────────────────────────────────────────────────────────────────────

function isCurrentProcessElevated() {
  if (process.platform !== 'win32') return false;
  // net session klappt NUR als Admin, egal welche OS-Version. Das ist
  // der zuverlaessigste Shortcut ohne WinAPI-Bindings.
  return new Promise((resolve) => {
    execFile(
      'net',
      ['session'],
      { windowsHide: true },
      (err) => resolve(!err),
    );
  });
}

/**
 * Startet den Launcher per UAC-Prompt neu und beendet die aktuelle Instanz.
 * Gibt { ok:true } zurueck wenn UAC akzeptiert wurde (aktuelle Instanz
 * wird dann in 500ms beendet), { ok:false, reason } sonst.
 */
function relaunchAsAdmin() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, reason: 'not_windows' });
      return;
    }
    const target = process.execPath;
    // Wir geben dem neu gestarteten Prozess ein Flag mit, damit er sofort
    // den Install-Button triggert (optional — vorerst lassen wir den User
    // manuell "Aktualisieren" klicken, damit er sieht dass alles laeuft).
    const wd = path.dirname(target);
    const args = ['--fh-elevated-relaunch'];
    const argList = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
    const ps = argList
      ? `Start-Process -FilePath '${target.replace(/'/g, "''")}' -WorkingDirectory '${wd.replace(/'/g, "''")}' -Verb RunAs -ArgumentList ${argList}`
      : `Start-Process -FilePath '${target.replace(/'/g, "''")}' -WorkingDirectory '${wd.replace(/'/g, "''")}' -Verb RunAs`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          // ExitCode !=0 heisst normalerweise: User hat UAC abgebrochen
          // ODER der Start-Process-Call selber ist gescheitert.
          resolve({
            ok: false,
            reason: 'uac_cancelled_or_failed',
            detail: String((stderr || err.message || '').toString().trim()),
          });
          return;
        }
        // Nach erfolgreichem UAC-Prompt: kurz warten (die neue Instanz
        // braucht ~1-2s bis ihr Fenster oben ist) und dann die aktuelle
        // ordentlich beenden.
        setTimeout(() => {
          try { app.quit(); } catch (_) {}
          setTimeout(() => { try { process.exit(0); } catch (_) {} }, 500);
        }, 500);
        resolve({ ok: true });
      },
    );
  });
}

ipcMain.handle('is-elevated', async () => {
  try {
    const r = await isCurrentProcessElevated();
    return { ok: true, elevated: !!r };
  } catch (e) {
    return { ok: false, elevated: false, error: String(e.message || e) };
  }
});

ipcMain.handle('relaunch-as-admin', async () => {
  try {
    return await relaunchAsAdmin();
  } catch (e) {
    return { ok: false, reason: 'error', detail: String(e.message || e) };
  }
});

/** Optional: in frostmp-launcher.json "launcher_update_feed_url": "https://…/ordner-mit-latest-yml/" (generic provider) */
function configureAutoUpdaterFeedFromConfig() {
  const cfg = loadLocalConfig();
  const u = typeof cfg.launcher_update_feed_url === 'string' ? cfg.launcher_update_feed_url.trim().replace(/\/$/, '') : '';
  if (!u) return;
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: u });
  } catch (e) {
    console.error('[updater] setFeedURL', e);
  }
}

let launcherUpdaterStarted = false;

function setupLauncherAutoUpdater() {
  if (!app.isPackaged || launcherUpdaterStarted) return;
  if (isPortableExecutable()) return;
  if (process.platform !== 'win32') return;

  launcherUpdaterStarted = true;
  configureAutoUpdaterFeedFromConfig();

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    const msg = String((err && err.message) || err);
    if (/404|Not Found|No published versions|net::ERR_/i.test(msg)) return;
    console.error('[updater]', err);
  });

  autoUpdater.on('update-downloaded', (info) => {
    const parent = BrowserWindow.getFocusedWindow() || mainWindow;
    dialog
      .showMessageBox(parent || undefined, {
        type: 'info',
        title: 'Launcher-Update',
        message: `Version ${info.version} wurde heruntergeladen.`,
        detail:
          'Die Installation erfolgt beim nächsten Schließen des Launchers automatisch — oder du startest jetzt neu.',
        buttons: ['Jetzt neu starten', 'Später'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then((r) => {
        if (r.response === 0) {
          try {
            autoUpdater.quitAndInstall(false, true);
          } catch (e) {
            console.error('[updater] quitAndInstall', e);
          }
        }
      })
      .catch(() => {});
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch(() => {});
  };
  setTimeout(check, 12000);
  setInterval(check, 6 * 60 * 60 * 1000);
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
  setupLauncherAutoUpdater();
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
    profile_id: 0,
    skyrim_dir: '',
    client_dist_source: '',
    status_url: DEFAULT_STATUS_URL,
    launcher_update_feed_url: '',
    frosthold_chat_enabled: false,
    frosthold_chat_ws_url: '',
    frosthold_chat_user_id: '',
    frosthold_chat_secret: '',
  };
  return { ...defaults, ...local };
});

ipcMain.handle('server-status-ping', async () => {
  const local = loadLocalConfig();
  return pingServerStatusFromMain(local.status_url || DEFAULT_STATUS_URL);
});

ipcMain.handle('save-config', async (_e, cfg) => {
  const prev = loadLocalConfig();
  const defaults = {
    server_ip: '188.245.77.170',
    server_port: 7777,
    profile_id: 0,
    skyrim_dir: '',
    client_dist_source: '',
    status_url: DEFAULT_STATUS_URL,
    launcher_update_feed_url: '',
    frosthold_chat_enabled: false,
    frosthold_chat_ws_url: '',
    frosthold_chat_user_id: '',
    frosthold_chat_secret: '',
  };
  const merged = { ...defaults, ...prev };
  if (cfg && typeof cfg === 'object') {
    if (typeof cfg.server_ip === 'string') merged.server_ip = cfg.server_ip.trim() || defaults.server_ip;
    if (typeof cfg.skyrim_dir === 'string') merged.skyrim_dir = cfg.skyrim_dir.trim();
    if (typeof cfg.server_port === 'number' && Number.isFinite(cfg.server_port)) merged.server_port = cfg.server_port;
    if (typeof cfg.profile_id === 'number' && Number.isFinite(cfg.profile_id)) merged.profile_id = cfg.profile_id;
    if (typeof cfg.client_dist_source === 'string') merged.client_dist_source = cfg.client_dist_source.trim();
    if (typeof cfg.status_url === 'string') merged.status_url = cfg.status_url.trim();
    if (typeof cfg.launcher_update_feed_url === 'string') merged.launcher_update_feed_url = cfg.launcher_update_feed_url.trim();
    if (typeof cfg.frosthold_chat_enabled === 'boolean') merged.frosthold_chat_enabled = cfg.frosthold_chat_enabled;
    if (typeof cfg.frosthold_chat_ws_url === 'string') merged.frosthold_chat_ws_url = cfg.frosthold_chat_ws_url.trim();
    if (typeof cfg.frosthold_chat_user_id === 'string') merged.frosthold_chat_user_id = cfg.frosthold_chat_user_id.trim();
    if (typeof cfg.frosthold_chat_secret === 'string') merged.frosthold_chat_secret = cfg.frosthold_chat_secret.trim();
  }
  merged.server_port = 7777;
  if (!merged.server_ip) merged.server_ip = defaults.server_ip;
  if (!merged.status_url) merged.status_url = defaults.status_url;
  // profile_id NIE automatisch auf 1 ziehen — nur Discord-Login darf ihn setzen.
  if (merged.profile_id == null || typeof merged.profile_id !== 'number' || merged.profile_id < 0) {
    merged.profile_id = 0;
  }
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

/**
 * Stellt sicher, dass profile_id in der lokalen Config aktuell ist.
 * Wird vor jedem Play/Setup aufgerufen.
 *
 * Logik:
 * - Keine Session-Datei: profile_id wird auf 0 gesetzt (blockt Play mit login_required).
 * - Session vorhanden & Chat-Server bestaetigt sie: profile_id wird uebernommen.
 * - Session vorhanden, Chat-Server sagt explizit 'ungueltig': lokale Session +
 *   profile_id werden geloescht (blockt Play, User muss sich neu anmelden).
 * - Chat-Server nicht erreichbar (Netzwerkfehler): letzte bekannte profile_id
 *   bleibt bestehen (offline-Toleranz, damit voruebergehende Stoerung nicht
 *   alle User aussperrt).
 */
async function syncProfileIdFromSession() {
  const session = loadDiscordSession();
  const prev = loadLocalConfig();
  const token = session && typeof session.sessionToken === 'string' ? session.sessionToken.trim() : '';

  if (!token) {
    if (prev.profile_id && prev.profile_id !== 0) {
      prev.profile_id = 0;
      saveLocalConfig(prev);
    }
    return 0;
  }

  const result = await refreshSessionFromChatServer(token);

  if (result.status === 'ok' && result.session && typeof result.session.profileId === 'number'
      && Number.isFinite(result.session.profileId) && result.session.profileId >= 1) {
    const pid = Math.floor(result.session.profileId);
    if (prev.profile_id !== pid) {
      prev.profile_id = pid;
      saveLocalConfig(prev);
    }
    // Verifizierten Wert zusaetzlich in die Session-Datei schreiben. Diese ist
    // die "Quelle der Wahrheit" fuer offline-Fallbacks — damit kein Angreifer
    // durch manuelles Editieren der launcher-config.json einen fremden Char
    // uebernehmen kann.
    const sessionFile = { ...(session || {}), sessionToken: token, profileId: pid };
    try { saveDiscordSession(sessionFile); } catch (_) {}
    return pid;
  }

  if (result.status === 'invalid') {
    // Session wurde vom Chat-Server explizit abgelehnt -> lokal alles
    // wegraeumen, damit kein alter profile_id haengenbleibt.
    clearDiscordSession();
    prev.profile_id = 0;
    prev.frosthold_chat_user_id = '';
    prev.frosthold_chat_secret = '';
    saveLocalConfig(prev);
    return 0;
  }

  // status === 'unreachable' -> letzte VOM CHAT-SERVER VERIFIZIERTE profile_id
  // aus der Session-Datei (nicht aus der launcher-config, die koennte manipuliert
  // sein). Wenn die Session noch nie verifiziert wurde, blocken wir sicherheits-
  // halber mit profile_id=0.
  const verifiedPid = session && typeof session.profileId === 'number'
    && Number.isFinite(session.profileId) && session.profileId >= 1
    ? Math.floor(session.profileId)
    : 0;
  if (prev.profile_id !== verifiedPid) {
    prev.profile_id = verifiedPid;
    saveLocalConfig(prev);
  }
  return verifiedPid;
}

ipcMain.handle('play', async () => {
  const py = getPythonScriptPath();
  if (!py) {
    return { ok: false, error: 'python_script_missing', message: 'FrostMP-Launcher.py nicht gefunden (Ordner Frosthold Server).' };
  }
  try {
    await syncProfileIdFromSession();
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
    await syncProfileIdFromSession();
    const r = await runPythonJson(['--json-setup']);
    if (r.json) return r.json;
    return { ok: false, error: 'bad_response', raw: r.raw, stderr: r.stderr };
  } catch (e) {
    return { ok: false, error: 'spawn', message: String(e.message || e) };
  }
});

/** Setzt client_force_update_once in frostmp-launcher.json — nächster Setup lädt die Client-Dist erneut. */
ipcMain.handle('check-launcher-updates', async () => {
  if (!app.isPackaged || isPortableExecutable() || process.platform !== 'win32') {
    return { ok: false, reason: 'not_applicable' };
  }
  try {
    configureAutoUpdaterFeedFromConfig();
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, updateInfo: r && r.updateInfo ? r.updateInfo : null };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
});

ipcMain.handle('force-client-refresh', async () => {
  try {
    const prev = loadLocalConfig();
    saveLocalConfig({ ...prev, client_force_update_once: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
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

// ────────────────────────────────────────────────────────
// Discord OAuth2 Login
// ────────────────────────────────────────────────────────

const DISCORD_CLIENT_ID = '1494190090480517180';
const DISCORD_REDIRECT_URI = 'http://localhost:39015/callback';
const DISCORD_SCOPES = 'identify';

function getDiscordSessionPath() {
  return path.join(app.getPath('userData'), 'discord-session.json');
}

function loadDiscordSession() {
  try {
    const p = getDiscordSessionPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {}
  return null;
}

function saveDiscordSession(session) {
  fs.writeFileSync(getDiscordSessionPath(), JSON.stringify(session, null, 2), 'utf8');
}

function clearDiscordSession() {
  try { fs.unlinkSync(getDiscordSessionPath()); } catch (_) {}
}

/** Starts a one-shot HTTP server to capture the OAuth2 callback, returns the auth code. */
function waitForOAuthCallback(timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:39015`);
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (code) {
          res.end('<html><body style="background:#1a1a2e;color:#eee;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>Anmeldung erfolgreich! Du kannst dieses Fenster schließen.</h2></body></html>');
        } else {
          res.end('<html><body style="background:#1a1a2e;color:#eee;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>Anmeldung fehlgeschlagen. Bitte versuche es erneut.</h2></body></html>');
        }
        cleanup();
        if (error) reject(new Error(`Discord OAuth error: ${error}`));
        else if (code) resolve(code);
        else reject(new Error('No code received'));
      }
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('OAuth timeout'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      try { server.close(); } catch (_) {}
    }

    server.on('error', (err) => {
      cleanup();
      reject(err);
    });

    server.listen(39015);
  });
}

/** Extrahiert Host des Chat-Servers aus der WebSocket-URL in der Config. */
function getChatServerHost() {
  const cfg = loadLocalConfig();
  const wsUrl = String(cfg.frosthold_chat_ws_url || '').trim();
  const match = wsUrl.match(/^wss?:\/\/([^:/]+)/);
  return match ? match[1] : '188.245.77.170';
}

/**
 * Fragt beim Chat-Server nach: existiert die Session-ID noch + welche profile_id
 * gehoert dazu?
 *
 * Return-Format:
 *   { status: 'ok', session: {...} }       - Session gueltig
 *   { status: 'invalid' }                  - Chat-Server kennt die Session nicht
 *                                            mehr (abgelaufen / Server-Restart /
 *                                            manuell invalidiert) -> User muss
 *                                            neu einloggen
 *   { status: 'unreachable' }              - Netzwerkfehler, Server erreicht nicht
 *                                            -> letzte bekannte profile_id behalten
 */
async function refreshSessionFromChatServer(sessionToken) {
  if (!sessionToken || typeof sessionToken !== 'string') {
    return { status: 'invalid' };
  }
  const host = getChatServerHost();
  const httpPort = 3212;

  return new Promise((resolve) => {
    const req = http.request({
      hostname: host,
      port: httpPort,
      path: `/auth/session?token=${encodeURIComponent(sessionToken)}`,
      method: 'GET',
      timeout: 8000,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const j = JSON.parse(body);
            if (j && typeof j === 'object') {
              resolve({ status: 'ok', session: j });
              return;
            }
          } catch {}
          resolve({ status: 'invalid' });
          return;
        }
        // 401/400 = Server kennt den Endpoint und hat den Token explizit abgelehnt.
        if (res.statusCode === 401 || res.statusCode === 400) {
          resolve({ status: 'invalid' });
          return;
        }
        // 404 behandeln wir bewusst als "unreachable": das ist in der Praxis ein
        // Hinweis auf einen legacy Chat-Server ohne /auth/session-Endpoint.
        // Hier die Session zu loeschen waere destruktiv — wir fallen stattdessen
        // auf die lokal in discord-session.json verifizierte profileId zurueck.
        if (res.statusCode === 404) {
          resolve({ status: 'unreachable', reason: 'endpoint_not_found' });
          return;
        }
        resolve({ status: 'unreachable' });
      });
    });
    req.on('error', () => resolve({ status: 'unreachable' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 'unreachable' }); });
    req.end();
  });
}

/** Exchanges the auth code with our chat server for a session. */
async function exchangeCodeWithChatServer(code) {
  const host = getChatServerHost();
  const httpPort = 3212;

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ code });
    const req = http.request({
      hostname: host,
      port: httpPort,
      path: '/auth/discord',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (res.statusCode === 200 && j.sessionToken) {
            resolve(j);
          } else {
            reject(new Error(j.error || `HTTP ${res.statusCode}`));
          }
        } catch {
          reject(new Error('Invalid response from chat server'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Chat server timeout')); });
    req.write(postData);
    req.end();
  });
}

ipcMain.handle('discord-login', async () => {
  try {
    const callbackPromise = waitForOAuthCallback();

    const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}&response_type=code&scope=${DISCORD_SCOPES}`;
    await shell.openExternal(authUrl);

    const code = await callbackPromise;
    const session = await exchangeCodeWithChatServer(code);

    // Alter Chat-Server (vor Launcher 0.2.5) liefert KEINE profileId zurueck.
    // Ohne profileId kann der Launcher keinen eindeutigen Charakter-Slot
    // zuweisen — dann DÜRFEN wir die Session nicht speichern, sonst landen
    // alle Spieler wieder auf profile_id=1 (Char-Hijack).
    const hasProfileId = typeof session.profileId === 'number'
      && Number.isFinite(session.profileId)
      && session.profileId >= 1;

    if (!hasProfileId) {
      return {
        ok: false,
        error: 'chat_server_outdated',
        message: (
          'Der FrostholdRP-Chat-Server lauft noch in einer aelteren Version und '
          + 'vergibt noch keine eindeutige Charakter-ID. Der Admin muss den Server '
          + 'zuerst aktualisieren (Deploy von chat-server/server.mjs). Bis dahin '
          + 'kannst du dich nicht anmelden.'
        ),
      };
    }

    const pid = Math.floor(session.profileId);
    const sessionToStore = { ...session, profileId: pid };
    saveDiscordSession(sessionToStore);

    // Update chat credentials in launcher config
    const prev = loadLocalConfig();
    prev.frosthold_chat_enabled = true;
    prev.frosthold_chat_user_id = session.sessionToken;
    prev.frosthold_chat_secret = session.sessionToken;
    prev.profile_id = pid;
    saveLocalConfig(prev);

    return { ok: true, ...sessionToStore };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('discord-logout', async () => {
  clearDiscordSession();
  const prev = loadLocalConfig();
  prev.frosthold_chat_user_id = '';
  prev.frosthold_chat_secret = '';
  // Nach Logout profile_id zuruecksetzen, damit die naechste Person am Rechner
  // nicht aus Versehen auf dem vorherigen Charakter spielt. Neuer Discord-Login
  // vergibt beim Einloggen den passenden profile_id neu.
  prev.profile_id = 0;
  saveLocalConfig(prev);
  return { ok: true };
});

ipcMain.handle('discord-session', async () => {
  return loadDiscordSession();
});
