import { test as setup } from '@playwright/test';

setup('prepare MSW mock data', async ({ page }) => {
  // Navigate to dashboard to ensure MSW is initialized
  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');
});
