export const NET_VERSION = 1;
export const BUILD_ID = 'pc-coop-2026-10-05.2';
export function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export const MAX_PLAYERS = 4;
export const TICK_RATE = 30;
export const SNAPSHOT_RATE = 10;
export const RECONNECT_MS = 60_000;
export const MAX_MESSAGE_BYTES = 24_576;
export const INPUT_ACTIONS = [
  'forward', 'back', 'left', 'right', 'sprint', 'slow', 'crouchHold',
  'crouchToggle', 'jump', 'roll', 'leanLeft', 'leanRight', 'aim', 'fire',
  'reload', 'interact', 'flashlight', 'weaponSlot0', 'weaponSlot1', 'weaponSlot2',
];
export const encode = (value) => JSON.stringify(value, (_, v) => v === Infinity ? '__pc_infinity__' : v);
export const decode = (value) => JSON.parse(value, (_, v) => v === '__pc_infinity__' ? Infinity : v);
export const finite = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
export const cleanName = (name) => String(name ?? '').replace(/[\p{C}<>]/gu, '').trim().slice(0, 16) || '行动员';
export const validCode = (code) => /^[A-HJ-NP-Z2-9]{6}$/.test(code);
export function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...crypto.getRandomValues(new Uint8Array(6))].map((n) => alphabet[n & 31]).join('');
}
export function parseInput(raw) {
  if (!raw || !Number.isSafeInteger(raw.seq) || raw.seq < 0
      || !finite(raw.yaw, -1e5, 1e5) || !finite(raw.pitch, -1.31, 1.23)) return null;
  const filter = (list) => Array.isArray(list) ? [...new Set(list.filter((a) => INPUT_ACTIONS.includes(a)))].slice(0, 24) : [];
  return { seq: raw.seq, yaw: raw.yaw, pitch: raw.pitch, down: filter(raw.down), pressed: filter(raw.pressed),
    firstPerson: !!raw.firstPerson, shoulder: raw.shoulder === -1 ? -1 : 1, panel: !!raw.panel };
}
