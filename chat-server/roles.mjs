/**
 * Rollen-Hierarchie Frosthold-Chat (fest definiert, per config nur überschreib-/ergänzbar).
 *
 * - roleId: Eintrag in discordMembers
 * - rank: höher = höher in der Hierarchie
 * - chatBadge: leer = normaler Spieler ohne Präfix; sonst z. B. "<VIP>" vor dem Namen
 * - permissions: spätere Commands; "*" = alle Rechte
 */

/** @typedef {{ label: string, rank: number, chatBadge: string, permissions: string[] }} RoleDef */

/**
 * Hierarchie (unten → oben steigender rank):
 * Spieler → VIP → Trial/Test-GM → Gamemaster → Developer → GameAdmin (höchste Instanz, unantastbar für niedrigere Ränge)
 */
export const DEFAULT_ROLE_DEFINITIONS = {
  player: {
    label: 'Spieler',
    rank: 10,
    chatBadge: '',
    permissions: ['chat.send.local', 'chat.send.global'],
  },
  vip: {
    label: 'VIP',
    rank: 20,
    chatBadge: '<VIP>',
    permissions: ['chat.send.local', 'chat.send.global'],
  },
  /** TestGamemaster und TrialGamemaster — gleiches Präfix <TGM> */
  trial_gamemaster: {
    label: 'Trial-/Test-Gamemaster',
    rank: 35,
    chatBadge: '<TGM>',
    permissions: [
      'chat.send.local',
      'chat.send.global',
      'chat.announce',
    ],
  },
  /** Optional zweites roleId mit gleichem Badge (nur Zuordnung in discordMembers) */
  test_gamemaster: {
    label: 'Test-Gamemaster',
    rank: 35,
    chatBadge: '<TGM>',
    permissions: [
      'chat.send.local',
      'chat.send.global',
      'chat.announce',
    ],
  },
  gamemaster: {
    label: 'Gamemaster',
    rank: 50,
    chatBadge: '<GM>',
    permissions: [
      'chat.send.local',
      'chat.send.global',
      'chat.announce',
      'chat.mute',
      'chat.kick',
      'chat.ban',
      'chat.broadcast',
    ],
  },
  game_admin: {
    label: 'GameAdmin',
    rank: 200,
    chatBadge: '<GA>',
    permissions: ['*'],
  },
  /** Technisch: fast alle Rechte, aber rank unter GameAdmin — kann GA nicht moderieren. */
  developer: {
    label: 'Developer',
    rank: 100,
    chatBadge: '<DEV>',
    permissions: ['*'],
  },
};

/**
 * @param {Record<string, unknown>} cfg
 * @returns {Record<string, RoleDef>}
 */
export function mergeRoleDefinitions(cfg) {
  const fromFile = cfg.roleDefinitions && typeof cfg.roleDefinitions === 'object'
    ? cfg.roleDefinitions
    : {};
  /** @type {Record<string, RoleDef>} */
  const out = {};

  function pickChatBadge(o, def) {
    if (o && typeof o === 'object' && typeof o.chatBadge === 'string') return o.chatBadge;
    if (def && def.chatBadge != null) return def.chatBadge;
    return '';
  }

  for (const [id, def] of Object.entries(DEFAULT_ROLE_DEFINITIONS)) {
    const o = fromFile[id];
    if (o && typeof o === 'object') {
      const label = typeof o.label === 'string' ? o.label : def.label;
      const rank = Number.isFinite(Number(o.rank)) ? Number(o.rank) : def.rank;
      const permissions = Array.isArray(o.permissions) ? o.permissions.map(String) : def.permissions;
      const chatBadge = pickChatBadge(o, def);
      out[id] = { label, rank, chatBadge, permissions };
    } else {
      out[id] = { ...def };
    }
  }
  for (const [id, o] of Object.entries(fromFile)) {
    if (out[id]) continue;
    if (!o || typeof o !== 'object') continue;
    const label = typeof o.label === 'string' ? o.label : id;
    const rank = Number.isFinite(Number(o.rank)) ? Number(o.rank) : 0;
    const permissions = Array.isArray(o.permissions) ? o.permissions.map(String) : [];
    const chatBadge = pickChatBadge(o, null);
    out[id] = { label, rank, chatBadge, permissions };
  }
  return out;
}

/**
 * @param {string[]} permissions
 * @param {string} permission
 */
export function hasPermission(permissions, permission) {
  if (!permission) return false;
  if (permissions.includes('*')) return true;
  return permissions.includes(permission);
}

/**
 * @param {RoleDef & { roleId?: string }} role
 * @param {string} permission
 */
export function roleHasPermission(role, permission) {
  return hasPermission(role.permissions, permission);
}

export function rankAtLeast(memberRank, requiredRank) {
  return Number(memberRank) >= Number(requiredRank);
}

/**
 * Staff darf Ziel nur moderieren, wenn eigener Rang **strikt höher** ist.
 * Gleicher Rang = verweigert (z. B. GM kann anderen GM nicht kicken).
 * GameAdmin (200) kann von niemandem darunter betroffen werden.
 */
export function canStaffActOnTarget(actorRank, targetRank) {
  return Number(actorRank) > Number(targetRank);
}

/**
 * @param {Record<string, RoleDef>} definitions
 * @param {string} roleId
 */
export function getRoleOrDefault(definitions, roleId) {
  const id = String(roleId || '').trim() || 'player';
  const r = definitions[id];
  if (r) return { roleId: id, ...r };
  return { roleId: 'player', ...definitions.player };
}
