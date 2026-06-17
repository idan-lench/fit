// Cardio activity type definitions + AI formatting helper.

export const CARDIO_TYPES = [
  { key: 'long-run',  icon: '🏃',  label: 'Long run',         showDist: true,  showDur: true },
  { key: 'interval',  icon: '⚡',  label: 'Speed / interval', showDist: true,  showDur: true },
  { key: 'movement',  icon: '🤸',  label: 'Movement class',   showDist: false, showDur: true },
  { key: 'hike',      icon: '🥾',  label: 'Hike / trek',      showDist: true,  showDur: true },
  { key: 'bike',      icon: '🚴',  label: 'Bike ride',        showDist: true,  showDur: true },
  { key: 'swim_freestyle',   icon: '🏊',  label: 'Swim — freestyle',   showDist: true,  showDur: true },
  { key: 'swim_butterfly',   icon: '🦋',  label: 'Swim — butterfly',   showDist: true,  showDur: true },
  { key: 'swim_breaststroke',icon: '🐸',  label: 'Swim — breaststroke',showDist: true,  showDur: true },
  { key: 'swim_backstroke',  icon: '🏊',  label: 'Swim — backstroke',  showDist: true,  showDur: true },
  { key: 'custom',    icon: '➕',  label: 'Custom cardio',    showDist: true,  showDur: true }
];

// ---------- ACTIVITY LABELS (single source of truth for icons + names) ----------
// Cardio icons live in CARDIO_TYPES above; the rest live here.
export const STRENGTH_ICON = '🏋️';

// Legacy/aliased cardio types not in CARDIO_TYPES (older sessions, Google Fit).
const LEGACY_CARDIO_LABELS = {
  run: '🏃 Run',
  treadmill_run: '🏃 Run',
  walk: '🚶 Walk',
  treadmill_walk: '🚶 Walk',
  swim: '🏊 Swim',
};

// Emoji + friendly name for a single cardio activity type.
export function cardioLabel(type) {
  if (LEGACY_CARDIO_LABELS[type]) return LEGACY_CARDIO_LABELS[type];
  const c = CARDIO_TYPES.find(c => c.key === type);
  return c ? `${c.icon} ${c.label}` : '🏃 Cardio';
}

// Label a session by what was actually DONE (icon + name) rather than the plan
// title. Returns null when the session has no logged strength/cardio, so the
// caller can fall back to the plan label.
export function sessionActivityLabel(session) {
  const hasStrength = (session?.entries || []).some(e => e?.name && (e.sets || []).some(x => Number(x?.reps) > 0));
  const cardio = (session?.cardioActivities || []).filter(a => a?.type);
  if (hasStrength && cardio.length) return `${STRENGTH_ICON}🏃 Cardio + strength`;
  if (hasStrength) return `${STRENGTH_ICON} Strength workout`;
  if (cardio.length) {
    const names = [...new Set(cardio.map(a => cardioLabel(a.type)))];
    return names.length === 1 ? names[0] : '🏃 Cardio';
  }
  return null;
}

// Formats a cardio activities array as a compact string for AI prompts.
export function formatCardioActivitiesForAI(activities) {
  if (!activities || !activities.length) return '  (none)';
  return activities.map(a => {
    const def = CARDIO_TYPES.find(c => c.key === a.type) || CARDIO_TYPES[CARDIO_TYPES.length - 1];
    const parts = [def.label];
    if (a.distance) parts.push('dist: ' + a.distance);
    if (a.duration) parts.push('time: ' + a.duration);
    if (a.notes) parts.push('notes: ' + a.notes);
    return '  - ' + parts.join(' · ');
  }).join('\n');
}
