import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 15000,
  retries: 1,
  use: {
    browserName: 'chromium',
    headless: true,
    baseURL: 'http://localhost:8001',
  },
  webServer: {
    command: 'python3 -m http.server 8001',
    url: 'http://localhost:8001',
    reuseExistingServer: !process.env.CI,
    timeout: 10000,
  },
});
