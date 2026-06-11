// Aggregates every prompt fragment into one PROMPTS object.
// Edit the individual files (one prompt or tight group each), not this.
import { mealAnalysis, mealAnalysisPhotosBlock_withPhotos, mealAnalysisPhotosBlock_noPhotos, mealAnalysisSaw_withPhotos, mealAnalysisSaw_noPhotos } from './meal-analysis.js';
import { sessionAnalysis } from './session-analysis.js';
import { dailyAnalysis } from './daily-analysis.js';
import { weeklyAnalysis } from './weekly-analysis.js';
import { chatSystem } from './chat-system.js';
import { mealChatSystem } from './meal-chat-system.js';
import { mealEstimateUpdate } from './meal-estimate-update.js';
import { mealTemplateDelta } from './meal-template-delta.js';
import { sessionChatSystem } from './session-chat-system.js';
import { sessionEstimateUpdate } from './session-estimate-update.js';
import { cardioPhoto } from './cardio-photo.js';
import { intervalPhoto } from './interval-photo.js';
import { exercisePhoto } from './exercise-photo.js';
import { trainerSystem } from './trainer.js';

export const PROMPTS = {
  mealAnalysis,
  mealAnalysisPhotosBlock_withPhotos,
  mealAnalysisPhotosBlock_noPhotos,
  mealAnalysisSaw_withPhotos,
  mealAnalysisSaw_noPhotos,
  sessionAnalysis,
  dailyAnalysis,
  weeklyAnalysis,
  chatSystem,
  mealChatSystem,
  mealEstimateUpdate,
  mealTemplateDelta,
  sessionChatSystem,
  sessionEstimateUpdate,
  cardioPhoto,
  intervalPhoto,
  exercisePhoto,
  trainerSystem,
};
