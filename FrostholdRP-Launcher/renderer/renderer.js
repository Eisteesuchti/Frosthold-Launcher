/* global fh */

const $ = (id) => document.getElementById(id);

async function loadNews() {
  try {
    let data = null;
    const ipc = await fh.loadNewsJson();
    if (ipc && ipc.ok && Array.isArray(ipc.data)) data = ipc.data;
    if (!data) {
      const res = await fetch('../news.json');
      data = await res.json();
    }
    const container = $('news-cards');
    container.innerHTML = '';
    const items = Array.isArray(data) ? data.slice(0, 3) : [];
    const fallbacks = [
      { category: 'ANKUENDIGUNG', title: 'Willkommen bei FrostholdRP!', date: '—' },
      { category: 'EVENT', title: 'Neuigkeiten folgen', date: '—' },
      { category: 'UPDATE', title: 'Launcher', date: '—' },
    ];
    const show = items.length ? items : fallbacks;
    show.forEach((n) => {
      const cat = (n.category || 'UPDATE').replace(/\s/g, '');
      const card = document.createElement('div');
      card.className = 'news-card';
      card.innerHTML = `
        <span class="badge badge-${cat}">${n.category || 'UPDATE'}</span>
        <h3>${escapeHtml(n.title || '')}</h3>
        <div class="date">${escapeHtml(n.date || '')}</div>
      `;
      container.appendChild(card);
    });
  } catch {
    $('news-cards').innerHTML = '<p style="color:#8aa0b8">News konnten nicht geladen werden.</p>';
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

let cfgCache = {};
let toastTimer = null;

async function refreshServerStatus() {
  const pill = $('server-pill');
  const text = $('status-text');
  const players = $('player-count');
  const c = await fh.loadConfig();
  cfgCache = c;

  pill.classList.remove('online', 'offline');
  text.textContent = 'PRÜFE…';
  players.textContent = '';

  try {
    const r = await fh.serverStatusPing();
    if (r && r.ok) {
      pill.classList.add('online');
      text.textContent = 'ONLINE';
      players.textContent = '';
    } else {
      pill.classList.add('offline');
      text.textContent = 'OFFLINE';
    }
  } catch {
    pill.classList.add('offline');
    text.textContent = 'OFFLINE';
  }
}

function showToast(msg, ms = 8000) {
  const el = $('toast');
  el.classList.remove('fading-out');
  el.textContent = msg;
  el.hidden = false;

  if (toastTimer) clearTimeout(toastTimer);

  const fadeStart = Math.max(ms - 500, 500);
  toastTimer = setTimeout(() => {
    el.classList.add('fading-out');
    setTimeout(() => { el.hidden = true; el.classList.remove('fading-out'); }, 500);
  }, fadeStart);
}

async function fillSettings() {
  const c = await fh.loadConfig();
  $('set-ip').value = c.server_ip || '188.245.77.170';
  $('set-skyrim').value = c.skyrim_dir || '';
}

// ────────────────────────────────────────────────────────
// Download- / Install-Fortschritt (live aus dem Python-Backend)
// ────────────────────────────────────────────────────────

/**
 * Formatiert ein Byte-Zaehler-Paar menschenlesbar, z. B. "42,3 MB / 101 MB".
 */
function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  const units = ['B', 'kB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits).replace('.', ',')} ${units[i]}`;
}

let progressHideTimer = null;
// Nur wenn true zeigt der Event-Listener das Panel aktiv an. Wird vom
// "Aktualisieren"-Handler auf true gesetzt, damit Background-Events (z. B. vom
// Play-Handler, der intern ein automatisches Client-Refresh auslöst) das Panel
// NICHT ungefragt einblenden.
let progressPanelActive = false;

function showProgressPanel() {
  if (progressHideTimer) { clearTimeout(progressHideTimer); progressHideTimer = null; }
  progressPanelActive = true;
  const panel = $('progress-panel');
  if (panel) panel.hidden = false;
}

function hideProgressPanel(delayMs = 0) {
  const panel = $('progress-panel');
  if (!panel) return;
  if (progressHideTimer) { clearTimeout(progressHideTimer); progressHideTimer = null; }
  const doHide = () => {
    progressPanelActive = false;
    panel.hidden = true;
    resetProgressUi();
  };
  if (delayMs > 0) {
    progressHideTimer = setTimeout(doHide, delayMs);
  } else {
    doHide();
  }
}

function resetProgressUi() {
  const lab = $('progress-label');
  const pct = $('progress-percent');
  const fill = $('progress-fill');
  const meta = $('progress-meta');
  const track = $('progress-track');
  if (lab) lab.textContent = 'Installation wird vorbereitet…';
  if (pct) pct.textContent = '—';
  if (fill) {
    fill.style.width = '0%';
    fill.classList.remove('indeterminate');
  }
  if (meta) meta.innerHTML = '&nbsp;';
  if (track) track.setAttribute('aria-valuenow', '0');
}

/**
 * Konsumiert ein Event-Objekt vom Python-Backend und rendert es in den
 * Fortschrittsbalken. Unterstuetzt "progress" (mit percent) und "status"
 * (indeterminate, zeigt Spinner-Stripe).
 */
function applyProgressEvent(evt) {
  if (!evt || typeof evt !== 'object') return;
  const panel = $('progress-panel');
  if (!panel) return;
  // WICHTIG: Panel nur anzeigen, wenn der User vorher ein explizites Update
  // angestossen hat (progressPanelActive=true). Bei reinen Background-
  // Events (z. B. automatisches Client-Refresh waehrend "Spielen") schreiben
  // wir den Fortschritt still in die UI, ohne das Panel aufzublenden.
  if (!progressPanelActive) return;

  const lab = $('progress-label');
  const pct = $('progress-percent');
  const fill = $('progress-fill');
  const meta = $('progress-meta');
  const track = $('progress-track');

  if (evt.event === 'progress') {
    const label = evt.label || 'Installation…';
    if (lab) lab.textContent = label;

    if (typeof evt.percent === 'number' && Number.isFinite(evt.percent)) {
      const clamped = Math.max(0, Math.min(100, evt.percent));
      if (fill) {
        fill.classList.remove('indeterminate');
        fill.style.width = `${clamped}%`;
      }
      if (pct) pct.textContent = `${clamped.toFixed(1).replace('.', ',')} %`;
      if (track) track.setAttribute('aria-valuenow', String(Math.round(clamped)));
    } else {
      if (fill) fill.classList.add('indeterminate');
      if (pct) pct.textContent = '…';
    }

    if (meta) {
      const done = Number(evt.bytesDone);
      const total = Number(evt.bytesTotal);
      if (Number.isFinite(total) && total > 0) {
        // bytesDone/bytesTotal koennen bei Zips auch Datei-Zaehler sein —
        // Heuristik: kleine Zahlen < 1 MB sind vermutlich Datei-Counts,
        // ansonsten echte Bytes.
        if (total < 1024 * 1024 && total < 5000) {
          meta.textContent = `${done} / ${total} Dateien`;
        } else {
          const a = formatBytes(done);
          const b = formatBytes(total);
          meta.textContent = a && b ? `${a} / ${b}` : '';
        }
      } else {
        meta.innerHTML = '&nbsp;';
      }
    }
    return;
  }

  if (evt.event === 'status') {
    if (lab && typeof evt.message === 'string') lab.textContent = evt.message;
    if (fill) fill.classList.add('indeterminate');
    if (pct) pct.textContent = '…';
    if (meta) meta.innerHTML = '&nbsp;';
    if (track) track.removeAttribute('aria-valuenow');
  }
}

// Globaler Listener — aktiv waehrend das Panel sichtbar ist.
if (fh && typeof fh.onInstallProgress === 'function') {
  fh.onInstallProgress((evt) => applyProgressEvent(evt));
}

async function openSettings() {
  await fillSettings();
  $('settings-overlay').hidden = false;
}

function closeSettings() {
  $('settings-overlay').hidden = true;
}

let lastSkyrimWarning = 0;

async function refreshLauncherState() {
  const play = $('btn-play');
  const upd = $('btn-update');

  let s;
  try {
    s = await fh.skyrimStatus();
  } catch {
    play.hidden = true;
    upd.hidden = true;
    return;
  }

  console.log('[FH] skyrimStatus:', JSON.stringify(s));

  if (!s || s.error) {
    play.hidden = true;
    upd.hidden = true;
    return;
  }

  const skyrimOk = s.skyrim_effective != null;
  if (!skyrimOk) {
    play.hidden = true;
    upd.hidden = true;
    const now = Date.now();
    if (now - lastSkyrimWarning > 30000) {
      lastSkyrimWarning = now;
      showToast('Skyrim SE nicht gefunden — bitte Pfad in den Einstellungen setzen.', 8000);
    }
    return;
  }

  if (s.pending_setup) {
    upd.hidden = false;
    upd.disabled = false;
    play.hidden = true;
  } else {
    play.hidden = false;
    play.disabled = false;
    upd.hidden = true;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const logo = $('logo-img');
  logo.onerror = () => {
    logo.style.display = 'none';
    const fb = document.createElement('div');
    fb.className = 'logo-fallback';
    fb.textContent = '❄';
    logo.parentNode.insertBefore(fb, logo);
  };

  loadNews();
  refreshLauncherState();
  refreshServerStatus();

  // Silent auto-refresh every 10 seconds
  setInterval(refreshLauncherState, 10000);
  setInterval(refreshServerStatus, 5000);

  $('btn-min').addEventListener('click', () => fh.minimize());
  $('btn-close').addEventListener('click', () => fh.close());
  $('btn-settings').addEventListener('click', openSettings);
  $('set-cancel').addEventListener('click', closeSettings);
  $('set-save').addEventListener('click', async () => {
    await fh.saveConfig({
      server_ip: $('set-ip').value.trim(),
      skyrim_dir: $('set-skyrim').value.trim(),
    });
    showToast('Einstellungen gespeichert.', 4000);
    closeSettings();
    refreshServerStatus();
    refreshLauncherState();
  });

  $('settings-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('settings-overlay').hidden) {
      e.preventDefault();
      closeSettings();
    }
  });

  $('btn-update').addEventListener('click', async () => {
    const btn = $('btn-update');
    const lab = $('btn-update-label');
    if (btn.disabled) return;

    // Ohne Discord-Login bringt Aktualisieren nichts — Python blockt sowieso.
    // Frueh abfangen, damit das Panel nicht kurz aufblitzt.
    const session = await fh.discordSession();
    if (!session || !session.displayName) {
      showToast('Du musst dich zuerst mit Discord anmelden, damit dir ein Charakter-Slot zugewiesen werden kann.', 8000);
      const loginBtn = $('btn-discord-login');
      if (loginBtn) loginBtn.classList.add('highlight-pulse');
      setTimeout(() => { if (loginBtn) loginBtn.classList.remove('highlight-pulse'); }, 3000);
      return;
    }

    lab.textContent = 'Installiere…';
    btn.disabled = true;
    resetProgressUi();
    showProgressPanel();
    try {
      const r = await fh.setup();
      if (r && r.ok) {
        showToast(r.message || 'Installation abgeschlossen.', 6000);
        hideProgressPanel(1200);
      } else if (r && r.error === 'login_required') {
        showToast(r.message || 'Bitte zuerst mit Discord anmelden.', 8000);
        hideProgressPanel(0);
        const loginBtn = $('btn-discord-login');
        if (loginBtn) loginBtn.classList.add('highlight-pulse');
        setTimeout(() => { if (loginBtn) loginBtn.classList.remove('highlight-pulse'); }, 3000);
      } else {
        const msg = (r && r.message) || (r && r.error) || JSON.stringify(r);
        showToast(`Fehler: ${msg}`, 8000);
        hideProgressPanel(0);
      }
    } catch (e) {
      showToast(`Fehler: ${e}`, 8000);
      hideProgressPanel(0);
    } finally {
      lab.textContent = 'Aktualisieren';
      btn.disabled = false;
      await refreshLauncherState();
    }
  });

  // ── Discord Login ──
  async function refreshDiscordUI() {
    const session = await fh.discordSession();
    const label = $('discord-login-label');
    const btn = $('btn-discord-login');
    if (session && session.displayName) {
      label.textContent = session.displayName;
      btn.title = `Angemeldet als ${session.displayName} (Klick = Abmelden)`;
      btn.dataset.loggedIn = '1';
    } else {
      label.textContent = 'Anmelden';
      btn.title = 'Mit Discord anmelden';
      btn.dataset.loggedIn = '';
    }
  }
  refreshDiscordUI();

  $('btn-discord-login').addEventListener('click', async () => {
    const btn = $('btn-discord-login');
    if (btn.disabled) return;

    if (btn.dataset.loggedIn === '1') {
      await fh.discordLogout();
      showToast('Discord-Abmeldung erfolgreich.', 4000);
      await refreshDiscordUI();
      return;
    }

    btn.disabled = true;
    $('discord-login-label').textContent = 'Warte…';
    showToast('Browser wird geöffnet — bitte bei Discord anmelden…', 8000);
    try {
      const r = await fh.discordLogin();
      if (r && r.ok) {
        showToast(`Angemeldet als ${r.displayName}!`, 5000);
      } else if (r && r.error === 'chat_server_outdated') {
        showToast(r.message || 'Der FrostholdRP-Chat-Server ist veraltet — bitte warte, bis der Admin ihn aktualisiert hat.', 14000);
      } else {
        showToast(`Anmeldung fehlgeschlagen: ${(r && (r.message || r.error)) || 'Unbekannt'}`, 8000);
      }
    } catch (e) {
      showToast(`Fehler: ${e}`, 8000);
    } finally {
      btn.disabled = false;
      await refreshDiscordUI();
    }
  });

  $('btn-play').addEventListener('click', async () => {
    const btn = $('btn-play');

    const session = await fh.discordSession();
    if (!session || !session.displayName) {
      showToast('Du musst dich zuerst mit Discord anmelden, bevor du spielen kannst.', 8000);
      const loginBtn = $('btn-discord-login');
      if (loginBtn) loginBtn.classList.add('highlight-pulse');
      setTimeout(() => { if (loginBtn) loginBtn.classList.remove('highlight-pulse'); }, 3000);
      return;
    }

    btn.disabled = true;
    showToast('Starte FrostholdRP…', 2000);
    // Beim "Spielen" zeigen wir das Progress-Panel absichtlich nicht — kein
    // Update ansteht sichtbar. Falls im Hintergrund doch ein automatisches
    // Client-Refresh läuft, arbeitet der globale Listener still.
    try {
      const r = await fh.play();
      if (r && r.ok) {
        showToast('Skyrim wird mit SKSE gestartet. Du kannst den Launcher schließen.', 6000);
      } else if (r && r.error === 'login_required') {
        // Session im Chat-Server nicht mehr gueltig (Server-Neustart o. ae.)
        // -> User soll sich per Discord neu anmelden.
        showToast(r.message || 'Bitte erneut mit Discord anmelden.', 8000);
        await fh.discordLogout();
        await refreshDiscordUI();
        const loginBtn = $('btn-discord-login');
        if (loginBtn) loginBtn.classList.add('highlight-pulse');
        setTimeout(() => { if (loginBtn) loginBtn.classList.remove('highlight-pulse'); }, 3000);
      } else {
        const msg = (r && r.message) || (r && r.error) || JSON.stringify(r);
        showToast(`Fehler: ${msg}`, 8000);
        await refreshLauncherState();
      }
    } catch (e) {
      showToast(`Fehler: ${e}`, 8000);
    } finally {
      btn.disabled = false;
    }
  });
});
