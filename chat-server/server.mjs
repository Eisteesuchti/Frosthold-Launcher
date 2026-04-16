import { WebSocketServer } from 'ws';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));

const PORT = cfg.port || 3210;
const LOCAL_RADIUS = cfg.localRadius || 3000;
const MAX_MSG_LEN = cfg.maxMessageLength || 120;

const userMap = new Map();
for (const u of cfg.users || []) {
  userMap.set(u.userId, u);
}

const wss = new WebSocketServer({ port: PORT });

/** @type {Map<import('ws').WebSocket, { userId: string, displayName: string, tag: string, x: number, y: number, z: number }>} */
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
      const entry = userMap.get(msg.userId);
      if (!entry || entry.secret !== msg.secret) {
        ws.send(JSON.stringify({ type: 'error', message: 'Authentifizierung fehlgeschlagen.' }));
        ws.close();
        return;
      }
      authed = true;
      clients.set(ws, {
        userId: entry.userId,
        displayName: entry.displayName || entry.userId,
        tag: entry.tag || '',
        x: 0, y: 0, z: 0,
      });
      ws.send(JSON.stringify({ type: 'auth_ok', displayName: entry.displayName || entry.userId }));
      console.log(`[chat] ${entry.displayName || entry.userId} verbunden`);
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

console.log(`[chat-server] Läuft auf Port ${PORT} (localRadius=${LOCAL_RADIUS})`);
