import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function drawStroke(page, offset = 0) {
  const svg = page.locator('#drawSvg');
  const bounds = await svg.boundingBox();
  if (!bounds) throw new Error('Drawing SVG has no visible bounds');
  const points = [
    [45, 275], [60, 235], [78, 195], [96, 155], [116, 115], [138, 80]
  ];
  // Coordinates are authored in the SVG's 360x360 viewBox. Scale them to
  // the actual CSS viewport so the same gesture remains inside small screens.
  const scaleX = bounds.width / 360;
  const scaleY = bounds.height / 360;
  await page.mouse.move(bounds.x + points[0][0] * scaleX + offset, bounds.y + points[0][1] * scaleY);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) {
    await page.mouse.move(bounds.x + x * scaleX + offset, bounds.y + y * scaleY, { steps: 3 });
  }
  await page.mouse.up();
}

async function drawTouchStroke(page, offset = 0, pointerId = 1000) {
  await page.locator('#drawSvg').evaluate((svg, args) => {
    const points = [
      [45 + args.offset, 275], [60 + args.offset, 235], [78 + args.offset, 195],
      [96 + args.offset, 155], [116 + args.offset, 115], [138 + args.offset, 80]
    ];
    const matrix = svg.getScreenCTM();
    const screenPoints = points.map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix));
    const dispatch = (type, point, buttons) => svg.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: args.pointerId,
      pointerType: 'touch', isPrimary: true, button: 0, buttons,
      clientX: point.x, clientY: point.y
    }));
    dispatch('pointerdown', screenPoints[0], 1);
    for (const point of screenPoints.slice(1)) dispatch('pointermove', point, 1);
    dispatch('pointerup', screenPoints[screenPoints.length - 1], 0);
  }, {offset, pointerId});
}

async function drawClosedContour(page, points) {
  const bounds = await page.locator('#drawSvg').boundingBox();
  if (!bounds) throw new Error('Drawing SVG has no visible bounds');
  await page.mouse.move(bounds.x + points[0][0], bounds.y + points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) {
    await page.mouse.move(bounds.x + x, bounds.y + y, {steps: 3});
  }
  await page.mouse.up();
}

async function clickContourPath(page, path) {
  const targetIndex = await path.getAttribute('data-contour-index');
  const selectorHandle = page.locator(`#drawSvg .contour-select-handle[data-contour-index="${targetIndex}"]`);
  await expect(selectorHandle).toBeVisible();
  await selectorHandle.click();
}


test('prevents a second tab from overwriting a newer saved draft', async ({ page, context }) => {
  await page.goto('/');
  const secondTab = await context.newPage();
  await secondTab.goto('/');
  await drawStroke(page);
  await expect(secondTab.locator('#draftSyncStatus')).toContainText('Черновик изменён в другой вкладке');
  await drawStroke(secondTab, 24);
  await secondTab.reload();
  await expect(secondTab.locator('#drawSvg .glyph-fill')).toBeVisible();
  const savedPointCount = await secondTab.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('glyphflow-local', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('projects', 'readonly');
        const request = tx.objectStore('projects').get('current');
        request.onsuccess = () => {
          const data = request.result?.glyphData || {};
          resolve(Object.values(data).reduce((sum, glyphStrokes) => sum + (Array.isArray(glyphStrokes) ? glyphStrokes.length : 0), 0));
        };
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
  expect(savedPointCount).toBe(1);
});

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


test('remains stable through repeated editing across narrow mobile viewport sizes', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/');
  const viewports = [
    {width: 320, height: 640},
    {width: 360, height: 740},
    {width: 412, height: 915}
  ];
  let offset = 0;
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const bounds = await page.locator('#drawSvg').boundingBox();
    expect(bounds, JSON.stringify(viewport)).toBeTruthy();
    expect(bounds.width, JSON.stringify(viewport)).toBeGreaterThan(180);
    await expect(page.locator('#zoomInBtn')).toBeVisible();
    await expect(page.locator('#panLeftBtn')).toBeVisible();
    for (let index = 0; index < 6; index++) {
      await drawTouchStroke(page, (offset++ % 5) * 2, 1000 + offset);
    }
    await expect(page.locator('#drawSvg path.glyph-fill')).toHaveCount(1);
    const svgNodeCount = await page.locator('#drawSvg path').count();
    expect(svgNodeCount).toBe(1);
  }

  // Keep a second glyph independent during the same long session.
  await page.locator('#glyphGrid button').filter({hasText: /^Б$/}).click();
  for (let index = 0; index < 6; index++) await drawTouchStroke(page, index * 2, 2000 + index);
  await expect(page.locator('#drawSvg path.glyph-fill')).toHaveCount(1);

  const readPersistedCounts = async () => page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('glyphflow-local', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readonly');
      const get = tx.objectStore('projects').get('current');
      get.onsuccess = () => resolve({
        A: get.result?.glyphData?.['А']?.length || 0,
        B: get.result?.glyphData?.['Б']?.length || 0
      });
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => db.close();
    };
  }));
  await expect.poll(readPersistedCounts, {timeout: 15000}).toEqual({A: 18, B: 6});

  // Repeated history navigation must not leave stale SVG nodes or mix glyphs.
  for (let index = 0; index < 4; index++) await page.locator('#undoBtn').click();
  await page.locator('#redoBtn').click();
  await page.locator('#glyphGrid button').filter({hasText: /^А$/}).click();
  await expect(page.locator('#drawSvg path.glyph-fill')).toHaveCount(1);
  await expect.poll(readPersistedCounts, {timeout: 15000}).toEqual({A: 18, B: 3});
  await page.locator('#glyphGrid button').filter({hasText: /^Б$/}).click();
  await expect.poll(readPersistedCounts, {timeout: 15000}).toEqual({A: 18, B: 3});
  const finalSvgNodes = await page.locator('#drawSvg path').count();
  expect(finalSvgNodes).toBe(1);
});

test('contour editor assigns a hole role and preserves it in the generated font', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Р', exact: true}).click();
  const svg = page.locator('#drawSvg');
  await page.locator('#brushSize').evaluate(element => {
    element.value = '36';
    element.dispatchEvent(new Event('input', {bubbles: true}));
  });
  // Use a broad filled brush capsule as the outer region and a smaller,
  // fully-contained capsule as the hole. A closed centerline loop would itself
  // be an annulus and would not provide a filled pixel for this visual assertion.
  await drawClosedContour(page, [[80,180],[280,180]]);
  await page.locator('#brushSize').evaluate(element => {
    element.value = '8';
    element.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await drawClosedContour(page, [[150,180],[210,180]]);
  await expect(svg.locator('.glyph-fill')).toHaveCount(1);

  await page.locator('#contourModeBtn').click();
  const innerContour = svg.locator('path[data-contour-index="1"]');
  await expect(innerContour).toBeVisible();
  await clickContourPath(page, innerContour);
  const roleSelect = page.locator('#contourRoleSelect');
  await expect(roleSelect).toBeEnabled();
  await roleSelect.selectOption('hole');
  await page.locator('#applyContourRoleBtn').click();
  await expect(roleSelect).toHaveValue('hole');
  await expect(page.locator('#contourStatus')).toContainText('Выбран контур 2');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadBtn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.ttf$/i);
  const fontBytes = await readFile(await download.path());
  const encoded = fontBytes.toString('base64');
  const pixels = await page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const parsed = window.opentype.parse(bytes.buffer);
    const glyph = parsed.charToGlyph('Р');
    const contours = [];
    let active = [];
    for (const command of glyph.path.commands) {
      if (command.type === 'M') {
        if (active.length) contours.push(active);
        active = [{x: command.x, y: command.y}];
      } else if (command.type === 'Z') {
        if (active.length) contours.push(active);
        active = [];
      } else if (Number.isFinite(command.x) && Number.isFinite(command.y)) {
        active.push({x: command.x, y: command.y});
      }
    }
    if (active.length) contours.push(active);
    const bounds = points => points.reduce((box, point) => ({
      minX: Math.min(box.minX, point.x), minY: Math.min(box.minY, point.y),
      maxX: Math.max(box.maxX, point.x), maxY: Math.max(box.maxY, point.y)
    }), {minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity});
    const inside = (point, polygon) => {
      let result = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i], b = polygon[j];
        if ((a.y > point.y) !== (b.y > point.y) &&
          point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
      }
      return result;
    };
    const findInterior = polygon => {
      const box = bounds(polygon);
      const candidates = [];
      for (let yi = 1; yi < 20; yi++) {
        for (let xi = 1; xi < 20; xi++) {
          const point = {
            x: box.minX + (box.maxX - box.minX) * xi / 20,
            y: box.minY + (box.maxY - box.minY) * yi / 20
          };
          if (inside(point, polygon)) candidates.push(point);
        }
      }
      if (!candidates.length) throw new Error('Could not find an interior sample point');
      return candidates.sort((a, b) =>
        Math.abs(a.x - (box.minX + box.maxX) / 2) + Math.abs(a.y - (box.minY + box.maxY) / 2) -
        (Math.abs(b.x - (box.minX + box.maxX) / 2) + Math.abs(b.y - (box.minY + box.maxY) / 2))
      )[0];
    };
    const face = new FontFace('GlyphHoleCheck', bytes.buffer);
    await face.load();
    document.fonts.add(face);
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 1200;
    const context = canvas.getContext('2d');
    context.font = '1000px GlyphHoleCheck';
    context.fillStyle = '#000';
    context.fillText('Р', 0, 950);
    const outerBox = bounds(contours[0]);
    // The outer capsule's center can fall into a hollow region of a brush outline;
    // sample near its upper interior band instead of assuming its bbox center is filled.
    const outerPoint = {
      x: (outerBox.minX + outerBox.maxX) / 2,
      y: outerBox.maxY - (outerBox.maxY - outerBox.minY) * 0.1
    };
    const holePoint = findInterior(contours[1]);
    const points = {
      outer: {x: outerPoint.x, y: 950 - outerPoint.y},
      hole: {x: holePoint.x, y: 950 - holePoint.y}
    };
    const read = point => context.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data[3];
    return {
      outerFill: read(points.outer),
      holeFill: read(points.hole),
      points,
      contourCount: contours.length,
      holeInsideOuter: inside(holePoint, contours[0]),
      signedAreas: contours.map(polygon => polygon.reduce((area, point, index) => {
        const next = polygon[(index + 1) % polygon.length];
        return area + point.x * next.y - next.x * point.y;
      }, 0))
    };
  }, encoded);
  expect(pixels.outerFill, JSON.stringify(pixels)).toBeGreaterThan(0);
  expect(pixels.holeFill, JSON.stringify(pixels)).toBe(0);
});

test('two separate hole contours remain distinct in the exported TTF', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Ф', exact: true}).click();
  await page.locator('#brushSize').evaluate(element => {
    element.value = '36';
    element.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await drawClosedContour(page, [[80,180],[280,180]]);
  await page.locator('#brushSize').evaluate(element => {
    element.value = '8';
    element.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await drawClosedContour(page, [[120,180],[140,180]]);
  await drawClosedContour(page, [[200,180],[220,180]]);
  await page.locator('#contourModeBtn').click();
  const roleSelect = page.locator('#contourRoleSelect');
  for (const index of [1, 2]) {
    const contour = page.locator(`path[data-contour-index="${index}"]`);
    await expect(contour).toBeVisible();
    await clickContourPath(page, contour);
    await roleSelect.selectOption('hole');
    await page.locator('#applyContourRoleBtn').click();
    await expect(roleSelect).toHaveValue('hole');
  }
  const holePathCount = await page.locator('#drawSvg .glyph-fill').getAttribute('d')
    .then(pathData => (pathData?.match(/M/g) || []).length);
  expect(holePathCount).toBe(3);
  const storedHoleDepths = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('glyphflow-local', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readonly');
      const get = tx.objectStore('projects').get('current');
      get.onsuccess = () => resolve((get.result?.glyphData?.['Ф'] || []).map(stroke => stroke.depth ?? 0));
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => db.close();
    };
  }));
  expect(storedHoleDepths).toEqual([0, 1, 1]);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadBtn').click();
  const download = await downloadPromise;
  const bytes = await readFile(await download.path());
  const encoded = bytes.toString('base64');
  const result = await page.evaluate(async base64 => {
    const buffer = Uint8Array.from(atob(base64), character => character.charCodeAt(0)).buffer;
    const glyph = window.opentype.parse(buffer).charToGlyph('Ф');
    const contours = [];
    let active = [];
    for (const command of glyph.path.commands) {
      if (command.type === 'M') {
        if (active.length) contours.push(active);
        active = [{x: command.x, y: command.y}];
      } else if (command.type === 'Z') {
        if (active.length) contours.push(active);
        active = [];
      } else if (Number.isFinite(command.x) && Number.isFinite(command.y)) {
        active.push({x: command.x, y: command.y});
      }
    }
    if (active.length) contours.push(active);
    const inside = (point, polygon) => {
      let result = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i], b = polygon[j];
        if ((a.y > point.y) !== (b.y > point.y) &&
          point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
      }
      return result;
    };
    const findInterior = polygon => {
      const box = polygon.reduce((result, point) => ({
        minX: Math.min(result.minX, point.x), minY: Math.min(result.minY, point.y),
        maxX: Math.max(result.maxX, point.x), maxY: Math.max(result.maxY, point.y)
      }), {minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity});
      const center = {x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2};
      if (inside(center, polygon)) return center;
      let best = null;
      let bestClearance = -1;
      for (let yi = 1; yi < 20; yi++) {
        for (let xi = 1; xi < 20; xi++) {
          const point = {
            x: box.minX + (box.maxX - box.minX) * xi / 20,
            y: box.minY + (box.maxY - box.minY) * yi / 20
          };
          if (!inside(point, polygon)) continue;
          const clearance = Math.min(
            point.x - box.minX, box.maxX - point.x,
            point.y - box.minY, box.maxY - point.y
          );
          if (clearance > bestClearance) { best = point; bestClearance = clearance; }
        }
      }
      if (best) return best;
      throw new Error('Could not find a point inside a counter');
    };
    const face = new FontFace('GlyphMultiHoleCheck', buffer);
    await face.load();
    document.fonts.add(face);
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 1200;
    const context = canvas.getContext('2d');
    context.font = '1000px GlyphMultiHoleCheck';
    context.fillStyle = '#000';
    context.fillText('Ф', 0, 950);
    const samples = contours.slice(1).map(polygon => findInterior(polygon));
    return {
      contourCount: contours.length,
      holesInsideOuter: samples.every(point => inside(point, contours[0])),
      holeAlphas: samples.map(point => context.getImageData(Math.round(point.x), Math.round(950 - point.y), 1, 1).data[3])
    };
  }, encoded);
  expect(result.contourCount).toBe(3);
  expect(result.holesInsideOuter).toBe(true);
  expect(result.holeAlphas).toEqual([0, 0]);
});

test('overlapping brush strokes merge into one compound outline and one TTF contour', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Ж', exact: true}).click();
  const svg = page.locator('#drawSvg');
  await drawClosedContour(page, [[90,90],[270,270]]);
  await drawClosedContour(page, [[90,270],[270,90]]);
  const fill = svg.locator('.glyph-fill');
  await expect(fill).toHaveCount(1);
  const pathData = await fill.getAttribute('d');
  expect((pathData.match(/M/g) || []).length).toBe(1);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadBtn').click();
  const download = await downloadPromise;
  const fontBytes = await readFile(await download.path());
  const encoded = fontBytes.toString('base64');
  const contourCount = await page.evaluate(base64 => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    return window.opentype.parse(bytes.buffer).charToGlyph('Ж').path.commands
      .filter(command => command.type === 'M').length;
  }, encoded);
  expect(contourCount).toBe(1);
});

test('contour editor rejects a hole outside the actual outer polygon but inside its bounding box', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'В', exact: true}).click();
  await page.locator('#brushSize').evaluate(element => {
    element.value = '36';
    element.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await drawClosedContour(page, [[80,80],[280,280]]);
  await page.locator('#brushSize').evaluate(element => {
    element.value = '8';
    element.dispatchEvent(new Event('input', {bubbles: true}));
  });
  // This short stroke is inside the outer contour's bounding box, but well
  // outside the actual diagonal capsule polygon.
  await drawClosedContour(page, [[80,280],[92,280]]);
  await page.locator('#contourModeBtn').click();
  const outsideContour = page.locator('path[data-contour-index="1"]');
  await expect(outsideContour).toBeVisible();
  await clickContourPath(page, outsideContour);
  const roleSelect = page.locator('#contourRoleSelect');
  await roleSelect.selectOption('hole');
  await page.locator('#applyContourRoleBtn').click();
  await expect(page.locator('#contourStatus')).toContainText('Контур уровня 1 должен целиком находиться внутри области уровня 0');
  await expect(roleSelect).toHaveValue('outer');
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


test('batches dense live pointer input into one preview render per animation frame', async ({ page }) => {
  await page.goto('/');
  const svg = page.locator('#drawSvg');
  const bounds = await svg.boundingBox();
  if (!bounds) throw new Error('Drawing SVG has no visible bounds');
  await page.evaluate(() => {
    window.__glyphFlowPointerId = null;
    document.querySelector('#drawSvg').addEventListener('pointerdown', event => {
      window.__glyphFlowPointerId = event.pointerId;
    }, {once: true});
  });
  await page.mouse.move(bounds.x + 45, bounds.y + 275);
  await page.mouse.down();
  const mutationCount = await page.evaluate(async ({left, top}) => {
    const target = document.querySelector('#drawSvg');
    const pointerId = window.__glyphFlowPointerId;
    if (pointerId === null) throw new Error('Could not capture active pointer ID');
    let mutations = 0;
    const observer = new MutationObserver(records => { mutations += records.length; });
    observer.observe(target, {childList: true});
    for (let index = 0; index < 400; index++) {
      const progress = index / 399;
      target.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerId,
        pointerType: 'mouse',
        buttons: 1,
        clientX: left + 45 + progress * 230,
        clientY: top + 275 - Math.sin(progress * Math.PI * 6) * 90
      }));
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    observer.disconnect();
    return mutations;
  }, {left: bounds.x, top: bounds.y});
  await page.mouse.up();
  await expect(svg.locator('path')).toHaveCount(1);
  expect(mutationCount, '400 synchronous pointermove events should be coalesced into one preview frame').toBeLessThanOrEqual(4);
  await expect(page.locator('#progressText')).toContainText('1 /');
});

test('cancels a pending animation-frame preview without leaving a ghost stroke', async ({ page }) => {
  await page.goto('/');
  const svg = page.locator('#drawSvg');
  const bounds = await svg.boundingBox();
  if (!bounds) throw new Error('Drawing SVG has no visible bounds');
  await page.evaluate(() => {
    window.__glyphFlowPointerId = null;
    document.querySelector('#drawSvg').addEventListener('pointerdown', event => {
      window.__glyphFlowPointerId = event.pointerId;
    }, {once: true});
  });
  await page.mouse.move(bounds.x + 45, bounds.y + 275);
  await page.mouse.down();
  await page.evaluate(({left, top}) => {
    const target = document.querySelector('#drawSvg');
    const pointerId = window.__glyphFlowPointerId;
    target.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId, pointerType: 'mouse', buttons: 1,
      clientX: left + 160, clientY: top + 140
    }));
    // Cancel in the same task, before the scheduled animation frame can run.
    target.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true, pointerId, pointerType: 'mouse', buttons: 0
    }));
  }, {left: bounds.x, top: bounds.y});
  await page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));
  await page.mouse.up();
  await expect(svg.locator('path')).toHaveCount(0);
  await expect(page.locator('#progressText')).toContainText('0 /');
  const storedCount = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('glyphflow-local', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readonly');
      const get = tx.objectStore('projects').get('current');
      get.onsuccess = () => resolve(get.result?.glyphData?.['А']?.length || 0);
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => db.close();
    };
  }));
  expect(storedCount).toBe(0);
});

test('bounds undo memory and Blob URLs during repeated edit/export stress', async ({ page }) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    const active = new Set();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      const url = create(blob);
      active.add(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      active.delete(url);
      return revoke(url);
    };
    Object.defineProperty(window, '__glyphFlowActiveBlobUrls', {
      get: () => active.size
    });
  });
  await page.goto('/');
  for (let index = 0; index < 42; index++) {
    await drawStroke(page, index * 4);
    const active = await page.evaluate(() => window.__glyphFlowActiveBlobUrls);
    expect(active, 'superseded live-font URLs should be revoked after every edit').toBeLessThanOrEqual(1);
  }

  const readStrokeCount = async () => page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('glyphflow-local', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readonly');
      const get = tx.objectStore('projects').get('current');
      get.onsuccess = () => resolve(get.result?.glyphData?.['А']?.length || 0);
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => db.close();
    };
  }));
  await expect.poll(readStrokeCount, {timeout: 15000}).toBe(42);

  // The undo stack retains the newest 40 full-project snapshots (39 undo steps).
  // Older snapshots must be discarded rather than growing memory indefinitely.
  for (let index = 0; index < 41; index++) await page.locator('#undoBtn').click();
  await expect.poll(readStrokeCount, {timeout: 15000}).toBe(3);
  await page.locator('#redoBtn').click();
  await expect.poll(readStrokeCount, {timeout: 15000}).toBe(4);

  for (let index = 0; index < 2; index++) {
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#downloadBtn').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.ttf$/i);
  }
  await page.waitForTimeout(1700);
  const activeAfterDownloads = await page.evaluate(() => window.__glyphFlowActiveBlobUrls);
  expect(activeAfterDownloads, 'temporary export URLs should be revoked after download').toBeLessThanOrEqual(1);

  await page.reload();
  await expect.poll(readStrokeCount).toBe(4);
  await expect(page.locator('#drawSvg path.glyph-fill')).toHaveCount(1);
});

test('migrates legacy hole roles and clamps unsupported stored contour depths', async ({ page }) => {
  await page.goto('/');
  await drawStroke(page);
  await expect.poll(() => page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('glyphflow-local', 1);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction('projects', 'readonly').objectStore('projects').get('current');
      get.onsuccess = () => { resolve(Boolean(get.result?.glyphData?.['А']?.length)); db.close(); };
    };
  }))).toBe(true);

  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('glyphflow-local', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readwrite');
      const store = tx.objectStore('projects');
      const get = store.get('current');
      get.onsuccess = () => {
        const draft = get.result;
        const legacyHole = {...draft.glyphData['А'][0], role: 'hole'};
        delete legacyHole.depth;
        const unsupportedDepth = {...draft.glyphData['А'][0], role: 'outer', depth: 99};
        draft.glyphData['А'] = [legacyHole];
        draft.glyphData['Б'] = [unsupportedDepth];
        store.put(draft, 'current');
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    };
  }));

  await page.reload();
  await page.locator('#contourModeBtn').click();
  await clickContourPath(page, page.locator('#drawSvg path[data-contour-index="0"]'));
  await expect(page.locator('#contourRoleSelect')).toHaveValue('hole');

  await page.locator('#glyphGrid button').filter({hasText: /^Б$/}).click();
  await clickContourPath(page, page.locator('#drawSvg path[data-contour-index="0"]'));
  await expect(page.locator('#contourRoleSelect')).toHaveValue('outer');
});

test('exports four nested contour levels with alternating transparent counters', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Р', exact: true}).click();
  const sizes = [36, 22, 14, 8];
  const spans = [[55, 305], [100, 260], [135, 225], [155, 205]];
  for (let i = 0; i < sizes.length; i++) {
    await page.locator('#brushSize').evaluate((element, value) => {
      element.value = String(value);
      element.dispatchEvent(new Event('input', {bubbles: true}));
    }, sizes[i]);
    await drawClosedContour(page, [[spans[i][0], 180], [spans[i][1], 180]]);
  }

  await page.locator('#contourModeBtn').click();
  const assignments = [
    [1, 'hole'],
    [2, 'island'],
    [3, 'nested-hole']
  ];
  for (const [index, level] of assignments) {
    const contour = page.locator(`#drawSvg path[data-contour-index="${index}"]`);
    await clickContourPath(page, contour);
    const selector = page.locator('#contourRoleSelect');
    await expect(selector).toBeEnabled();
    await selector.selectOption(level);
    await page.locator('#applyContourRoleBtn').click();
    await expect(selector).toHaveValue(level);
  }
  await expect(page.locator('#contourStatus')).toContainText('Уровень 3');

  // Undo/Redo must restore the selected contour's actual nesting depth, not
  // merely its rendered outline.
  await page.locator('#undoBtn').click();
  await clickContourPath(page, page.locator('#drawSvg path[data-contour-index="3"]'));
  await expect(page.locator('#contourRoleSelect')).toHaveValue('outer');
  await page.locator('#redoBtn').click();
  await clickContourPath(page, page.locator('#drawSvg path[data-contour-index="3"]'));
  await expect(page.locator('#contourRoleSelect')).toHaveValue('nested-hole');

  // Wait until IndexedDB contains all four explicit depth values.
  const readPersistedDepths = async () => page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('glyphflow-local', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readonly');
      const get = tx.objectStore('projects').get('current');
      get.onsuccess = () => {
        const strokes = get.result?.glyphData?.['Р'] || [];
        resolve(strokes.map(stroke => Number.isInteger(stroke.depth) ? stroke.depth : 0));
      };
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => db.close();
    };
  }));
  await expect.poll(readPersistedDepths).toEqual([0, 1, 2, 3]);

  // Reload must preserve the depth metadata as well as the visible geometry.
  await page.reload();
  await expect(page.locator('#currentCharLabel')).toHaveText('А');
  await page.locator('#glyphGrid button').filter({hasText: /^Р$/}).click();
  await expect(page.locator('#drawSvg path.glyph-fill')).toHaveCount(1);
  await page.locator('#contourModeBtn').click();
  for (const [index, level] of [[0, 'outer'], [1, 'hole'], [2, 'island'], [3, 'nested-hole']]) {
    await clickContourPath(page, page.locator(`#drawSvg path[data-contour-index="${index}"]`));
    await expect(page.locator('#contourRoleSelect')).toHaveValue(level);
  }

  // Switching to another glyph and back must not lose or cross-assign depths.
  await page.locator('#glyphGrid button').filter({hasText: /^Б$/}).click();
  await expect(page.locator('#currentCharLabel')).toHaveText('Б');
  await page.locator('#glyphGrid button').filter({hasText: /^Р$/}).click();
  for (const [index, level] of [[0, 'outer'], [1, 'hole'], [2, 'island'], [3, 'nested-hole']]) {
    await clickContourPath(page, page.locator(`#drawSvg path[data-contour-index="${index}"]`));
    await expect(page.locator('#contourRoleSelect')).toHaveValue(level);
  }

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadBtn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.ttf$/i);
  const bytes = await readFile(await download.path());
  expect(bytes.subarray(0, 4).toString('hex')).toBe('00010000');
  const result = await page.evaluate(async base64 => {
    const buffer = Uint8Array.from(atob(base64), character => character.charCodeAt(0)).buffer;
    const glyph = window.opentype.parse(buffer).charToGlyph('Р');
    const contours = [];
    let active = [];
    for (const command of glyph.path.commands) {
      if (command.type === 'M') {
        if (active.length) contours.push(active);
        active = [{x: command.x, y: command.y}];
      } else if (command.type === 'Z') {
        if (active.length) contours.push(active);
        active = [];
      } else if (Number.isFinite(command.x) && Number.isFinite(command.y)) {
        active.push({x: command.x, y: command.y});
      }
    }
    if (active.length) contours.push(active);
    const inside = (point, polygon) => {
      let result = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i], b = polygon[j];
        if ((a.y > point.y) !== (b.y > point.y) &&
          point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
      }
      return result;
    };
    const bounds = contours.flat().reduce((box, point) => ({
      minX: Math.min(box.minX, point.x), minY: Math.min(box.minY, point.y),
      maxX: Math.max(box.maxX, point.x), maxY: Math.max(box.maxY, point.y)
    }), {minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity});
    const distanceToSegment = (point, a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared ? Math.max(0, Math.min(1,
        ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
      return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
    };
    const clearanceFromAllContours = point => Math.min(...contours.flatMap(contour =>
      contour.map((a, index) => distanceToSegment(point, a, contour[(index + 1) % contour.length]))
    ));
    const samples = [1, 2, 3, 4].map(targetDepth => {
      let best = null;
      let bestClearance = -1;
      for (let yi = 1; yi < 200; yi++) {
        for (let xi = 1; xi < 200; xi++) {
          const point = {
            x: bounds.minX + (bounds.maxX - bounds.minX) * xi / 200,
            y: bounds.minY + (bounds.maxY - bounds.minY) * yi / 200
          };
          const depth = contours.reduce((count, contour) => count + (inside(point, contour) ? 1 : 0), 0);
          if (depth !== targetDepth) continue;
          const clearance = clearanceFromAllContours(point);
          if (clearance > bestClearance) { best = point; bestClearance = clearance; }
        }
      }
      if (!best) throw new Error('Could not find an interior sample at nesting depth ' + targetDepth);
      return best;
    });
    const face = new FontFace('GlyphFlowNestedDepthCheck', buffer);
    await face.load();
    document.fonts.add(face);
    const canvas = document.createElement('canvas');
    canvas.width = 1400;
    canvas.height = 1200;
    const context = canvas.getContext('2d');
    context.font = '1000px GlyphFlowNestedDepthCheck';
    context.fillStyle = '#000';
    context.fillText('Р', 0, 950);
    const alpha = samples.map(point => context.getImageData(
      Math.round(point.x), Math.round(950 - point.y), 1, 1
    ).data[3]);
    return {contourCount: contours.length, alpha, samples};
  }, bytes.toString('base64'));

  expect(result.contourCount, JSON.stringify(result)).toBe(4);
  expect(result.alpha[0], JSON.stringify(result)).toBeGreaterThan(0);
  expect(result.alpha[1], JSON.stringify(result)).toBe(0);
  expect(result.alpha[2], JSON.stringify(result)).toBeGreaterThan(0);
  expect(result.alpha[3], JSON.stringify(result)).toBe(0);
});


test('edits a selected stroke centerline through draggable nodes with undo support', async ({ page }) => {
  await page.goto('/');
  await drawStroke(page);
  await page.locator('#nodeEditModeBtn').click();
  await expect(page.locator('#nodeEditModeBtn')).toHaveAttribute('aria-pressed', 'true');
  await clickContourPath(page, page.locator('#drawSvg path[data-contour-index="0"]'));
  const nodes = page.locator('#drawSvg [data-node-index]');
  expect(await nodes.count()).toBeGreaterThan(5);
  const firstNode = nodes.first();
  const before = await firstNode.evaluate(element => ({
    x: Number(element.getAttribute('cx')),
    y: Number(element.getAttribute('cy'))
  }));
  const bounds = await firstNode.boundingBox();
  if (!bounds) throw new Error('Selected trajectory node is not visible');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 18, bounds.y + 14, {steps: 4});
  await page.mouse.up();
  const after = await page.locator('#drawSvg [data-node-index="0"]').evaluate(element => ({
    x: Number(element.getAttribute('cx')),
    y: Number(element.getAttribute('cy'))
  }));
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(5);
  await page.locator('#undoBtn').click();
  await page.locator('#nodeEditModeBtn').click();
  await page.locator('#nodeEditModeBtn').click();
  await clickContourPath(page, page.locator('#drawSvg path[data-contour-index="0"]'));
  const restored = await page.locator('#drawSvg [data-node-index="0"]').evaluate(element => ({
    x: Number(element.getAttribute('cx')),
    y: Number(element.getAttribute('cy'))
  }));
  expect(restored.x).toBeCloseTo(before.x, 1);
  expect(restored.y).toBeCloseTo(before.y, 1);
});


test('adds and removes trajectory points with undo and redo', async ({ page }) => {
  await page.goto('/');
  await drawStroke(page);
  await page.locator('#nodeEditModeBtn').click();
  await clickContourPath(page, page.locator('#drawSvg path[data-contour-index="0"]'));
  const initial = await page.locator('#drawSvg [data-node-index]').count();
  await page.locator('#drawSvg [data-node-index]').first().click();
  await page.locator('#addTrajectoryPointBtn').click();
  await expect(page.locator('#drawSvg [data-node-index]')).toHaveCount(initial + 1);
  await page.locator('#deleteTrajectoryPointBtn').click();
  await expect(page.locator('#drawSvg [data-node-index]')).toHaveCount(initial);
  await page.locator('#undoBtn').click();
  await clickContourPath(page, page.locator('#drawSvg path[data-contour-index="0"]'));
  await expect(page.locator('#drawSvg [data-node-index]')).toHaveCount(initial + 1);
  await page.locator('#redoBtn').click();
  await clickContourPath(page, page.locator('#drawSvg path[data-contour-index="0"]'));
  await expect(page.locator('#drawSvg [data-node-index]')).toHaveCount(initial);
});


test('edits actual vector outline vertices with validation, undo, redo and draft persistence', async ({ page }) => {
  await page.goto('/');
  await drawStroke(page);
  await page.locator('#outlineEditModeBtn').click();
  await expect(page.locator('#outlineEditModeBtn')).toHaveAttribute('aria-pressed', 'true');
  await clickContourPath(page, page.locator('#drawSvg path[data-contour-index="0"]'));
  const handles = page.locator('#drawSvg [data-outline-index]');
  expect(await handles.count()).toBeGreaterThan(5);
  const handle = handles.nth(Math.floor((await handles.count()) / 2));
  const selectedPointIndex = await handle.getAttribute('data-outline-index');
  const before = await handle.evaluate(element => ({
    x: Number(element.getAttribute('cx')),
    y: Number(element.getAttribute('cy'))
  }));
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error('Vector outline handle is not visible');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 12, bounds.y + bounds.height / 2 + 10, {steps: 6});
  await page.mouse.up();
  const changed = await page.locator(`#drawSvg [data-outline-index="${selectedPointIndex}"]`).evaluate(element => ({
    x: Number(element.getAttribute('cx')),
    y: Number(element.getAttribute('cy'))
  }));
  console.log('outline handle after drag', {changed, before, matches: await page.locator(`#drawSvg [data-outline-index="${selectedPointIndex}"]`).count()});
  expect(Math.hypot(changed.x - before.x, changed.y - before.y)).toBeGreaterThan(0.5);

  await page.locator('#undoBtn').click();
  await clickContourPath(page, page.locator('#drawSvg path[data-contour-index="0"]'));
  const undone = await page.locator(`#drawSvg [data-outline-index="${selectedPointIndex}"]`).evaluate(element => ({
    x: Number(element.getAttribute('cx')),
    y: Number(element.getAttribute('cy'))
  }));
  expect(undone.x).toBeCloseTo(before.x, 1);
  expect(undone.y).toBeCloseTo(before.y, 1);

  await page.locator('#redoBtn').click();
  await clickContourPath(page, page.locator('#drawSvg path[data-contour-index="0"]'));
  await page.waitForTimeout(400);
  const redone = await page.locator(`#drawSvg [data-outline-index="${selectedPointIndex}"]`).evaluate(element => ({
    x: Number(element.getAttribute('cx')),
    y: Number(element.getAttribute('cy'))
  }));
  expect(Math.hypot(redone.x - before.x, redone.y - before.y)).toBeGreaterThan(2);

  await page.reload();
  await page.locator('#outlineEditModeBtn').click();
  await clickContourPath(page, page.locator('#drawSvg path[data-contour-index="0"]'));
  const restored = await page.locator(`#drawSvg [data-outline-index="${selectedPointIndex}"]`).evaluate(element => ({
    x: Number(element.getAttribute('cx')),
    y: Number(element.getAttribute('cy'))
  }));
  expect(restored.x).toBeCloseTo(redone.x, 1);
  expect(restored.y).toBeCloseTo(redone.y, 1);
});


test('keeps editor lifecycle bounded across repeated glyph switches, history and draft restores', async ({ page }) => {
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    window.__glyphFlowBlobStats = {created: 0, revoked: 0, active: new Set()};
    URL.createObjectURL = value => {
      const url = create(value);
      window.__glyphFlowBlobStats.created++;
      window.__glyphFlowBlobStats.active.add(url);
      return url;
    };
    URL.revokeObjectURL = url => {
      if (window.__glyphFlowBlobStats.active.delete(url)) window.__glyphFlowBlobStats.revoked++;
      return revoke(url);
    };
  });
  await page.goto('/');
  const glyphButtons = page.locator('#glyphGrid button');
  for (let index = 0; index < 12; index++) {
    if (index > 0) await glyphButtons.nth(index).click();
    await drawStroke(page);
    await page.locator('#undoBtn').click();
    await page.locator('#redoBtn').click();
    const svgNodes = await page.locator('#drawSvg').evaluate(svg => svg.childElementCount);
    expect(svgNodes).toBeLessThan(5);
    const blobStats = await page.evaluate(() => ({
      created: window.__glyphFlowBlobStats.created,
      revoked: window.__glyphFlowBlobStats.revoked,
      active: window.__glyphFlowBlobStats.active.size
    }));
    expect(blobStats.active).toBeLessThanOrEqual(1);
    expect(blobStats.created - blobStats.revoked).toBeLessThanOrEqual(1);
  }
  await page.waitForTimeout(150);
  await page.reload();
  await expect(page.locator('#progressText')).toContainText('Готово: 12');
  const restoredNodes = await page.locator('#drawSvg').evaluate(svg => svg.childElementCount);
  expect(restoredNodes).toBeLessThan(5);
});


test('exposes an installable PWA manifest and caches the application shell', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once: true}));
    }
  });
  await page.reload();
  const pwa = await page.evaluate(async () => {
    const manifestUrl = document.querySelector('link[rel="manifest"]')?.href;
    const manifestResponse = await fetch(manifestUrl);
    const manifest = await manifestResponse.json();
    const registration = await navigator.serviceWorker.ready;
    const cache = await caches.open('glyphflow-shell-v2');
    const cachedUrls = await cache.keys();
    return {
      manifestUrl,
      manifestOk: manifestResponse.ok,
      name: manifest.name,
      display: manifest.display,
      scope: manifest.scope,
      icon: manifest.icons?.[0],
      workerActive: Boolean(registration.active),
      cachedUrls: cachedUrls.map(request => new URL(request.url).pathname)
    };
  });
  expect(pwa.manifestOk).toBe(true);
  expect(pwa.name).toContain('GlyphFlow');
  expect(pwa.display).toBe('standalone');
  expect(pwa.scope).toBe('./');
  expect(pwa.icon?.type).toBe('image/svg+xml');
  expect(pwa.icon?.purpose).toContain('maskable');
  expect(pwa.workerActive).toBe(true);
  expect(pwa.cachedUrls.some(url => url.endsWith('/index.html') || url.endsWith('/'))).toBe(true);
  expect(pwa.cachedUrls.some(url => url.endsWith('/manifest.webmanifest'))).toBe(true);
  expect(pwa.cachedUrls.some(url => url.endsWith('/icons/glyphflow.svg'))).toBe(true);
  expect(pwa.cachedUrls.some(url => /\/assets\/.*\.js$/.test(url))).toBe(true);
  expect(pwa.cachedUrls.some(url => /\/assets\/.*\.css$/.test(url))).toBe(true);
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
  const pageOrigin = await page.evaluate(() => location.origin);
  expect(resources.filter(url => new URL(url).origin !== pageOrigin)).toEqual([]);
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.locator('#drawSvg')).toBeVisible();
  await drawStroke(page);
  await expect(page.locator('#progressText')).toContainText('Готово: 1');
  await page.context().setOffline(false);
});



test('shows a readable status when service worker registration fails', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: () => Promise.reject(new Error('Simulated service worker registration failure'))
      }
    });
  });
  await page.goto('/');
  await expect(page.locator('#pwaStatus')).toContainText('Офлайн-режим недоступен');
  await expect(page.locator('#pwaStatus')).toContainText('браузер не смог включить');
});

test('activating a replacement service worker removes stale GlyphFlow caches', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    await caches.open('glyphflow-shell-stale-test');
    const registration = await navigator.serviceWorker.register('./sw.js?lifecycle-test=1');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Replacement service worker did not activate')), 10000);
      const check = () => {
        if (registration.active?.state === 'activated' &&
            new URL(registration.active.scriptURL).searchParams.get('lifecycle-test') === '1') {
          clearTimeout(timeout);
          resolve();
        }
      };
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', check);
      });
      registration.addEventListener('controllerchange', check);
      check();
    });
  });
  const cacheNames = await page.evaluate(() => caches.keys());
  expect(cacheNames).toContain('glyphflow-shell-v2');
  expect(cacheNames).not.toContain('glyphflow-shell-stale-test');
});

test('replacement service worker controls already-open tabs and preserves offline access', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once:true}));
    }
  });

  const secondPage = await context.newPage();
  await secondPage.goto('/');
  await secondPage.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once:true}));
    }
  });

  await page.evaluate(async () => {
    await navigator.serviceWorker.register('./sw.js?multi-tab-update-test=1');
  });

  await page.waitForFunction(() => {
    const script = navigator.serviceWorker.controller?.scriptURL || '';
    return new URL(script).searchParams.get('multi-tab-update-test') === '1';
  }, null, {timeout:15000});
  await secondPage.waitForFunction(() => {
    const script = navigator.serviceWorker.controller?.scriptURL || '';
    return new URL(script).searchParams.get('multi-tab-update-test') === '1';
  }, null, {timeout:15000});

  await context.setOffline(true);
  await page.reload();
  await secondPage.reload();
  await expect(page.locator('#drawSvg')).toBeVisible();
  await expect(secondPage.locator('#drawSvg')).toBeVisible();
  await drawStroke(page);
  await expect(page.locator('#progressText')).toContainText('Готово: 1');
  await context.setOffline(false);
  await secondPage.close();
});

test('edits final Boolean compound rings with undo, redo, draft persistence and TTF export', async ({page}) => {
  await page.goto('/');
  await page.locator('#brushSize').evaluate(element => {
    element.value = '36';
    element.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await drawClosedContour(page, [[70, 180], [205, 180]]);
  await drawClosedContour(page, [[155, 180], [290, 180]]);
  await expect(page.locator('#drawSvg path.glyph-fill')).toHaveCount(1);

  await page.locator('#compoundEditModeBtn').click();
  const outerRing = page.locator('#drawSvg [data-compound-polygon-index="0"][data-compound-ring-index="0"]');
  await expect(outerRing).toBeVisible();
  await outerRing.click();
  const handles = page.locator('#drawSvg [data-compound-point-index]');
  expect(await handles.count()).toBeGreaterThan(3);
  const handle = page.locator('#drawSvg [data-compound-point-index="0"]');
  const beforePath = await page.locator('#drawSvg .glyph-fill').getAttribute('d');
  const bounds = await handle.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 7, bounds.y + bounds.height / 2 + 5);
  await page.mouse.up();
  console.log('compound editor drag state', await page.locator('#drawSvg').evaluate(element => ({...element.dataset})));

  const afterPath = await page.locator('#drawSvg .glyph-fill').getAttribute('d');
  expect(afterPath).not.toBe(beforePath);
  const readOverride = async () => page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('glyphflow-local', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readonly');
      const get = tx.objectStore('projects').get('current');
      get.onsuccess = () => resolve(get.result?.compoundOverrides?.['А'] || null);
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => db.close();
    };
  }));
  await expect.poll(readOverride).not.toBeNull();

  await page.locator('#undoBtn').click();
  await expect.poll(readOverride).toBeNull();
  await page.locator('#redoBtn').click();
  await expect.poll(readOverride).not.toBeNull();

  await page.reload();
  await expect(page.locator('#drawSvg path.glyph-fill')).toHaveCount(1);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadBtn').click();
  const download = await downloadPromise;
  const fontBytes = await readFile(await download.path());
  const encoded = fontBytes.toString('base64');
  const exported = await page.evaluate(base64 => {
    const buffer = Uint8Array.from(atob(base64), character => character.charCodeAt(0)).buffer;
    const glyph = window.opentype.parse(buffer).charToGlyph('А');
    return {
      contourCount: glyph.path.commands.filter(command => command.type === 'M').length,
      commandCount: glyph.path.commands.length
    };
  }, encoded);
  expect(exported.contourCount).toBeGreaterThan(0);
  expect(exported.commandCount).toBeGreaterThan(5);
});


test('closes a late IndexedDB connection after an open request was blocked', async ({ page }) => {
  await page.goto('/');
  await drawStroke(page);
  await page.evaluate(() => {
    const factory = Object.getPrototypeOf(indexedDB);
    factory.open = function () {
      const request = {};
      const lateDatabase = {
        close() { window.__lateBlockedDatabaseClosed = true; }
      };
      setTimeout(() => request.onblocked?.(), 0);
      setTimeout(() => {
        request.result = lateDatabase;
        request.onsuccess?.();
      }, 30);
      return request;
    };
    window.__lateBlockedDatabaseClosed = false;
  });

  await page.locator('#saveToLibraryBtn').click();
  await expect(page.locator('#fontLibraryStatus')).toContainText('заблокировано другой вкладкой');
  await page.waitForFunction(() => window.__lateBlockedDatabaseClosed === true);
});

test('saves generated fonts and editable projects in the local font library', async ({ page }) => {
  await page.goto('/');
  await drawStroke(page);
  await page.locator('#fontName').fill('GlyphFlow Library Test');
  await page.locator('#saveToLibraryBtn').click();
  const card = page.locator('#fontLibraryList article').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('GlyphFlow Library Test');
  await expect(card).toContainText('проект можно продолжить редактировать');
  await expect(page.locator('#fontLibraryCount')).toHaveText('1');

  await page.reload();
  await expect(page.locator('#fontLibraryCount')).toHaveText('1');
  const restoredCard = page.locator('#fontLibraryList article').first();
  await expect(restoredCard).toContainText('GlyphFlow Library Test');

  // The library entry contains a restorable project as well as its TTF binary.
  page.once('dialog', dialog => dialog.accept());
  await restoredCard.getByRole('button', {name:'Открыть проект'}).click();
  await expect(page.locator('#fontName')).toHaveValue('GlyphFlow Library Test');
  await expect(page.locator('#drawSvg .glyph-fill')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await restoredCard.getByRole('button', {name:'Скачать'}).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.ttf$/i);
  const filePath = await download.path();
  expect((await readFile(filePath)).subarray(0,4).toString('hex')).toBe('00010000');
});

test('imports a valid font file into the local font library and supports removal', async ({ page }) => {
  await page.goto('/');
  await drawStroke(page);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadBtn').click();
  const download = await downloadPromise;
  const filePath = await download.path();
  const bytes = await readFile(filePath);
  await page.locator('#importFontInput').setInputFiles({
    name:'Imported-GlyphFlow.ttf',
    mimeType:'font/ttf',
    buffer:bytes
  });
  await expect(page.locator('#fontLibraryCount')).toHaveText('1');
  const card = page.locator('#fontLibraryList article').first();
  await expect(card).toContainText('TTF');
  await expect(card).toContainText('импортированный файл');
  page.once('dialog', dialog => dialog.accept());
  await card.getByRole('button',{name:'Удалить'}).click();
  await expect(page.locator('#fontLibraryCount')).toHaveText('0');
});



test('removing one library font preserves other records after reload', async ({ page }) => {
  await page.goto('/');
  await drawStroke(page);

  await page.locator('#fontName').fill('Library Keep A');
  await page.locator('#saveToLibraryBtn').click();
  await expect(page.locator('#fontLibraryCount')).toHaveText('1');

  await page.locator('#fontName').fill('Library Keep B');
  await page.locator('#saveToLibraryBtn').click();
  await expect(page.locator('#fontLibraryCount')).toHaveText('2');

  const firstCard = page.locator('#fontLibraryList article').filter({hasText:'Library Keep A'});
  const secondCard = page.locator('#fontLibraryList article').filter({hasText:'Library Keep B'});
  await expect(firstCard).toHaveCount(1);
  await expect(secondCard).toHaveCount(1);

  page.once('dialog', dialog => dialog.accept());
  await firstCard.getByRole('button', {name:'Удалить'}).click();
  await expect(page.locator('#fontLibraryCount')).toHaveText('1');
  await expect(page.locator('#fontLibraryList article')).toContainText('Library Keep B');
  await expect(page.locator('#fontLibraryList article')).not.toContainText('Library Keep A');

  await page.reload();
  await expect(page.locator('#fontLibraryCount')).toHaveText('1');
  await expect(page.locator('#fontLibraryList article')).toContainText('Library Keep B');
  await expect(page.locator('#fontLibraryList article')).not.toContainText('Library Keep A');
});

test('shows a visible storage error when deleting a library font fails', async ({ page }) => {
  await page.goto('/');
  await drawStroke(page);
  await page.locator('#fontName').fill('Delete Failure Test');
  await page.locator('#saveToLibraryBtn').click();
  await expect(page.locator('#fontLibraryCount')).toHaveText('1');

  await page.evaluate(() => {
    IDBObjectStore.prototype.delete = function () {
      const transaction = this.transaction;
      Object.defineProperty(transaction, 'error', {
        configurable: true,
        get: () => new DOMException('Simulated storage failure', 'QuotaExceededError')
      });
      transaction.abort();
      return undefined;
    };
  });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#fontLibraryList article').getByRole('button', {name:'Удалить'}).click();
  await expect(page.locator('#fontLibraryStatus')).toContainText('Не удалось удалить шрифт');
  await expect(page.locator('#fontLibraryStatus')).toContainText('недостаточно места в хранилище устройства');
  await expect(page.locator('#fontLibraryCount')).toHaveText('1');
});

test('shows a readable error when the font library cannot be read', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    IDBObjectStore.prototype.openCursor = function () {
      throw new DOMException('Simulated storage access failure', 'SecurityError');
    };
  });
  await page.locator('#fontLibrarySearch').fill('trigger refresh');
  await expect(page.locator('#fontLibraryStatus')).toContainText('Не удалось открыть библиотеку');
  await expect(page.locator('#fontLibraryStatus')).toContainText('браузер запретил доступ к локальному хранилищу');
});

test('prevents exporting a font-library backup larger than the restore limit', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('glyphflow-local', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readwrite');
      const store = tx.objectStore('projects');
      for (let index = 0; index < 3; index++) {
        const id = 'oversized-export-' + index;
        store.put({
          id,
          name: 'Oversized export ' + index,
          format: 'ttf',
          fileName: id + '.ttf',
          blob: new Blob([new Uint8Array(12 * 1024 * 1024)]),
          size: 12 * 1024 * 1024,
          savedAt: Date.now(),
          projectSnapshot: null
        }, 'font-library:' + id);
      }
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload();
  await page.locator('#exportFontLibraryBtn').click();
  await expect(page.locator('#fontLibraryStatus')).toContainText('превысит лимит 40 МБ');
  await expect(page.locator('#fontLibraryCount')).toHaveText('3');
});

test('exports and restores a portable font-library backup', async ({ page }) => {
  await page.goto('/');
  await drawStroke(page);
  await page.locator('#fontName').fill('Portable Backup Test');
  await page.locator('#saveToLibraryBtn').click();
  await expect(page.locator('#fontLibraryCount')).toHaveText('1');

  const backupPromise = page.waitForEvent('download');
  await page.locator('#exportFontLibraryBtn').click();
  const backupDownload = await backupPromise;
  expect(backupDownload.suggestedFilename()).toContain('GlyphFlow-font-library-backup');
  const backupBytes = await readFile(await backupDownload.path());
  const backupData = JSON.parse(backupBytes.toString('utf8'));
  expect(backupData.format).toBe('GlyphFlowFontLibrary');
  expect(backupData.fonts).toHaveLength(1);
  expect(backupData.fonts[0].projectSnapshot).toContain('glyphData');
  expect(backupData.fonts[0].fontBase64.length).toBeGreaterThan(100);

  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('glyphflow-local', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').clear();
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload();
  await expect(page.locator('#fontLibraryCount')).toHaveText('0');
  await page.locator('#importLibraryBackupInput').setInputFiles({
    name: 'GlyphFlow-backup.json',
    mimeType: 'application/json',
    buffer: backupBytes
  });
  await expect(page.locator('#fontLibraryCount')).toHaveText('1');
  const card = page.locator('#fontLibraryList article').first();
  await expect(card).toContainText('Portable Backup Test');
  await expect(card).toContainText('проект можно продолжить редактировать');
  page.once('dialog', dialog => dialog.accept());
  await card.getByRole('button', {name:'Открыть проект'}).click();
  await expect(page.locator('#fontName')).toHaveValue('Portable Backup Test');
  await expect(page.locator('#drawSvg .glyph-fill')).toBeVisible();
});


test('restores a font-library backup atomically when a storage write fails', async ({ page }) => {
  await page.goto('/');
  await drawStroke(page);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadBtn').click();
  const download = await downloadPromise;
  const fontBytes = await readFile(await download.path());
  const fontBase64 = fontBytes.toString('base64');
  const backupBytes = Buffer.from(JSON.stringify({
    format: 'GlyphFlowFontLibrary',
    version: 1,
    fonts: [
      {name:'Atomic Restore A',format:'ttf',fileName:'atomic-a.ttf',fontBase64,projectSnapshot:null},
      {name:'Atomic Restore B',format:'ttf',fileName:'atomic-b.ttf',fontBase64,projectSnapshot:null}
    ]
  }));

  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    let libraryWrites = 0;
    IDBObjectStore.prototype.put = function (...args) {
      if (typeof args[1] === 'string' && args[1].startsWith('font-library:')) {
        libraryWrites++;
        if (libraryWrites === 2) throw new DOMException('Simulated storage write failure', 'QuotaExceededError');
      }
      return originalPut.apply(this, args);
    };
  });
  await page.locator('#importLibraryBackupInput').setInputFiles({
    name:'atomic-backup.json',
    mimeType:'application/json',
    buffer:backupBytes
  });
  await expect(page.locator('#fontLibraryStatus')).toContainText('Не удалось восстановить библиотеку');
  await expect(page.locator('#fontLibraryStatus')).toContainText('недостаточно места в хранилище устройства');
  await expect(page.locator('#fontLibraryCount')).toHaveText('0');
  await page.reload();
  await expect(page.locator('#fontLibraryCount')).toHaveText('0');
});


test('rolls back queued font-library backup writes when IndexedDB aborts the transaction', async ({ page }) => {
  await page.goto('/');
  await drawStroke(page);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadBtn').click();
  const download = await downloadPromise;
  const fontBytes = await readFile(await download.path());
  const fontBase64 = fontBytes.toString('base64');
  const backupBytes = Buffer.from(JSON.stringify({
    format: 'GlyphFlowFontLibrary',
    version: 1,
    fonts: [
      {name:'Abort Restore A',format:'ttf',fileName:'abort-a.ttf',fontBase64,projectSnapshot:null},
      {name:'Abort Restore B',format:'ttf',fileName:'abort-b.ttf',fontBase64,projectSnapshot:null}
    ]
  }));

  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    let libraryWrites = 0;
    IDBObjectStore.prototype.put = function (...args) {
      const isLibraryWrite = typeof args[1] === 'string' && args[1].startsWith('font-library:');
      const request = originalPut.apply(this, args);
      if (isLibraryWrite && ++libraryWrites === 2) {
        this.transaction.abort();
        window.__glyphflowTestAbortTriggered = true;
      }
      return request;
    };
  });
  await page.locator('#importLibraryBackupInput').setInputFiles({
    name:'aborted-backup.json',
    mimeType:'application/json',
    buffer:backupBytes
  });
  await page.waitForFunction(() => window.__glyphflowTestAbortTriggered === true);
  await expect(page.locator('#fontLibraryCount')).toHaveText('0');
  await page.reload();
  await expect(page.locator('#fontLibraryCount')).toHaveText('0');
});


test('rejects a malformed imported font file without adding it to the library', async ({ page }) => {
  await page.goto('/');
  await page.locator('#importFontInput').setInputFiles({
    name: 'broken-font.ttf',
    mimeType: 'font/ttf',
    buffer: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])
  });
  await expect(page.locator('#fontLibraryCount')).toHaveText('0');
  await expect(page.locator('#fontLibraryStatus')).toContainText('Не удалось импортировать');
});

test('rejects a malformed font binary in a library backup before writing any records', async ({ page }) => {
  await page.goto('/');
  const backup = {
    format: 'GlyphFlowFontLibrary',
    version: 1,
    fonts: [{
      id: 'broken-font',
      name: 'Broken font',
      format: 'ttf',
      fontBase64: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]).toString('base64'),
      projectSnapshot: null
    }]
  };
  await page.locator('#importLibraryBackupInput').setInputFiles({
    name: 'broken-font-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup))
  });
  await expect(page.locator('#fontLibraryCount')).toHaveText('0');
  await expect(page.locator('#fontLibraryStatus')).toContainText('Не удалось восстановить библиотеку');
});

test('rejects an oversized project snapshot in a library backup before parsing or writing', async ({ page }) => {
  await page.goto('/');
  const oversizedBackup = {
    format: 'GlyphFlowFontLibrary',
    version: 1,
    fonts: [{
      name: 'Oversized snapshot',
      format: 'ttf',
      fontBase64: 'AA==',
      projectSnapshot: ' '.repeat(25 * 1024 * 1024 + 1)
    }]
  };
  await page.locator('#importLibraryBackupInput').setInputFiles({
    name: 'oversized-project-snapshot.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(oversizedBackup))
  });
  await expect(page.locator('#fontLibraryCount')).toHaveText('0');
  await expect(page.locator('#fontLibraryStatus')).toContainText('Снимок проекта в резервной копии превышает безопасный лимит');
});

test('rejects an invalid project snapshot in a library backup before writing any records', async ({ page }) => {
  await page.goto('/');
  const maliciousBackup = {
    format: 'GlyphFlowFontLibrary',
    version: 1,
    fonts: [{
      id: 'malicious',
      name: 'Invalid project',
      format: 'ttf',
      fontBase64: 'AA==',
      projectSnapshot: JSON.stringify({
        version: 2,
        glyphData: {
          'А': [{
            points: Array.from({length: 10001}, (_, index) => [index, index]),
            size: 4,
            thinning: 0.5
          }]
        },
        compoundOverrides: {}
      })
    }]
  };
  await page.locator('#importLibraryBackupInput').setInputFiles({
    name: 'invalid-GlyphFlow-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(maliciousBackup))
  });
  await expect(page.locator('#fontLibraryCount')).toHaveText('0');
  await expect(page.locator('#fontLibraryStatus')).toContainText('слишком длинный штрих');
});

test('does not replace the active drawing when a saved library project is invalid', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('glyphflow-local', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put({
        id: 'invalid-saved-project',
        name: 'Повреждённый проект',
        format: 'ttf',
        fileName: 'invalid.ttf',
        blob: new Blob([new Uint8Array([0, 1, 2, 3])], {type:'font/ttf'}),
        size: 4,
        savedAt: Date.now(),
        projectSnapshot: JSON.stringify({
          version: 2,
          glyphData: {'А': [{points:[[0,0]],size:0,thinning:0.5}]},
          compoundOverrides: {}
        })
      }, 'font-library:invalid-saved-project');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload();
  await drawStroke(page);
  await expect(page.locator('#drawSvg .glyph-fill')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#fontLibraryList article').getByRole('button', {name:'Открыть проект'}).click();
  await expect(page.locator('#fontLibraryStatus')).toContainText('Проект не открыт');
  await expect(page.locator('#drawSvg .glyph-fill')).toBeVisible();
});


test('closes an existing IndexedDB connection so a schema upgrade can proceed', async ({ page }) => {
  await page.addInitScript(() => {
    const originalOpen = IDBFactory.prototype.open;
    const originalClose = IDBDatabase.prototype.close;
    window.__glyphflowUpgradeDb = null;
    window.__glyphflowAllowVersionClose = false;
    window.__glyphflowCloseObserved = false;
    IDBFactory.prototype.open = function (...args) {
      const request = originalOpen.apply(this, args);
      request.addEventListener('success', () => {
        if (request.result.name === 'glyphflow-local') {
          window.__glyphflowUpgradeDb = request.result;
        }
      });
      return request;
    };
    IDBDatabase.prototype.close = function (...args) {
      if (this === window.__glyphflowUpgradeDb && !window.__glyphflowAllowVersionClose) {
        window.__glyphflowCloseObserved = true;
        return;
      }
      return originalClose.apply(this, args);
    };
  });
  await page.goto('/');
  await page.waitForFunction(() => window.__glyphflowUpgradeDb !== null);
  await page.evaluate(() => {
    window.__glyphflowAllowVersionClose = true;
    const request = indexedDB.open('glyphflow-local', 2);
    request.onupgradeneeded = () => {
      window.__glyphflowUpgradeStarted = true;
    };
    request.onsuccess = () => {
      window.__glyphflowUpgradeSucceeded = true;
      request.result.close();
    };
    request.onerror = () => {
      window.__glyphflowUpgradeError = request.error?.message || 'unknown';
    };
  });
  await page.waitForFunction(() => window.__glyphflowUpgradeSucceeded === true);
  const result = await page.evaluate(() => ({
    closeObserved: window.__glyphflowCloseObserved,
    upgradeStarted: window.__glyphflowUpgradeStarted,
    error: window.__glyphflowUpgradeError || null
  }));
  expect(result.closeObserved).toBe(true);
  expect(result.upgradeStarted).toBe(true);
  expect(result.error).toBeNull();
});


test('shows a visible error when draft autosave runs out of storage space', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (args[1] === 'current') {
        const transaction = this.transaction;
        Object.defineProperty(transaction, 'error', {
          configurable: true,
          get: () => new DOMException('Simulated storage quota failure', 'QuotaExceededError')
        });
        transaction.abort();
        return undefined;
      }
      return originalPut.apply(this, args);
    };
  });
  await drawStroke(page);
  await expect(page.locator('#draftSyncStatus')).toContainText('Не удалось сохранить черновик');
  await expect(page.locator('#draftSyncStatus')).toContainText('недостаточно места в хранилище устройства');
});

test('reports a damaged saved draft and allows a fresh draft to be saved', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('glyphflow-local', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put({
        glyphData: {'А': [{points:[[0,0]],size:0,thinning:0.5}]},
        compoundOverrides: {},
        fontName: 'Damaged draft',
        savedAt: Date.now()
      }, 'current');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload();
  await expect(page.locator('#draftSyncStatus')).toContainText('Не удалось восстановить черновик');
  await expect(page.locator('#draftSyncStatus')).toContainText('недопустимые параметры кисти');
  await expect(page.locator('#drawSvg .glyph-fill')).toHaveCount(0);

  await drawStroke(page);
  await expect(page.locator('#drawSvg .glyph-fill')).toBeVisible();
  await expect(page.locator('#draftSyncStatus')).toBeHidden();
  await page.reload();
  await expect(page.locator('#drawSvg .glyph-fill')).toBeVisible();
  await expect(page.locator('#progressText')).toContainText('1 /');
});

test('keeps valid library fonts visible when another stored record is malformed', async ({ page }) => {
  await page.goto('/');
  await page.locator('#fontName').fill('Healthy Library Font');
  await page.locator('#saveToLibraryBtn').click();
  await expect(page.locator('#fontLibraryCount')).toHaveText('1');

  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('glyphflow-local', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put({name: 'Broken record without font data'}, 'font-library:broken-record');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));

  await page.reload();
  await expect(page.locator('#fontLibraryCount')).toHaveText('1');
  await expect(page.locator('#fontLibraryList article')).toHaveCount(1);
  await expect(page.locator('#fontLibraryList article')).toContainText('Healthy Library Font');
  await expect(page.locator('#fontLibraryStatus')).toContainText('Обнаружено повреждённых записей: 1');
  const brokenRecordPreserved = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('glyphflow-local', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readonly');
      const get = tx.objectStore('projects').get('font-library:broken-record');
      tx.oncomplete = () => { resolve(get.result?.name === 'Broken record without font data'); db.close(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  expect(brokenRecordPreserved).toBe(true);
});

test('reports a malformed draft envelope without deleting it or other library records', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('glyphflow-local', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readwrite');
      const store = tx.objectStore('projects');
      store.put({fontName: 'Broken envelope', savedAt: Date.now()}, 'current');
      store.put({
        id: 'preserved-record',
        name: 'Preserved font',
        fileName: 'preserved.ttf',
        format: 'ttf',
        blob: new Blob(['font-data'], {type: 'font/ttf'}),
        savedAt: Date.now()
      }, 'font-library:preserved-record');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));

  await page.reload();
  await expect(page.locator('#draftSyncStatus')).toContainText('Не удалось восстановить черновик');
  await expect(page.locator('#draftSyncStatus')).toContainText('неверную структуру');
  const stored = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('glyphflow-local', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readonly');
      const store = tx.objectStore('projects');
      const draftRequest = store.get('current');
      const libraryRequest = store.get('font-library:preserved-record');
      tx.oncomplete = () => {
        resolve({
          draftRetained: Boolean(draftRequest.result),
          libraryRecordRetained: libraryRequest.result?.name === 'Preserved font'
        });
        db.close();
      };
      tx.onerror = () => reject(tx.error);
    };
  }));
  expect(stored).toEqual({draftRetained: true, libraryRecordRetained: true});
});

test('recovers a stroke after an immediate page reload without an artificial wait', async ({ page }) => {
  await page.goto('/');
  await drawStroke(page);
  await page.reload();
  await expect(page.locator('#drawSvg path.glyph-fill')).toBeVisible();
  await expect(page.locator('#progressText')).toContainText('1 /');
});
