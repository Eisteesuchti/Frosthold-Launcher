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
    lab.textContent = 'Installiere…';
    btn.disabled = true;
    showToast('Lade fehlende Dateien — das kann einige Minuten dauern…', 12000);
    try {
      const r = await fh.setup();
      if (r && r.ok) {
        showToast(r.message || 'Installation abgeschlossen.', 6000);
      } else {
        const msg = (r && r.message) || (r && r.error) || JSON.stringify(r);
        showToast(`Fehler: ${msg}`, 8000);
      }
    } catch (e) {
      showToast(`Fehler: ${e}`, 8000);
    } finally {
      lab.textContent = 'Aktualisieren';
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
      } else {
        showToast(`Anmeldung fehlgeschlagen: ${r.error || 'Unbekannt'}`, 8000);
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
    try {
      const r = await fh.play();
      if (r && r.ok) {
        showToast('Skyrim wird mit SKSE gestartet. Du kannst den Launcher schließen.', 6000);
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
