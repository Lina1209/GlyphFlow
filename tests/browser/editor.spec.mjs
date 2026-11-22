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

  // Load the downloaded binary as a real browser font and verify glyph rendering.
  const fontBase64 = bytes.toString('base64');
  const fontRender = await page.evaluate(async base64 => {
    const font = new FontFace('GlyphFlowBrowserSmoke', `url(data:font/ttf;base64,${base64})`);
    await font.load();
    document.fonts.add(font);
    await document.fonts.load('48px GlyphFlowBrowserSmoke', 'АБ');
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 90;
    const context = canvas.getContext('2d');
    context.font = '48px GlyphFlowBrowserSmoke';
    context.fillText('АБ', 8, 62);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let paintedPixels = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 0) paintedPixels++;
    }
    return {
      loaded: document.fonts.check('48px GlyphFlowBrowserSmoke', 'АБ'),
      width: context.measureText('АБ').width,
      paintedPixels
    };
  }, fontBase64);
  expect(fontRender.loaded).toBe(true);
  expect(fontRender.width).toBeGreaterThan(0);
  expect(fontRender.paintedPixels).toBeGreaterThan(0);

  expect(pageErrors, 'Browser runtime should not raise uncaught exceptions').toEqual([]);
});


test('touch input commits strokes and cancels interrupted gestures safely', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');

  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const svg = page.locator('#drawSvg');
  const bounds = await svg.boundingBox();
  if (!bounds) throw new Error('Drawing SVG has no visible bounds');

  const point = (x, y) => ({
    x: Math.round(bounds.x + x),
    y: Math.round(bounds.y + y),
    id: 1,
    radiusX: 2,
    radiusY: 2,
    force: 0.7
  });

  // An interrupted touch must discard the in-progress stroke, not save it.
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [point(55, 280)]
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [point(80, 220)]
  });
  await expect(svg.locator('path')).toHaveCount(1);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchCancel',
    touchPoints: []
  });
  await expect(svg.locator('path')).toHaveCount(0);

  // A new touch gesture must still be accepted and committed normally.
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [point(65, 280)]
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [point(95, 220)]
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [point(125, 160)]
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: []
  });
  await expect(svg.locator('path')).toHaveCount(1);
  await expect(page.locator('#progressText')).toContainText('1 /');
  expect(pageErrors, 'Touch interaction should not raise uncaught exceptions').toEqual([]);
  await session.detach();
});

test('pointer cancellation and glyph switching never commit partial strokes', async ({ page }) => {
  await page.goto('/');
  const svg = page.locator('#drawSvg');
  const bounds = await svg.boundingBox();
  if (!bounds) throw new Error('Drawing SVG has no visible bounds');

  await page.mouse.move(bounds.x + 55, bounds.y + 280);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 90, bounds.y + 220, { steps: 3 });
  await expect(svg.locator('path')).toHaveCount(1);
  await page.evaluate(() => {
    const svgElement = document.querySelector('#drawSvg');
    svgElement.dispatchEvent(new PointerEvent('pointercancel', {
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      bubbles: true
    }));
  });
  await expect(svg.locator('path')).toHaveCount(0);
  await page.mouse.up();

  // Start another gesture, then switch glyph through the editor's selection handler.
  await page.mouse.move(bounds.x + 55, bounds.y + 280);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 90, bounds.y + 220, { steps: 3 });
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('#glyphGrid button')]
      .find(item => item.textContent === 'Б');
    button?.click();
  });
  await expect(page.locator('#currentCharLabel')).toHaveText('Б');
  await expect(svg.locator('path')).toHaveCount(0);
  await page.mouse.up();
});


test('canvas zoom, pan and coordinate mapping stay stable', async ({ page }) => {
  await page.goto('/');
  const svg = page.locator('#drawSvg');
  const initial = await svg.getAttribute('viewBox');
  expect(initial).toBe('0 0 360 360');

  await page.locator('#zoomInBtn').click();
  await expect(page.locator('#zoomLevel')).toHaveText('125%');
  const zoomed = (await svg.getAttribute('viewBox')).split(' ').map(Number);
  expect(zoomed[2]).toBeCloseTo(288, 4);
  expect(zoomed[3]).toBeCloseTo(288, 4);
  await expect(page.locator('#guideSvg')).toHaveAttribute('viewBox', (await svg.getAttribute('viewBox')));

  await page.locator('#panRightBtn').click();
  const panned = (await svg.getAttribute('viewBox')).split(' ').map(Number);
  expect(panned[0]).toBeGreaterThan(zoomed[0]);
  await expect(page.locator('#guideSvg')).toHaveAttribute('viewBox', (await svg.getAttribute('viewBox')));

  const panBounds = await svg.boundingBox();
  if (!panBounds) throw new Error('Drawing SVG has no visible bounds');
  const panStartX = panBounds.x + panBounds.width / 2;
  const panStartY = panBounds.y + panBounds.height / 2;
  await page.mouse.move(panStartX, panStartY);
  await page.mouse.down({button: 'middle'});
  await page.mouse.move(panStartX + 20, panStartY + 8, {steps: 2});
  await page.mouse.up({button: 'middle'});
  const mousePanned = (await svg.getAttribute('viewBox')).split(' ').map(Number);
  expect(mousePanned[0]).toBeLessThan(panned[0]);

  await page.locator('#zoomResetBtn').click();
  await expect(svg).toHaveAttribute('viewBox', '0 0 360 360');
  const wheelBounds = await svg.boundingBox();
  if (!wheelBounds) throw new Error('Drawing SVG has no visible bounds');
  await page.mouse.move(wheelBounds.x + wheelBounds.width / 2, wheelBounds.y + wheelBounds.height / 2);
  await page.mouse.wheel(0, -120);
  await expect(page.locator('#zoomLevel')).not.toHaveText('100%');

  // Draw after zooming: the screen-to-SVG transform must still produce valid geometry.
  const bounds = await svg.boundingBox();
  if (!bounds) throw new Error('Drawing SVG has no visible bounds');
  const start = {x: bounds.x + bounds.width * 0.35, y: bounds.y + bounds.height * 0.75};
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 18, start.y - 24, {steps: 3});
  await page.mouse.move(start.x + 36, start.y - 48, {steps: 3});
  await page.mouse.up();
  await expect(svg.locator('path')).toHaveCount(1);
  const pathData = await svg.locator('path').getAttribute('d');
  expect(pathData).toBeTruthy();
  const coordinates = [...pathData.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
  expect(coordinates.length).toBeGreaterThan(8);
  expect(coordinates.every(Number.isFinite)).toBe(true);
});

test('drawing workspace fits a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({width: 375, height: 812});
  await page.goto('/');
  const canvas = await page.locator('#drawSvg').boundingBox();
  expect(canvas).toBeTruthy();
  expect(canvas.width).toBeLessThanOrEqual(327);
  await expect(page.locator('#zoomInBtn')).toBeVisible();
  await expect(page.locator('#panLeftBtn')).toBeVisible();
  await page.locator('#zoomInBtn').click();
  await expect(page.locator('#zoomLevel')).toHaveText('125%');
});


test('two-finger touch gesture zooms and pans without committing a glyph', async ({ page }) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/');
  const svg = page.locator('#drawSvg');
  await page.evaluate(() => document.querySelector('#drawSvg').scrollIntoView({block: 'center', inline: 'center'}));
  const initialViewBox = await svg.getAttribute('viewBox');
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 2});
  await page.evaluate(() => {
    window.__glyphFlowPointerTrace = [];
    const target = document.querySelector('#drawSvg');
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'touchstart', 'touchmove']) {
      document.addEventListener(type, event => window.__glyphFlowPointerTrace.push({
        type, target: event.target?.id || event.target?.tagName,
        pointerId: event.pointerId, pointerType: event.pointerType,
        isPrimary: event.isPrimary, x: event.clientX, y: event.clientY,
        touches: event.touches?.length
      }), true);
    }
  });
  const bounds = await svg.boundingBox();
  if (!bounds) throw new Error('Drawing SVG has no visible bounds');
  const viewport = await page.evaluate(() => ({width: innerWidth, height: innerHeight}));
  const firstTouch = {x: Math.round(bounds.x + 90), y: Math.round(bounds.y + 220)};
  expect(firstTouch.x).toBeGreaterThanOrEqual(0);
  expect(firstTouch.y).toBeGreaterThanOrEqual(0);
  expect(firstTouch.x).toBeLessThan(viewport.width);
  expect(firstTouch.y).toBeLessThan(viewport.height);

  const touch = (id, x, y) => ({
    id,
    x: Math.round(bounds.x + x),
    y: Math.round(bounds.y + y),
    radiusX: 3,
    radiusY: 3,
    force: 0.7
  });

  // First contact begins a potential stroke; adding the second contact must
  // cancel it and switch the interaction into viewport navigation.
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [touch(1, 90, 220)]
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [touch(1, 90, 220), touch(2, 210, 220)]
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [touch(1, 65, 220), touch(2, 235, 220)]
  });
  const zoomedViewBox = await svg.getAttribute('viewBox');
  expect(zoomedViewBox, JSON.stringify(await page.evaluate(() => window.__glyphFlowPointerTrace))).not.toBe(initialViewBox);
  await expect(svg.locator('path')).toHaveCount(0);

  // Move the pair together to verify midpoint panning as well as pinch zoom.
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [touch(1, 80, 240), touch(2, 250, 240)]
  });
  const movedViewBox = await svg.getAttribute('viewBox');
  expect(movedViewBox).not.toBe(zoomedViewBox);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [touch(1, 80, 240)]
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: []
  });
  await expect(svg.locator('path')).toHaveCount(0);
  await expect(page.locator('#progressText')).toContainText('0 /');
  await session.detach();
});
