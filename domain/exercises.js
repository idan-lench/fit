// Exercise library (grouped by muscle category) and session history helpers.

export const EXERCISE_LIBRARY = {
  Upper: [
    'Push-ups', 'Ring push-ups', 'Decline push-ups', 'Diamond push-ups', 'Archer push-ups',
    'Pull-ups', 'Chin-ups', 'Inverted rows', 'TRX low row', 'Dips', 'Parallel bars', 'Pike push-ups',
    'Front raises', 'Bench press', 'Incline bench press', 'Overhead press', 'Barbell rows',
    'Shoulder Press Machine', 'Handstand (sec)'
  ],
  Lower: [
    'Squats', 'Lunges (each leg)', 'Bulgarian split squats', 'Glute bridges',
    'Single-leg glute bridges', 'Calf raises', 'Wall sit (sec)', 'Step-ups', 'Leg press'
  ],
  Core: [
    'Plank (sec)', 'Side plank (sec)', 'Hanging leg raises', 'Hanging knee tucks', 'Hanging knee to leg extension',
    'Hollow hold (sec)', 'Crunches', 'Bicycle crunches', 'Russian twists',
    'Dead bug', 'Mountain climbers', 'Bird dog'
  ]
};

// Returns the reps array from the most recent session containing this exercise, or null.
export function lastSetsFor(sessions, name) {
  for (let i = sessions.length - 1; i >= 0; i--) {
    const e = sessions[i].entries?.find(en => en.name === name);
    if (e && e.sets?.length) return e.sets.map(x => x.reps);
  }
  return null;
}
