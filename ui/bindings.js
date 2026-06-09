// Static event bindings — addEventListener wiring for all index.html elements that
// previously used inline onclick/oninput/onchange attributes.
// Dynamic handlers (innerHTML onclick strings in render functions) remain on window in app.js.

import { exportData, pullFromDrive, restorePhotosFromDrive } from '../integrations/drive-sync.js';
import { closeHeatmap } from './shared/heatmap.js';
import { autoResizeTA } from '../core/dom.js';
import { setTrendMode, setAnalysisMode, shiftAnalysisDate, generateWeeklyAnalysis } from './insights-tab.js';
import { saveGeminiKey, aiAttachFiles, sendAIMessage, askAI } from './chat-tab.js';
import {
  openSettings, closeSettings, fullBackup,
  openSyncSetup, closeSyncSetup, closeSyncQR, showSyncQR,
  copySecret, copyScript, saveAndTestSync, testSync, importData, wipeAll, syncGoogleFit,
} from './settings.js';
import {
  saveWorkoutSteps, toggleStepsEdit, toggleWaistEdit, addWaist,
  addWeight, toggleWeightEdit,
  onPhotoPicked, analyzePhotoComparison, dedupePhotos,
} from './body-tab.js';
import {
  openMealModal, closeMealModal, saveMeal, onMealPhotoSelected,
  openTemplatePicker, closeTemplatePicker, closeTemplateEdit, saveTemplateEdit,
  refineMealEstimate, requestMealEstimateUpdate, reanalyzeMeal, saveCurrentMealAsTemplate,
  mealAttachFiles,
} from './meals-tab.js';
import {
  shiftWorkoutDate, loadWorkoutPlan, startWorkout,
  startWorkoutTimer, finishWorkoutTimer, resetWorkoutTimer,
  pauseWorkoutTimer, resumeWorkoutTimer,
  cancelSession, finishSession, openPlanModal, closePlanModal,
  openCardioPicker, closeCardioPicker,
  closeSet, bumpReps, confirmSet, editSet, deleteCurrentSet,
  closeExercisePicker, addCustomExerciseText, closeTimerAttach,
  updateSessionDate, updateSessionTime, renderExerciseList,
  refineSessionEstimate, requestSessionEstimateUpdate, closeSessionRefine,
  sessionAttachFiles, onCardioPhotoSelected, updateEffortDisplay,
} from './workout-tab.js';

export const _setup = true; // dummy export so flattenModules includes this file

// Helper: wire a single element by ID
function on(id, event, handler) {
  document.getElementById(id)?.addEventListener(event, handler);
}

// Helper: wire all matching elements
function onAll(sel, event, handler) {
  document.querySelectorAll(sel).forEach(el => el.addEventListener(event, handler));
}

// Helper: close modal when clicking its backdrop
function backdropClose(modalId, closeFn) {
  document.getElementById(modalId)?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeFn();
  });
}

// ── HEADER ────────────────────────────────────────────────────────────────────
on('headerSettingsBtn', 'click', openSettings);

// ── WORKOUT TAB ───────────────────────────────────────────────────────────────
on('workoutPrevBtn',        'click', () => shiftWorkoutDate(-1));
on('workoutNextBtn',        'click', () => shiftWorkoutDate(1));
on('saveStepsBtn',          'click', saveWorkoutSteps);
on('fitSyncBtn',            'click', syncGoogleFit);
on('loadPlanBtn',           'click', loadWorkoutPlan);
on('startWorkoutFromPlanBtn','click', () => startWorkout('custom'));
on('startWorkoutEmptyBtn',  'click', () => startWorkout('custom'));
on('workoutCancelBtn',      'click', cancelSession);
on('startTimerBtn',         'click', startWorkoutTimer);
on('pauseTimerBtn',         'click', () => document.getElementById('pauseTimerBtn')?.textContent === 'Resume' ? resumeWorkoutTimer() : pauseWorkoutTimer());
on('finishTimerBtn',        'click', finishWorkoutTimer);
on('resetTimerBtn',         'click', resetWorkoutTimer);
on('sessionDate',           'change', e => updateSessionDate(e.target.value));
on('sessionTime',           'change', e => updateSessionTime(e.target.value));
on('viewPlanBtn',           'click', openPlanModal);
on('addCardioBtn',          'click', openCardioPicker);
on('cardioPhotoInput',      'change', e => onCardioPhotoSelected(e));
on('finishSessionBtn',      'click', finishSession);
on('resetSessionBtn',       'click', cancelSession);
// effort slider: pos 1–9 maps to RPE 2–10 (odd positions = between-emoji values)
on('effortInput', 'input', () => updateEffortDisplay());

// ── BODY TAB ──────────────────────────────────────────────────────────────────
on('saveWaistBtn',     'click',  addWaist);
on('waistEditBtn',     'click',  toggleWaistEdit);
on('saveWeightBtn',    'click',  addWeight);
on('weightEditBtn',    'click',  toggleWeightEdit);
on('photoCameraInput', 'change', onPhotoPicked);
on('photoGalleryInput','change', onPhotoPicked);
on('photoCameraBtn',   'click',  () => document.getElementById('photoCameraInput').click());
on('photoGalleryBtn',  'click',  () => document.getElementById('photoGalleryInput').click());
on('compareAnalyzeBtn','click',  analyzePhotoComparison);

// ── MEALS TAB ─────────────────────────────────────────────────────────────────
on('addMealBtn',          'click', () => openMealModal());
on('openTemplateBtnMeals','click', openTemplatePicker);

// ── ANALYSIS TAB ──────────────────────────────────────────────────────────────
on('analysisModeDay',   'click', () => setAnalysisMode('day'));
on('analysisModeWeek',  'click', () => setAnalysisMode('week'));
on('analysisPrevBtn',   'click', () => shiftAnalysisDate(-1));
on('analysisNextBtn',   'click', () => shiftAnalysisDate(1));
on('trendModeDay',      'click', () => setTrendMode('day'));
on('trendModeWeek',     'click', () => setTrendMode('week'));
on('trendModeMonth',    'click', () => setTrendMode('month'));
on('stepsEditBtn',      'click', toggleStepsEdit);
on('smartUpdateBtn',    'click', () => window.smartUpdateSummaries?.());
on('weeklyUpdateBtn',   'click', generateWeeklyAnalysis);

// ── AI TAB ────────────────────────────────────────────────────────────────────
on('aiSetupSettingsBtn','click', openSettings);
on('aiAttachBtn',       'click', () => document.getElementById('aiFileInput').click());
on('aiFileInput',       'change', e => aiAttachFiles(e.target));
on('aiInput',           'input',  e => autoResizeTA(e.target));
on('aiSendBtn',         'click',  sendAIMessage);
onAll('.chip[data-ask]', 'click', e => askAI(e.currentTarget.dataset.ask));

// ── NAV ───────────────────────────────────────────────────────────────────────
onAll('nav button[data-tab]', 'click', e => window.switchTab?.(e.currentTarget.dataset.tab));

// ── SETTINGS MODAL ────────────────────────────────────────────────────────────
backdropClose('settingsModal', closeSettings);
on('cloudBackupBtn',   'click', () => exportData({ cloud: true }));
on('localBackupBtn',   'click', () => exportData({ local: true }));
on('fullBackupBtn',    'click', fullBackup);
on('restorePhotosBtn', 'click', restorePhotosFromDrive);
on('dedupePhotosBtn',  'click', dedupePhotos);
on('openSyncSetupBtn', 'click', openSyncSetup);
on('syncPullBtn',      'click', () => pullFromDrive({ silent: false }));
on('syncTestBtn',      'click', testSync);
on('geminiKeyInput',   'input', e => saveGeminiKey(e.target.value));
on('importTriggerBtn', 'click', () => document.getElementById('importInput').click());
on('importInput',      'change', importData);
on('wipeAllBtn',       'click', () => { if (confirm('Erase ALL data? This cannot be undone.')) wipeAll(); });
on('closeSettingsBtn', 'click', closeSettings);

// ── PLAN MODAL ────────────────────────────────────────────────────────────────
backdropClose('planModal', closePlanModal);
on('closePlanBtn', 'click', closePlanModal);

// ── MEAL MODAL ────────────────────────────────────────────────────────────────
backdropClose('mealModal', closeMealModal);
on('mealCameraInput',    'change', onMealPhotoSelected);
on('mealGalleryInput',   'change', onMealPhotoSelected);
on('mealCameraBtn',      'click', () => document.getElementById('mealCameraInput').click());
on('mealGalleryBtn',     'click', () => document.getElementById('mealGalleryInput').click());
on('mealFromTemplateBtn','click', openTemplatePicker);
on('mealDescInput',      'input', e => autoResizeTA(e.target));
on('mealAttachBtn',      'click', () => document.getElementById('mealFileInput').click());
on('mealFileInput',      'change', e => mealAttachFiles(e.target));
on('refineInput',        'input', e => autoResizeTA(e.target));
on('mealRefineSendBtn',  'click', refineMealEstimate);
on('updateMealEstimateBtn','click', requestMealEstimateUpdate);
on('reanalyzeMealBtn',   'click', reanalyzeMeal);
on('saveAsTemplateBtn',  'click', saveCurrentMealAsTemplate);
on('saveMealBtn',        'click', saveMeal);
on('cancelMealBtn',      'click', closeMealModal);

// ── SYNC SETUP MODAL ──────────────────────────────────────────────────────────
backdropClose('syncModal', closeSyncSetup);
on('copyScriptBtn',    'click', copyScript);
on('copySecretBtn',    'click', copySecret);
on('showSyncQrBtn',    'click', showSyncQR);
on('saveTestSyncBtn',  'click', saveAndTestSync);
on('closeSyncSetupBtn','click', closeSyncSetup);

// ── SESSION REFINE MODAL ──────────────────────────────────────────────────────
backdropClose('sessionRefineModal', closeSessionRefine);
on('sessionAttachBtn',       'click', () => document.getElementById('sessionFileInput').click());
on('sessionFileInput',       'change', e => sessionAttachFiles(e.target));
on('sessionRefineInput',     'input', e => autoResizeTA(e.target));
on('sessionRefineSendBtn',   'click', refineSessionEstimate);
on('updateSessionEstimateBtn','click', requestSessionEstimateUpdate);
on('closeSessionRefineBtn',  'click', closeSessionRefine);

// ── ADD-EXERCISE MODAL ────────────────────────────────────────────────────────
backdropClose('exerciseModal', closeExercisePicker);
on('exerciseSearch',     'input', e => renderExerciseList(e.target.value));
on('addCustomExerciseBtn','click', addCustomExerciseText);
on('cancelExerciseBtn',  'click', closeExercisePicker);

// ── ADD-SET MODAL ─────────────────────────────────────────────────────────────
backdropClose('setModal', closeSet);
on('repsBumpDownBtn','click', () => bumpReps(-1));
on('repsBumpUpBtn',  'click', () => bumpReps(1));
on('confirmSetBtn',  'click', confirmSet);
on('deleteSetBtn',   'click', deleteCurrentSet);
on('cancelSetBtn',   'click', closeSet);

// ── TIMER ATTACH MODAL ────────────────────────────────────────────────────────
backdropClose('timerAttachModal', closeTimerAttach);
on('closeTimerAttachBtn','click', closeTimerAttach);

// ── CARDIO PICKER MODAL ───────────────────────────────────────────────────────
backdropClose('cardioPickerModal', closeCardioPicker);
on('cancelCardioPickerBtn','click', closeCardioPicker);

// ── TEMPLATE PICKER MODAL ─────────────────────────────────────────────────────
backdropClose('templatePickerModal', closeTemplatePicker);
on('closeTemplatePickerBtn','click', closeTemplatePicker);

// ── TEMPLATE EDIT MODAL ───────────────────────────────────────────────────────
backdropClose('templateEditModal', closeTemplateEdit);
on('saveTemplateEditBtn',  'click', saveTemplateEdit);
on('cancelTemplateEditBtn','click', closeTemplateEdit);

// ── SYNC QR MODAL ─────────────────────────────────────────────────────────────
backdropClose('syncQrModal', closeSyncQR);
on('closeSyncQrBtn','click', closeSyncQR);

// ── HEATMAP MODAL ─────────────────────────────────────────────────────────────
backdropClose('heatmapModal', closeHeatmap);
on('closeHeatmapBtn','click', closeHeatmap);
