import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));

const WS_PORT = cfg.port || 3211;
const HTTP_PORT = cfg.httpPort || 3212;
const LOCAL_RADIUS = cfg.localRadius || 3000;
const MAX_MSG_LEN = cfg.maxMessageLength || 120;

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

  res.writeHead(404);
  res.end('Not found');
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`[chat-server] HTTP-Auth auf Port ${HTTP_PORT}`);
});

// --- WebSocket chat server ---
const wss = new WebSocketServer({ port: WS_PORT });

/** @type {Map<import('ws').WebSocket, { discordId: string, displayName: string, tag: string, x: number, y: number, z: number }>} */
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
      const tag = cfg.tags?.[session.discordId] || '';
      clients.set(ws, {
        discordId: session.discordId,
        displayName: session.displayName,
        tag,
        x: 0, y: 0, z: 0,
      });
      ws.send(JSON.stringify({ type: 'auth_ok', displayName: session.displayName }));
      console.log(`[chat] ${session.displayName} verbunden`);
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
      const channel = msg.channel === 'global' ? 'global' : 'local';

      const outgoing = {
        type: 'chat',
        channel,
        displayName: info.displayName,
        tag: info.tag,
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
