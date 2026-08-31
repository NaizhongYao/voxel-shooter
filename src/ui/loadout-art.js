const HEX = (color, fallback = '#9aa7b8') => {
  if (typeof color === 'string') return color;
  if (!Number.isFinite(color)) return fallback;
  return `#${color.toString(16).padStart(6, '0')}`;
};

const GUN_SHAPES = {
  pistol: (c) =>
    `<rect x="46" y="9" width="32" height="8" rx="1.5" fill="${c}"/>` +
    `<rect x="52" y="17" width="10" height="14" rx="1.5" fill="${c}"/>` +
    `<rect x="64" y="18" width="6" height="6" rx="1" fill="${c}"/>` +
    `<rect x="82" y="11" width="8" height="4" rx="1" fill="${c}"/>`,
  pistolFast: (c) =>
    `<rect x="52" y="9" width="28" height="8" rx="1.5" fill="${c}"/>` +
    `<rect x="58" y="17" width="9" height="13" rx="1.5" fill="${c}"/>` +
    `<rect x="36" y="11" width="12" height="4" rx="1" fill="${c}"/>` +
    `<rect x="84" y="11" width="6" height="4" rx="1" fill="${c}"/>`,
  smg: (c) =>
    `<rect x="6" y="6" width="10" height="7" rx="1" fill="${c}"/>` +
    `<rect x="14" y="8" width="48" height="10" rx="2" fill="${c}"/>` +
    `<rect x="60" y="10" width="24" height="6" rx="1.5" fill="${c}"/>` +
    `<rect x="20" y="18" width="9" height="14" rx="1.5" fill="${c}"/>` +
    `<rect x="34" y="18" width="14" height="8" rx="1" fill="${c}"/>`,
  ar: (c) =>
    `<rect x="2" y="6" width="10" height="14" rx="2" fill="${c}"/>` +
    `<rect x="10" y="9" width="50" height="9" rx="2" fill="${c}"/>` +
    `<rect x="60" y="11" width="26" height="6" rx="1.5" fill="${c}"/>` +
    `<rect x="18" y="18" width="9" height="16" rx="1.5" fill="${c}"/>` +
    `<rect x="32" y="18" width="12" height="9" rx="1" fill="${c}"/>` +
    `<rect x="72" y="9" width="6" height="6" rx="1" fill="${c}"/>`,
  shotgun: (c) =>
    `<rect x="2" y="8" width="8" height="12" rx="2" fill="${c}"/>` +
    `<rect x="8" y="10" width="66" height="8" rx="2" fill="${c}"/>` +
    `<rect x="74" y="12" width="26" height="5" rx="1.5" fill="${c}"/>` +
    `<rect x="28" y="18" width="10" height="12" rx="1.5" fill="${c}"/>` +
    `<rect x="52" y="18" width="8" height="8" rx="1" fill="${c}"/>`,
  dmr: (c) =>
    `<rect x="8" y="8" width="12" height="4" rx="1" fill="${c}"/>` +
    `<rect x="10" y="12" width="9" height="9" rx="1" fill="${c}"/>` +
    `<rect x="18" y="10" width="42" height="7" rx="2" fill="${c}"/>` +
    `<rect x="60" y="11" width="34" height="5" rx="1.5" fill="${c}"/>` +
    `<rect x="26" y="17" width="9" height="16" rx="1.5" fill="${c}"/>` +
    `<rect x="42" y="17" width="9" height="6" rx="1" fill="${c}"/>`,
};

export function gunGlyph(id, color) {
  const shape = GUN_SHAPES[id] ?? GUN_SHAPES.pistol;
  return `<svg class="loadout-glyph" viewBox="0 0 120 40" aria-hidden="true"><g>${shape(HEX(color))}</g></svg>`;
}

export function grenadeGlyph(id) {
  const shape = id === 'he'
    ? `<circle cx="46" cy="25" r="10" fill="#4a5a3a"/><rect x="55" y="21" width="16" height="5" rx="2" fill="#8b93a3"/><path d="M42 19l4 4M50 24l-3 3" stroke="#b4c48b" stroke-width="1.5" stroke-linecap="round"/>`
    : `<circle cx="46" cy="25" r="10" fill="#d8dee8"/><rect x="55" y="21" width="16" height="5" rx="2" fill="#8b93a3"/><path d="M30 8l4 6M64 6l-3 8M18 25h10M60 38l-4-6" stroke="#d8dee8" stroke-width="2" stroke-linecap="round"/>`;
  return `<svg class="loadout-glyph" viewBox="0 0 120 40" aria-hidden="true">${shape}</svg>`;
}
