import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function drawStroke(page, offset = 0) {
  const svg = page.locator('#drawSvg');
  const bounds = await svg.boundingBox();
  if (!bounds) throw new Error('Drawing SVG has no visible bounds');
  const points = [
    [45, 275], [60, 235], [78, 195], [96, 155], [116, 115], [138, 80]
  ];
  await page.mouse.move(bounds.x + points[0][0] + offset, bounds.y + points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) {
    await page.mouse.move(bounds.x + x + offset, bounds.y + y, { steps: 3 });
  }
  await page.mouse.up();
}

test('draw, undo/redo, restore IndexedDB draft and export a real TTF', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto('/');
  await expect(page.locator('#glyphGrid button').first()).toBeVisible();
  await expect(page.locator('#currentCharLabel')).toHaveText('А');

  // Draw a multi-point pressure-aware stroke on the first glyph.
  await drawStroke(page);
  await expect(page.locator('#drawSvg path')).toHaveCount(1);
  await expect(page.locator('#progressText')).toContainText('1 /');

  // Undo and redo must change the visible glyph geometry.
  await page.locator('#undoBtn').click();
  await expect(page.locator('#drawSvg path')).toHaveCount(0);
  await page.locator('#redoBtn').click();
  await expect(page.locator('#drawSvg path')).toHaveCount(1);

  // Wait for queued IndexedDB persistence, then verify recovery after reload.
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.locator('#drawSvg path')).toHaveCount(1);
  await expect(page.locator('#progressText')).toContainText('1 /');

  // Draw on a second glyph, proving selection and per-glyph separation.
  await page.locator('#glyphGrid button').filter({ hasText: /^Б$/ }).click();
  await expect(page.locator('#currentCharLabel')).toHaveText('Б');
  await drawStroke(page, 18);
  await expect(page.locator('#drawSvg path')).toHaveCount(1);
  await page.locator('#glyphGrid button').filter({ hasText: /^А$/ }).click();
  await expect(page.locator('#drawSvg path')).toHaveCount(1);

  // The exported file must be a non-empty binary TrueType font, not an OTF renamed .ttf.
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadBtn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.ttf$/i);
  const filePath = await download.path();
  expect(filePath).toBeTruthy();
  const bytes = await readFile(filePath);
  expect(bytes.byteLength).toBeGreaterThan(100);
  expect(bytes.subarray(0, 4).toString('hex')).toBe('00010000');

  expect(pageErrors, 'Browser runtime should not raise uncaught exceptions').toEqual([]);
});
