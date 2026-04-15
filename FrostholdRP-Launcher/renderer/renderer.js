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

let statusTimer = null;
let cfgCache = {};

async function refreshServerStatus() {
  const pill = $('server-pill');
  const dot = $('status-dot');
  const text = $('status-text');
  const players = $('player-count');
  const c = await fh.loadConfig();
  cfgCache = c;
  const url = (c.status_url || 'http://188.245.77.170:3000/').replace(/\/$/, '') + '/';

  pill.classList.remove('online', 'offline');
  text.textContent = 'PRÜFE…';
  players.textContent = '';

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (res.ok) {
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

function showToast(msg, ms = 5000) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, ms);
}

async function runQuickHealthCheck() {
  const strip = $('quick-check-strip');
  const titleEl = $('quick-check-title');
  const msgEl = $('quick-check-msg');
  const policyEl = $('policy-hint');
  const iconEl = $('quick-check-icon');
  if (!strip || sessionStorage.getItem('fh-quickcheck-dismiss') === '1') return;

  titleEl.textContent = 'Schnellprüfung';
  msgEl.textContent = 'Prüfe Installation und Server-Client…';
  strip.hidden = false;
  strip.classList.remove('state-ok', 'state-warn', 'state-bad');
  strip.classList.add('state-warn');
  policyEl.textContent = '';

  let h;
  try {
    h = await fh.quickHealthCheck();
  } catch (e) {
    msgEl.textContent = `Prüfung fehlgeschlagen: ${e}`;
    strip.classList.add('state-bad');
    return;
  }

  const md = h.manifest && h.manifest.ok ? h.manifest.data : null;
  if (md && md.policyDe && md.policyDe.body) {
    policyEl.textContent = md.policyDe.body;
  }

  const s = h.status;
  const qd = md && md.quickCheckDe ? md.quickCheckDe : {};
  if (!s || s.error === 'bad_json') {
    msgEl.textContent = 'Python-Backend antwortet nicht. Die Runtime liegt im Launcher—bei fehlenden Dateien Neuinstallation versuchen.';
    strip.classList.remove('state-warn');
    strip.classList.add('state-bad');
    iconEl.textContent = '✕';
    return;
  }
  if (s.error) {
    msgEl.textContent = String(s.error);
    strip.classList.remove('state-warn');
    strip.classList.add('state-bad');
    iconEl.textContent = '✕';
    return;
  }

  if (!s.skyrim_effective) {
    msgEl.textContent = qd.noSkyrim || 'Skyrim SE nicht gefunden.';
    strip.classList.remove('state-warn');
    strip.classList.add('state-bad');
    iconEl.textContent = '!';
    return;
  }

  if (s.ready_to_play) {
    msgEl.textContent = qd.ready || 'Komponenten (SKSE, Client, …) sind vorhanden.';
    strip.classList.remove('state-warn');
    strip.classList.add('state-ok');
    iconEl.textContent = '✓';
  } else {
    msgEl.textContent = qd.missing || 'Es fehlen noch Teile — „Aktualisieren“ installiert sie.';
    strip.classList.remove('state-warn');
    strip.classList.add('state-warn');
    iconEl.textContent = '◆';
  }
}

async function fillSettings() {
  const c = await fh.loadConfig();
  $('set-ip').value = c.server_ip || '188.245.77.170';
  $('set-skyrim').value = c.skyrim_dir || '';
}

async function openSettings() {
  await fillSettings();
  $('settings-overlay').hidden = false;
}

function closeSettings() {
  $('settings-overlay').hidden = true;
}

async function refreshLauncherState() {
  const play = $('btn-play');
  const upd = $('btn-update');
  let s;
  try {
    s = await fh.skyrimStatus();
  } catch (e) {
    play.hidden = true;
    upd.hidden = false;
    upd.disabled = true;
    upd.title = 'Status konnte nicht geladen werden.';
    return;
  }

  if (s && s.error === 'bad_json') {
    play.hidden = true;
    upd.hidden = false;
    upd.disabled = true;
    upd.title = 'FrostMP-Launcher.py antwortet nicht wie erwartet.';
    return;
  }

  const ready = s.ready_to_play === true;
  const skyrimOk = s.skyrim_effective != null;

  if (ready) {
    play.hidden = false;
    play.disabled = false;
    upd.hidden = true;
    upd.disabled = false;
    upd.title = 'SKSE und Client-Dateien prüfen und installieren';
  } else {
    play.hidden = true;
    upd.hidden = false;
    upd.disabled = !skyrimOk;
    upd.title = skyrimOk
      ? 'Lädt fehlende Dateien (SKSE, Client …) und richtet alles ein.'
      : 'Skyrim Special Edition wurde nicht gefunden — bitte über Steam installieren oder Pfad in den Einstellungen.';
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

  const crest = $('hero-crest-img');
  if (crest) {
    crest.onerror = () => {
      const panel = document.querySelector('.hero-crest-panel');
      if (panel) panel.style.display = 'none';
    };
  }

  loadNews();
  runQuickHealthCheck();
  refreshLauncherState();
  refreshServerStatus();

  const qdismiss = $('quick-check-dismiss');
  if (qdismiss) {
    qdismiss.addEventListener('click', () => {
      sessionStorage.setItem('fh-quickcheck-dismiss', '1');
      $('quick-check-strip').hidden = true;
    });
  }
  statusTimer = setInterval(refreshServerStatus, 60000);
  setInterval(refreshLauncherState, 120000);

  $('btn-min').addEventListener('click', () => fh.minimize());
  $('btn-close').addEventListener('click', () => fh.close());
  $('btn-settings').addEventListener('click', openSettings);
  $('set-cancel').addEventListener('click', closeSettings);
  $('set-save').addEventListener('click', async () => {
    await fh.saveConfig({
      server_ip: $('set-ip').value.trim(),
      skyrim_dir: $('set-skyrim').value.trim(),
    });
    showToast('Einstellungen gespeichert.');
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
    lab.textContent = 'Installiere…';
    btn.disabled = true;
    showToast('Prüfe Installation und lade fehlende Dateien — das kann einige Minuten dauern…', 10000);
    try {
      const r = await fh.setup();
      if (r && r.ok) {
        showToast(r.message || 'Installation abgeschlossen.', 7000);
      } else {
        const msg = (r && r.message) || (r && r.error) || JSON.stringify(r);
        showToast(`Fehler: ${msg}`, 16000);
      }
    } catch (e) {
      showToast(`Fehler: ${e}`, 12000);
    } finally {
      lab.textContent = 'Aktualisieren';
      await refreshLauncherState();
      sessionStorage.removeItem('fh-quickcheck-dismiss');
      await runQuickHealthCheck();
    }
  });

  $('btn-play').addEventListener('click', async () => {
    const btn = $('btn-play');
    btn.disabled = true;
    showToast('Starte FrostholdRP…', 2000);
    try {
      const r = await fh.play();
      if (r && r.ok) {
        showToast('Skyrim wird mit SKSE gestartet. Du kannst den Launcher schließen.', 6000);
      } else {
        const msg = (r && r.message) || (r && r.error) || JSON.stringify(r);
        showToast(`Fehler: ${msg}`, 12000);
        await refreshLauncherState();
      }
    } catch (e) {
      showToast(`Fehler: ${e}`, 12000);
    } finally {
      btn.disabled = false;
    }
  });
});
