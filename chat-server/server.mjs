import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { Socket } from 'net';
import {
  mergeRoleDefinitions,
  roleHasPermission,
  getRoleOrDefault,
  canStaffActOnTarget,
} from './roles.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));

const WS_PORT = cfg.port || 3211;
const HTTP_PORT = cfg.httpPort || 3212;
const LOCAL_RADIUS = cfg.localRadius || 3000;
const MAX_MSG_LEN = cfg.maxMessageLength || 120;

const ROLE_DEFINITIONS = mergeRoleDefinitions(cfg);
const DEFAULT_ROLE_ID = String(cfg.defaultRoleId || 'player').trim() || 'player';

/** Discord-Snowflake → roleId (z. B. "game_admin"). */
function buildDiscordMemberMap() {
  const m = {};
  const raw = cfg.discordMembers && typeof cfg.discordMembers === 'object' ? cfg.discordMembers : {};
  for (const [id, roleId] of Object.entries(raw)) {
    m[String(id)] = String(roleId).trim();
  }
  const legacy = cfg.userRoles && typeof cfg.userRoles === 'object' ? cfg.userRoles : {};
  const labelToRoleId = {
    Spieler: 'player',
    spieler: 'player',
    VIP: 'vip',
    vip: 'vip',
    TestGamemaster: 'trial_gamemaster',
    testgamemaster: 'trial_gamemaster',
    TrialGamemaster: 'trial_gamemaster',
    trialgamemaster: 'trial_gamemaster',
    'Test-Gamemaster': 'trial_gamemaster',
    'Trial-Gamemaster': 'trial_gamemaster',
    TGM: 'trial_gamemaster',
    tgm: 'trial_gamemaster',
    Gamemaster: 'gamemaster',
    gamemaster: 'gamemaster',
    GM: 'gamemaster',
    gm: 'gamemaster',
    GameAdmin: 'game_admin',
    gameadmin: 'game_admin',
    'Game Admin': 'game_admin',
    GA: 'game_admin',
    ga: 'game_admin',
    Developer: 'developer',
    developer: 'developer',
    Dev: 'developer',
    dev: 'developer',
    DEV: 'developer',
    Administrator: 'game_admin',
    administrator: 'game_admin',
  };
  for (const [discordId, label] of Object.entries(legacy)) {
    if (m[discordId]) continue;
    const key = String(label).trim();
    const mapped = labelToRoleId[key];
    if (mapped) m[discordId] = mapped;
  }
  return m;
}

const DISCORD_MEMBER_ROLES = buildDiscordMemberMap();

/** Persistente Ingame-Account-Stufe 0–4 (Discord-Snowflake → Stufe). GameAdmin (nur Discord) bleibt immer GA. */
const ACCOUNT_LEVEL_OVERRIDES_PATH = join(__dirname, 'account-level-overrides.json');
const ACCLEVEL_TO_ROLEID = ['player', 'vip', 'trial_gamemaster', 'gamemaster', 'developer'];
const ACCLEVEL_LABELS = ['Player (0)', 'VIP (1)', 'TGM (2)', 'GM (3)', 'Developer (4)'];

/** @type {Record<string, number>} */
let accountLevelOverrides = {};

function loadAccountLevelOverridesFromDisk() {
  if (!existsSync(ACCOUNT_LEVEL_OVERRIDES_PATH)) {
    accountLevelOverrides = {};
    return;
  }
  try {
    const raw = readFileSync(ACCOUNT_LEVEL_OVERRIDES_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') {
      accountLevelOverrides = {};
      return;
    }
    const next = {};
    for (const [k, v] of Object.entries(data)) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 4) continue;
      next[String(k)] = n;
    }
    accountLevelOverrides = next;
  } catch (e) {
    console.warn('[chat] account-level-overrides laden fehlgeschlagen:', e.message);
    accountLevelOverrides = {};
  }
}

function persistAccountLevelOverrides() {
  try {
    writeFileSync(
      ACCOUNT_LEVEL_OVERRIDES_PATH,
      `${JSON.stringify(accountLevelOverrides, null, 2)}\n`,
      'utf8',
    );
  } catch (e) {
    console.error('[chat] account-level-overrides speichern fehlgeschlagen:', e.message);
  }
}

loadAccountLevelOverridesFromDisk();

/** Rolle **nur** aus Discord-Zuordnung (ohne account-level-Override). */
function discordRoleIdOnly(discordId) {
  const id = String(discordId);
  return DISCORD_MEMBER_ROLES[id] || DEFAULT_ROLE_ID;
}

/**
 * Effektive Rolle: Discord-Zuordnung, ggf. überschrieben durch Ingame-Account-Stufe (0–4).
 * `game_admin` aus Discord kann nicht durch Stufen herabgestuft werden.
 */
function resolveEffectiveRole(discordId) {
  const id = String(discordId);
  const discordRoleId = discordRoleIdOnly(id);
  if (discordRoleId === 'game_admin') {
    return getRoleOrDefault(ROLE_DEFINITIONS, 'game_admin');
  }
  const ov = accountLevelOverrides[id];
  if (ov === undefined || ov === null) {
    return getRoleOrDefault(ROLE_DEFINITIONS, discordRoleId);
  }
  const clamped = Math.max(0, Math.min(4, Number(ov)));
  const rid = ACCLEVEL_TO_ROLEID[clamped];
  return getRoleOrDefault(ROLE_DEFINITIONS, rid);
}

/** Ab diesem rank (Standard: Trial-/Test-GM) darf /gmbadge on|off das GM-Präfix steuern. VIP darunter: Präfix immer an. */
const BADGE_TOGGLE_MIN_RANK = ROLE_DEFINITIONS.trial_gamemaster?.rank ?? 35;

/** Implementierte Chat-Befehle (führendes /wort). Alles andere → „Es gibt keinen solchen Befehl.“ */
const KNOWN_CHAT_COMMANDS = new Set(['kick', 'ban', 'gmbadge', 'badge', 'commands', 'account']);

/** Einträge für /commands: permission null = immer listen (außer lines gibt null); sonst nur mit Recht. */
const COMMANDS_HELP_ENTRIES = [
  {
    id: 'commands',
    permission: null,
    lines: () => ['/commands — Listet alle Befehle auf, die dein Rang ausführen darf.'],
  },
  {
    id: 'gmbadge',
    permission: null,
    lines: (a) => {
      if (!a.chatBadge || a.rank < BADGE_TOGGLE_MIN_RANK) return null;
      return ['/gmbadge on | off — GM-Rollen-Präfix im Chat ein- oder ausblenden. (/badge = Alias)'];
    },
  },
  {
    id: 'kick',
    permission: 'chat.kick',
    lines: () => ['/kick <Anzeigename oder Discord-ID> — Spieler vom Chat trennen.'],
  },
  {
    id: 'ban',
    permission: 'chat.ban',
    lines: () => ['/ban <Anzeigename oder Discord-ID> — Spieler vom Chat verbannen (Verbindung trennen).'],
  },
  {
    id: 'account',
    permission: null,
    lines: (a) => {
      if (discordRoleIdOnly(a.discordId) !== 'game_admin') return null;
      return [
        '/account set acclevel (Anzeigename oder Discord-ID) 0|1|2|3|4 - Ingame-Stufe: Player, VIP, TGM, GM, DEV (nur GameAdmin).',
      ];
    },
  },
];

const MSG_NO_SUCH_COMMAND = 'Es gibt keinen solchen Befehl.';

function leadingChatCommandName(text) {
  const m = String(text).trim().match(/^\/(\w+)/);
  return m ? m[1].toLowerCase() : null;
}

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || cfg.discordClientId || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || cfg.discordClientSecret || '';
const DISCORD_REDIRECT_URI = cfg.discordRedirectUri || 'http://localhost:39015/callback';

// --- Session store: sessionToken -> { discordId, username, displayName, avatar, createdAt } ---
const sessions = new Map();
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(token);
  }
}
setInterval(pruneExpiredSessions, 60 * 60 * 1000);

// --- HTTP server for Discord OAuth2 code exchange ---
const httpServer = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/auth/discord') {
    let body = '';
    for await (const chunk of req) body += chunk;

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }

    const { code } = parsed;
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing_code' }));
      return;
    }

    try {
      // Exchange auth code for access token
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: DISCORD_REDIRECT_URI,
        }),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        console.error('[auth] Discord token exchange failed:', tokenRes.status, err);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'discord_token_exchange_failed' }));
        return;
      }

      const tokenData = await tokenRes.json();
      const accessToken = tokenData.access_token;

      // Fetch Discord user profile
      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!userRes.ok) {
        console.error('[auth] Discord user fetch failed:', userRes.status);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'discord_user_fetch_failed' }));
        return;
      }

      const user = await userRes.json();
      const discordId = user.id;
      const username = user.username;
      const displayName = user.global_name || user.username;
      const avatar = user.avatar || '';

      // Create session
      const sessionToken = randomBytes(32).toString('hex');
      sessions.set(sessionToken, {
        discordId,
        username,
        displayName,
        avatar,
        createdAt: Date.now(),
      });

      console.log(`[auth] Session erstellt fuer ${displayName} (${username}, ${discordId})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        sessionToken,
        discordId,
        username,
        displayName,
        avatar,
      }));
    } catch (err) {
      console.error('[auth] Error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    const gameserverOk = await new Promise((resolve) => {
      const sock = new Socket();
      sock.setTimeout(2000);
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
      sock.once('error', () => { sock.destroy(); resolve(false); });
      sock.connect(7777, '127.0.0.1');
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: gameserverOk, chatOnline: true, players: wss.clients.size }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`[chat-server] HTTP-Auth auf Port ${HTTP_PORT}`);
});

// --- WebSocket chat server ---
const wss = new WebSocketServer({ port: WS_PORT });

/**
 * @typedef {object} ClientInfo
 * @property {string} discordId
 * @property {string} displayName
 * @property {string} manualTag
 * @property {boolean} showBadge
 * @property {string} chatBadge
 * @property {string} roleId
 * @property {string} roleLabel
 * @property {number} rank
 * @property {string[]} permissions
 * @property {boolean} canUseAdminCommands
 * @property {number} x
 * @property {number} y
 * @property {number} z
 */

/** @type {Map<import('ws').WebSocket, ClientInfo>} */
const clients = new Map();

function broadcast(data, filter) {
  const raw = JSON.stringify(data);
  for (const [ws, info] of clients) {
    if (ws.readyState !== 1) continue;
    if (filter && !filter(info)) continue;
    ws.send(raw);
  }
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Feedback nur an diese WebSocket-Verbindung (kein Broadcast).
 * Als normale Chat-Zeile (`type: 'chat'`), weil viele Ingame-Clients `type: 'system'` nicht anzeigen.
 * @param {Record<string, unknown>} [meta] z. B. kind: 'success'|'info'|'error', command, targetDisplayName — für zukünftige UI
 */
function sendSystem(ws, message, meta = {}) {
  try {
    ws.send(JSON.stringify({
      type: 'chat',
      channel: 'local',
      displayName: 'System',
      tag: '',
      chatBadge: '',
      text: String(message),
      onlyExecutor: true,
      ...meta,
    }));
  } catch (_) {}
}

/** Rollen-Präfix (<TGM>, <GM>, …): unter TGM-Rang immer an (VIP), ab TGM von showBadge abhängig. */
function outgoingRolePrefix(info) {
  const b = info.chatBadge || '';
  if (!b) return '';
  if (info.rank < BADGE_TOGGLE_MIN_RANK) return b;
  return info.showBadge ? b : '';
}

/** Anzeige vor dem Namen: Rollen-Präfix oder manuelles tags{}-Suffix. */
function outgoingDisplayTag(info) {
  return outgoingRolePrefix(info) || info.manualTag || '';
}

/** @returns {[import('ws').WebSocket, ClientInfo] | null} */
function findTargetClient(query) {
  const q = String(query).trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  for (const [tws, c] of clients) {
    if (c.displayName.toLowerCase() === lower) return [tws, c];
  }
  if (/^\d{17,20}$/.test(q)) {
    for (const [tws, c] of clients) {
      if (c.discordId === q) return [tws, c];
    }
  }
  if (lower.length >= 2) {
    for (const [tws, c] of clients) {
      if (c.displayName.toLowerCase().includes(lower)) return [tws, c];
    }
  }
  return null;
}

/**
 * Ziel-Discord-ID für Admin-Befehle: online (Chat), numerische ID, oder kürzliche OAuth-Session (Launcher).
 * @param {string} query
 * @returns {string | null}
 */
function findTargetDiscordId(query) {
  const q = String(query).trim();
  if (!q) return null;
  if (/^\d{17,20}$/.test(q)) return q;
  const found = findTargetClient(q);
  if (found) return found[1].discordId;
  const lower = q.toLowerCase();
  for (const s of sessions.values()) {
    if (String(s.displayName).toLowerCase() === lower) return s.discordId;
  }
  if (lower.length >= 2) {
    for (const s of sessions.values()) {
      if (String(s.displayName).toLowerCase().includes(lower)) return s.discordId;
    }
  }
  return null;
}

/** @param {ClientInfo} info */
function recomputeClientRole(info) {
  const role = resolveEffectiveRole(info.discordId);
  const chatBadge = typeof role.chatBadge === 'string' ? role.chatBadge : '';
  const showBadge = !!chatBadge && role.roleId !== 'player';
  Object.assign(info, {
    chatBadge,
    showBadge,
    roleId: role.roleId,
    roleLabel: role.label,
    rank: role.rank,
    permissions: [...role.permissions],
    canUseAdminCommands: roleHasPermission(role, '*'),
  });
}

function buildCommandsListForActor(actor) {
  const permissions = Array.isArray(actor.permissions) ? actor.permissions : [];
  const actorForPerms = { ...actor, permissions };
  const lines = [];
  for (const e of COMMANDS_HELP_ENTRIES) {
    if (e.permission != null && !roleHasPermission({ permissions }, e.permission)) {
      continue;
    }
    const block = e.lines(actorForPerms);
    if (!block || !block.length) continue;
    lines.push(...block);
  }
  return lines;
}

/**
 * /kick und /ban (gleiche Ziel-Logik, unterschiedliches Recht).
 * @param {string} closeReason Kurzgrund für WebSocket-Close
 */
function tryModerationDisconnect(ws, actor, text, cmdName, permission, closeReason) {
  if (!roleHasPermission({ permissions: actor.permissions }, permission)) {
    sendSystem(ws, MSG_NO_SUCH_COMMAND, { kind: 'error' });
    return true;
  }
  const targetQuery = text.replace(new RegExp(`^\\/${cmdName}\\s*`, 'i'), '').trim();
  if (!targetQuery) {
    sendSystem(ws, `Nutze: /${cmdName} <Anzeigename oder Discord-ID>`, { kind: 'info', command: cmdName });
    return true;
  }
  const found = findTargetClient(targetQuery);
  if (!found) {
    sendSystem(ws, 'Spieler nicht gefunden oder nicht online.', { kind: 'error', command: cmdName });
    return true;
  }
  const [tws, target] = found;
  if (target.discordId === actor.discordId) {
    sendSystem(ws, cmdName === 'ban' ? 'Du kannst dich selbst nicht verbannen.' : 'Du kannst dich selbst nicht kicken.', { kind: 'error', command: cmdName });
    return true;
  }
  if (!canStaffActOnTarget(actor.rank, target.rank)) {
    sendSystem(ws, 'Ziel hat gleiche oder höhere Rolle — Aktion nicht erlaubt (z. B. GameAdmin ist geschützt).', { kind: 'error', command: cmdName });
    return true;
  }
  try {
    tws.close(4000, closeReason);
  } catch (_) {}
  const okMsg = cmdName === 'ban'
    ? `${target.displayName} wurde vom Server gebannt.`
    : `${target.displayName} wurde vom Server gekickt.`;
  sendSystem(ws, okMsg, {
    kind: 'success',
    command: cmdName,
    targetDisplayName: target.displayName,
  });
  console.log(`[chat] /${cmdName} von ${actor.displayName} → ${target.displayName} (${target.roleId}, rank ${target.rank})`);
  return true;
}

/**
 * Zeilen mit /… — kein Broadcast als normaler Chat.
 * @returns {boolean} true wenn verarbeitet
 */
function tryHandleStaffChatLine(ws, actor, text) {
  const t = String(text).trim();
  if (!t.startsWith('/')) return false;

  const cmd = leadingChatCommandName(t);
  if (!cmd || !KNOWN_CHAT_COMMANDS.has(cmd)) {
    sendSystem(ws, MSG_NO_SUCH_COMMAND, { kind: 'error' });
    return true;
  }

  if (cmd === 'commands') {
    const lines = buildCommandsListForActor(actor);
    if (!lines.length) {
      sendSystem(ws, 'Dir stehen keine Chat-Befehle zur Verfügung.', { kind: 'info', command: 'commands' });
      return true;
    }
    // Eine Zeile: viele Ingame-Chat-UIs zeigen nur die erste Zeile (Zeilenumbruch = Rest unsichtbar).
    sendSystem(ws, `Befehle für deinen Rang: ${lines.join(' | ')}`, { kind: 'info', command: 'commands' });
    return true;
  }

  if (cmd === 'gmbadge' || cmd === 'badge') {
    const arg = t.replace(/^\/(?:gmbadge|badge)\s*/i, '').trim().toLowerCase();
    if (arg !== 'on' && arg !== 'off') {
      sendSystem(ws, 'Nutze: /gmbadge on | /gmbadge off', { kind: 'info', command: 'gmbadge' });
      return true;
    }
    if (!actor.chatBadge || actor.rank < BADGE_TOGGLE_MIN_RANK) {
      sendSystem(ws, MSG_NO_SUCH_COMMAND, { kind: 'error', command: 'gmbadge' });
      return true;
    }
    actor.showBadge = arg === 'on';
    sendSystem(ws, actor.showBadge
      ? 'GM-Badge wird im Chat angezeigt.'
      : 'GM-Badge wird im Chat ausgeblendet.', { kind: 'success', command: 'gmbadge' });
    return true;
  }

  if (cmd === 'account') {
    if (discordRoleIdOnly(actor.discordId) !== 'game_admin') {
      sendSystem(ws, MSG_NO_SUCH_COMMAND, { kind: 'error', command: 'account' });
      return true;
    }
    const rest = t.replace(/^\/account\s*/i, '').trim();
    const sub = /^set\s+acclevel\s+(.+)\s+([0-4])$/i.exec(rest);
    if (!sub) {
      sendSystem(ws, 'Nutze: /account set acclevel (Anzeigename oder Discord-ID) 0|1|2|3|4 (Player, VIP, TGM, GM, DEV)', {
        kind: 'info',
        command: 'account',
      });
      return true;
    }
    const targetQuery = sub[1].trim();
    const level = Number(sub[2]);
    const targetDiscordId = findTargetDiscordId(targetQuery);
    if (!targetDiscordId) {
      sendSystem(ws, 'Ziel nicht gefunden (Name: verbunden oder kürzlich im Launcher angemeldet; oder Discord-ID).', {
        kind: 'error',
        command: 'account',
      });
      return true;
    }
    if (targetDiscordId === actor.discordId) {
      sendSystem(ws, 'Eigene Account-Stufe so nicht setzen.', { kind: 'error', command: 'account' });
      return true;
    }
    if (discordRoleIdOnly(targetDiscordId) === 'game_admin') {
      sendSystem(ws, 'GameAdmin-Konten (Discord) können per Account-Stufe nicht geändert werden.', {
        kind: 'error',
        command: 'account',
      });
      return true;
    }
    accountLevelOverrides[targetDiscordId] = level;
    persistAccountLevelOverrides();
    let targetLabel = targetQuery;
    for (const [cws, c] of clients) {
      if (c.discordId !== targetDiscordId) continue;
      targetLabel = c.displayName;
      recomputeClientRole(c);
      const tmpInfo = {
        manualTag: c.manualTag,
        chatBadge: c.chatBadge,
        showBadge: c.showBadge,
        rank: c.rank,
      };
      try {
        cws.send(JSON.stringify({
          type: 'role_updated',
          displayName: c.displayName,
          roleId: c.roleId,
          roleLabel: c.roleLabel,
          rank: c.rank,
          chatBadge: c.chatBadge,
          showBadge: c.showBadge,
          canToggleBadge: !!c.chatBadge && c.rank >= BADGE_TOGGLE_MIN_RANK,
          badgeToggleMinRank: BADGE_TOGGLE_MIN_RANK,
          permissions: c.permissions,
          canUseAdminCommands: c.canUseAdminCommands,
          tag: outgoingDisplayTag(tmpInfo),
        }));
      } catch (_) {}
    }
    sendSystem(
      ws,
      `Account-Stufe für ${targetLabel} auf ${ACCLEVEL_LABELS[level]} gesetzt (${ACCLEVEL_TO_ROLEID[level]}).`,
      { kind: 'success', command: 'account', targetDisplayName: targetLabel },
    );
    console.log(
      `[chat] /account set acclevel von ${actor.displayName} → Discord ${targetDiscordId} = ${level} (${ACCLEVEL_TO_ROLEID[level]})`,
    );
    return true;
  }

  if (cmd === 'kick') {
    return tryModerationDisconnect(ws, actor, t, 'kick', 'chat.kick', 'kick');
  }

  if (cmd === 'ban') {
    return tryModerationDisconnect(ws, actor, t, 'ban', 'chat.ban', 'ban');
  }

  sendSystem(ws, MSG_NO_SUCH_COMMAND, { kind: 'error' });
  return true;
}

wss.on('connection', (ws) => {
  let authed = false;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === 'auth') {
      const session = sessions.get(msg.sessionToken);
      if (!session) {
        ws.send(JSON.stringify({ type: 'error', message: 'Ungueltige oder abgelaufene Session. Bitte im Launcher neu anmelden.' }));
        ws.close();
        return;
      }

      authed = true;
      const manualTag = cfg.tags?.[session.discordId] || '';
      const role = resolveEffectiveRole(session.discordId);
      const adminCmd = roleHasPermission(role, '*');
      const chatBadge = typeof role.chatBadge === 'string' ? role.chatBadge : '';
      const showBadge = !!chatBadge && role.roleId !== 'player';
      const canToggleBadge = !!chatBadge && role.rank >= BADGE_TOGGLE_MIN_RANK;
      const tmpInfo = {
        manualTag,
        chatBadge,
        showBadge,
        rank: role.rank,
      };
      clients.set(ws, {
        discordId: session.discordId,
        displayName: session.displayName,
        manualTag,
        showBadge,
        chatBadge,
        roleId: role.roleId,
        roleLabel: role.label,
        rank: role.rank,
        permissions: [...role.permissions],
        canUseAdminCommands: adminCmd,
        x: 0, y: 0, z: 0,
      });
      ws.send(JSON.stringify({
        type: 'auth_ok',
        displayName: session.displayName,
        roleId: role.roleId,
        roleLabel: role.label,
        rank: role.rank,
        chatBadge,
        showBadge,
        canToggleBadge,
        badgeToggleMinRank: BADGE_TOGGLE_MIN_RANK,
        permissions: role.permissions,
        canUseAdminCommands: adminCmd,
        tag: outgoingDisplayTag(tmpInfo),
      }));
      const badgeLog = chatBadge ? ` Badge ${chatBadge}` : '';
      console.log(
        `[chat] ${session.displayName} eingeloggt | Discord ${session.discordId} | ${role.label} (${role.roleId}, rank ${role.rank})${badgeLog} | Vollzugriff-Commands: ${adminCmd ? 'ja' : 'nein'}`,
      );
      return;
    }

    if (!authed) return;
    const info = clients.get(ws);
    if (!info) return;

    if (msg.type === 'pos') {
      info.x = Number(msg.x) || 0;
      info.y = Number(msg.y) || 0;
      info.z = Number(msg.z) || 0;
      return;
    }

    if (msg.type === 'chat') {
      const text = String(msg.text || '').trim().slice(0, MAX_MSG_LEN);
      if (!text) return;
      if (tryHandleStaffChatLine(ws, info, text)) return;

      const channel = msg.channel === 'global' ? 'global' : 'local';

      const rolePrefix = outgoingRolePrefix(info);
      const outgoing = {
        type: 'chat',
        channel,
        displayName: info.displayName,
        tag: outgoingDisplayTag(info),
        chatBadge: rolePrefix,
        text,
      };

      if (channel === 'global') {
        broadcast(outgoing);
      } else {
        broadcast(outgoing, (other) => distance(info, other) <= LOCAL_RADIUS);
      }
      console.log(`[chat] [${channel}] ${info.displayName}: ${text}`);
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info) {
      console.log(`[chat] ${info.displayName} getrennt`);
    }
    clients.delete(ws);
  });
});

console.log(`[chat-server] WebSocket-Chat auf Port ${WS_PORT} (localRadius=${LOCAL_RADIUS})`);
