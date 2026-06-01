// E2E smoke tests: real browser, real ES modules, real IndexedDB.
// Covers the 5 critical paths that jsdom can't validate (module loading,
// actual DOM visibility, CSS transitions, etc.).
// Run locally: npm run test:e2e
// Run in CI:   npm run test:e2e (server is auto-started by playwright.config.js)

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Suppress expected external-resource failures (GIS, body-muscles CDN)
  page.on('requestfailed', () => {});
  await page.goto('/');
  // Wait for the app to boot: nav must be visible
  await page.waitForSelector('nav button[data-tab="analysis"]', { timeout: 8000 });
});

test('app loads without JS errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Re-navigate so pageerror listener catches boot errors
  await page.goto('/');
  await page.waitForSelector('nav button[data-tab="analysis"]');
  // Filter out expected third-party failures
  const appErrors = errors.filter(m =>
    !m.includes('googleapis') && !m.includes('unpkg') && !m.includes('accounts.google')
  );
  expect(appErrors).toHaveLength(0);
});

test('settings modal opens and closes', async ({ page }) => {
  await page.click('#headerSettingsBtn');
  await expect(page.locator('#settingsModal')).toHaveClass(/show/);

  await page.click('#closeSettingsBtn');
  await expect(page.locator('#settingsModal')).not.toHaveClass(/show/);
});

test('nav tabs switch active section', async ({ page }) => {
  await page.click('nav button[data-tab="workout"]');
  await expect(page.locator('#tab-workout')).toHaveClass(/active/);
  await expect(page.locator('#tab-analysis')).not.toHaveClass(/active/);

  await page.click('nav button[data-tab="meals"]');
  await expect(page.locator('#tab-meals')).toHaveClass(/active/);

  await page.click('nav button[data-tab="body"]');
  await expect(page.locator('#tab-body')).toHaveClass(/active/);
});

test('meal modal opens and closes', async ({ page }) => {
  await page.click('nav button[data-tab="meals"]');
  await page.click('#addMealBtn');
  await expect(page.locator('#mealModal')).toHaveClass(/show/);

  await page.click('#cancelMealBtn');
  await expect(page.locator('#mealModal')).not.toHaveClass(/show/);
});

test('workout tab renders steps input and history section', async ({ page }) => {
  await page.click('nav button[data-tab="workout"]');
  await expect(page.locator('#workoutStepsInput')).toBeVisible();
  await expect(page.locator('#tab-workout h2', { hasText: 'History' })).toBeVisible();
});
