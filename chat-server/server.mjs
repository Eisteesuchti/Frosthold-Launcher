/**
 * Frosthold Chat-Server (WebSocket)
 * - Kanäle: local (Radius), global
 * - Max. 120 Zeichen pro Nachricht (serverseitig erzwungen)
 * - Ränge nur serverseitig → Prefix: <TGM> <GM> <DEV> <ADM>
 *
 * Client-Protokoll (JSON):
 *   { "type": "auth", "userId": "...", "secret": "..." }
 *   { "type": "pos", "x": number, "y": number, "z": number }
 *   { "type": "chat", "channel": "local"|"global", "text": "..." }
 *
 * Server → Client:
 *   { "type": "auth_ok", "displayName", "role", "tag" }
 *   { "type": "chat", "channel", "tag", "displayName", "text", "ts" }
 *   { "type": "error", "message" }
 */

import { readFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_CHARS = 120;
const ROLE_TAGS = {
  player: '',
  trial_gamemaster: '<TGM>',
  gamemaster: '<GM>',
  developer: '<DEV>',
  administrator: '<ADM>',
};

function loadConfig() {
  const pathUser = join(__dirname, 'config.json');
  const pathExample = join(__dirname, 'config.example.json');
  const raw = existsSync(pathUser)
    ? readFileSync(pathUser, 'utf8')
    : existsSync(pathExample)
      ? readFileSync(pathExample, 'utf8')
      : '{}';
  const j = JSON.parse(raw);
  return {
    port: Number(j.port) || 3210,
    localRadius: Number(j.localRadius) || 100,
    users: j.users && typeof j.users === 'object' ? j.users : {},
  };
}

function dist3(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function tagForRole(role) {
  const r = String(role || 'player');
  return ROLE_TAGS[r] !== undefined ? ROLE_TAGS[r] : '';
}

const config = loadConfig();

/** @type {Map<import('ws').WebSocket, { userId: string, displayName: string, role: string, pos: { x: number, y: number, z: number } }>} */
const clients = new Map();

function broadcast(ws, payload, predicate) {
  const data = JSON.stringify(payload);
  for (const [other, meta] of clients) {
    if (other === ws) continue;
    if (other.readyState !== 1) continue;
    if (predicate && !predicate(meta, other)) continue;
    other.send(data);
  }
}

function sendError(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'error', message: String(message) }));
  }
}

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Frosthold Chat-Server (WebSocket). Verbinde per WS auf diesen Port.\n');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  let authed = false;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      sendError(ws, 'Ungültiges JSON');
      return;
    }

    const type = msg && msg.type;

    if (!authed) {
      if (type !== 'auth') {
        sendError(ws, 'Zuerst auth senden: { type, userId, secret }');
        ws.close();
        return;
      }
      const userId = String(msg.userId || '').trim();
      const secret = String(msg.secret || '');
      const u = config.users[userId];
      if (!u || String(u.secret) !== secret) {
        sendError(ws, 'Auth fehlgeschlagen');
        ws.close();
        return;
      }
      const role = String(u.role || 'player');
      const displayName = String(u.displayName || userId).slice(0, 64);
      const tag = tagForRole(role);
      clients.set(ws, {
        userId,
        displayName,
        role,
        pos: { x: 0, y: 0, z: 0 },
      });
      authed = true;
      ws.send(
        JSON.stringify({
          type: 'auth_ok',
          displayName,
          role,
          tag,
        }),
      );
      return;
    }

    const meta = clients.get(ws);
    if (!meta) {
      ws.close();
      return;
    }

    if (type === 'pos') {
      meta.pos = {
        x: Number(msg.x) || 0,
        y: Number(msg.y) || 0,
        z: Number(msg.z) || 0,
      };
      return;
    }

    if (type === 'chat') {
      const channel = msg.channel === 'global' ? 'global' : 'local';
      let text = String(msg.text ?? '').replace(/\r\n/g, '\n').trim();
      if (text.length > MAX_CHARS) {
        text = text.slice(0, MAX_CHARS);
      }
      if (!text) {
        sendError(ws, 'Leerer Text');
        return;
      }

      const tag = tagForRole(meta.role);
      const ts = Date.now();
      const out = {
        type: 'chat',
        channel,
        tag,
        displayName: meta.displayName,
        text,
        ts,
      };

      const selfPayload = JSON.stringify({ ...out, self: true });
      ws.send(selfPayload);

      if (channel === 'global') {
        broadcast(ws, out, null);
      } else {
        const r = config.localRadius;
        broadcast(
          ws,
          out,
          (otherMeta) => dist3(meta.pos, otherMeta.pos) <= r,
        );
      }
      return;
    }

    sendError(ws, 'Unbekannter type: ' + type);
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

httpServer.listen(config.port, () => {
  console.log(
    `Frosthold Chat-Server: http + WebSocket auf Port ${config.port} (Local-Radius ${config.localRadius})`,
  );
});
