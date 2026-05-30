// Cardio activity type definitions + AI formatting helper.

export const CARDIO_TYPES = [
  { key: 'long-run',  icon: '🏃',  label: 'Long run',         showDist: true,  showDur: true },
  { key: 'interval',  icon: '⚡',  label: 'Speed / interval', showDist: true,  showDur: true },
  { key: 'movement',  icon: '🤸',  label: 'Movement class',   showDist: false, showDur: true },
  { key: 'hike',      icon: '🥾',  label: 'Hike / trek',      showDist: true,  showDur: true },
  { key: 'bike',      icon: '🚴',  label: 'Bike ride',        showDist: true,  showDur: true },
  { key: 'swim',      icon: '🏊',  label: 'Swim',             showDist: true,  showDur: true },
  { key: 'custom',    icon: '➕',  label: 'Custom cardio',    showDist: true,  showDur: true }
];

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
