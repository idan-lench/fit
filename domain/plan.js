// Weekly workout plan + date-to-plan-key mapping.
// These are personal schedule constants — the Trainer agent will eventually
// be able to update them (see AGENT_PLAN.md).

export const PLAN = {
  tue: {
    label: 'Tuesday — 8k run + upper',
    cardio: '8k easy run',
    cardioType: 'long-run',
    exercises: ['Push-ups', 'Pull-ups', 'Plank (sec)']
  },
  wed: {
    label: 'Wednesday — Movement',
    cardio: 'Movement training (1 hr)',
    cardioType: 'movement',
    exercises: []
  },
  thu: {
    label: 'Thursday — Intervals + upper',
    cardio: '20–30 min intervals',
    cardioType: 'interval',
    exercises: ['Push-ups', 'Pull-ups', 'Plank (sec)']
  },
  sun: {
    label: 'Sunday — Legs',
    cardio: null,
    exercises: ['Squats', 'Lunges (each leg)', 'Glute bridges', 'Plank (sec)']
  },
  hike: {
    label: 'Hike / Trek',
    cardio: 'Trail / route · distance · elevation · time',
    cardioType: 'hike',
    cardioPlaceholder: 'נחל צאלים · 13km · 700m elev · 8h',
    exercises: []
  },
  bike: {
    label: 'Bike ride',
    cardio: 'Route · distance · elevation · time · pace',
    cardioType: 'bike',
    cardioPlaceholder: 'Tel Aviv loop · 30km · 200m · 1h 15m',
    exercises: []
  },
  custom: {
    label: 'Custom workout',
    cardio: null,
    exercises: []
  }
};

export const WEEKLY_PLAN = [
  { day: 'Sunday',    plan: 'Legs (squats, lunges, glutes, abs)',              rest: false, key: 'sun' },
  { day: 'Monday',    plan: 'Rest day',                                        rest: true,  key: 'mon' },
  { day: 'Tuesday',   plan: '8k run + upper (push-ups, pull-ups, abs)',        rest: false, key: 'tue' },
  { day: 'Wednesday', plan: 'Movement training (1 hr)',                        rest: false, key: 'wed' },
  { day: 'Thursday',  plan: 'Intervals + upper (push-ups, pull-ups, abs)',     rest: false, key: 'thu' },
  { day: 'Friday',    plan: 'Rest day',                                        rest: true,  key: 'fri' },
  { day: 'Saturday',  plan: 'Rest day',                                        rest: true,  key: 'sat' }
];

// Returns the PLAN key for a given ISO date, or null for rest days.
export function getPlanKeyForDate(dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay(); // 0=Sun..6=Sat
  const map = { 0: 'sun', 2: 'tue', 3: 'wed', 4: 'thu' };
  const key = map[dow];
  return (key && PLAN[key]) ? key : null;
}

// Returns the plan key that matches today's day-of-week, or 'custom'.
export function suggestedDay() {
  const d = new Date().getDay();
  if (d === 0 && PLAN.sun) return 'sun';
  if (d === 2 && PLAN.tue) return 'tue';
  if (d === 3 && PLAN.wed) return 'wed';
  if (d === 4 && PLAN.thu) return 'thu';
  return 'custom';
}
