import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const moduleSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
assert.ok(html.includes('<script type="module" src="./src/main.js"></script>'), 'HTML must load the local Vite entry module');
assert.ok(!html.includes('https://cdn.') && !html.includes('https://esm.sh'), 'HTML must not load runtime dependencies from external CDNs');

const fontSmoke = readFileSync(new URL('../scripts/font-smoke-test.mjs', import.meta.url), 'utf8');
const browserTests = readFileSync(new URL('../tests/browser/editor.spec.mjs', import.meta.url), 'utf8');
const geometryPerformance = readFileSync(new URL('../scripts/geometry-performance.mjs', import.meta.url), 'utf8');
const sourceManifest = readFileSync(new URL('../manifest.webmanifest', import.meta.url), 'utf8');
const pwaManifest = JSON.parse(sourceManifest);
const serviceWorker = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const publicManifest = readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
const publicServiceWorker = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const publicIcon = readFileSync(new URL('../public/icons/glyphflow.svg', import.meta.url), 'utf8');
const sourceIcon = readFileSync(new URL('../icons/glyphflow.svg', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const nestedExportContracts = [
  ['font smoke fixture includes four nested depths', "'Ы': ["],
  ['font smoke fixture reaches depth three', "thinning: 0.35, depth: 3"],
  ['font smoke validates nested glyph cmap', "['A', 'Ё', '😀', 'О', 'Ж', 'Р', 'Ф', 'Ы', '∞']"],
  ['font smoke validates four exported contours', "charToGlyph('Ы').path.commands.filter(command => command.type === 'M').length, 4"],
  ['browser test exports nested counters', "exports four nested contour levels with alternating transparent counters"],
  ['browser test checks filled island pixels', 'expect(result.alpha[2], JSON.stringify(result)).toBeGreaterThan(0)'],
  ['browser test checks nested transparent counter', 'expect(result.alpha[3], JSON.stringify(result)).toBe(0)'],
  ['browser test verifies depth metadata in IndexedDB', 'const readPersistedDepths = async () => page.evaluate'],
  ['browser test verifies all four stored depth levels', 'toEqual([0, 1, 2, 3])'],
  ['browser test verifies undo of nested depth', "toHaveValue('outer')"],
  ['browser test verifies redo of nested depth', "toHaveValue('nested-hole')"],
  ['browser test verifies depth after reload', "await page.reload();"],
  ['browser test verifies depth after switching glyphs', "Switching to another glyph and back must not lose or cross-assign depths."],
  ['browser test covers legacy hole role migration', 'migrates legacy hole roles and clamps unsupported stored contour depths'],
  ['browser test covers invalid depth recovery', 'depth: 99'],
  ['browser test covers high-frequency pointer batching', 'batches dense live pointer input into one preview render per animation frame'],
  ['browser test sends dense pointer stream', 'index < 400'],
  ['browser test asserts bounded preview DOM updates', 'toBeLessThanOrEqual(4)']
];
for (const [label, token] of nestedExportContracts) {
  assert.ok(fontSmoke.includes(token) || browserTests.includes(token), `Missing nested TTF export test: ${label}`);
}

const performanceContracts = [
  ['dense trajectory fixture', 'single-dense-trajectory-512'],
  ['2k trajectory fixture', 'single-dense-trajectory-2000'],
  ['5k trajectory fixture', 'single-dense-trajectory-5000'],
  ['10k trajectory fixture', 'single-dense-trajectory-10000'],
  ['64-stroke fixture', '64-overlapping-strokes'],
  ['128-stroke fixture', '128-overlapping-strokes'],
  ['Boolean union stress fixture', '32-overlapping-strokes'],
  ['four-depth geometry fixture', 'four-depth-32-contours'],
  ['geometry cache reuse measurement', 'cacheHitMs'],
  ['generous CI stress budget', 'totalMs < 90000']
];
for (const [label, token] of performanceContracts) {
  assert.ok(geometryPerformance.includes(token), `Missing geometry performance contract: ${label}`);
}

const browserEnduranceContracts = [
  ['mobile viewport endurance test', 'repeated editing across narrow mobile viewport sizes'],
  ['mobile 320px viewport', '{width: 320, height: 640}'],
  ['mobile 412px viewport', '{width: 412, height: 915}'],
  ['long-session glyph isolation', "toEqual({A: 18, B: 6})"],
  ['long-session undo redo', "for (let index = 0; index < 4; index++) await page.locator('#undoBtn').click()"],
  ['node editor browser regression', "test('edits a selected stroke centerline through draggable nodes with undo support'"],
  ['trajectory point history', "test('adds and removes trajectory points with undo and redo'"],
  ['trajectory point insertion and deletion regression', "test('adds and removes trajectory points with undo and redo'"]
];
for (const [label, token] of browserEnduranceContracts) {
  assert.ok(browserTests.includes(token), `Missing browser endurance contract: ${label}`);
}


const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], {
  input: moduleSource,
  encoding: 'utf8'
});
assert.equal(syntax.status, 0, `Inline module syntax check failed:\n${syntax.stderr || syntax.stdout}`);

const requiredContracts = [
  ['primary pointer guard', 'if (e.button !== 0 || !e.isPrimary || isDrawing || panPointerId !== null) return;'],
  ['SVG coordinate transform', 'point.matrixTransform(drawSvg.getScreenCTM().inverse())'],
  ['bounded canvas zoom', 'const MIN_VIEW_SIZE = 120;'],
  ['canvas viewBox zoom control', "getElementById('zoomInBtn')"],
  ['typographic guides follow canvas zoom', 'guideSvg.setAttribute(\'viewBox\', nextViewBox);'],
  ['canvas directional pan controls', "getElementById('panLeftBtn')"],
  ['wheel zoom handler', "addEventListener('wheel'"],
  ['mouse pan gesture', 'panStart = {clientX: e.clientX, clientY: e.clientY, x: viewBox.x, y: viewBox.y};'],
  ['active pointer filtering', 'e.pointerId !== activePointerId'],
  ['pointer cancellation', "addEventListener('pointercancel'"],
  ['animation-frame stroke preview batching', 'function scheduleStrokePreviewRender()'],
  ['bounded undo snapshot count', 'const MAX_HISTORY_ENTRIES = 40;'],
  ['bounded undo snapshot memory', 'const MAX_HISTORY_BYTES = 8 * 1024 * 1024;'],
  ['download Blob URL revocation uses the captured local URL', 'window.setTimeout(() => URL.revokeObjectURL(url), 1500);'],
  ['history trimming before retaining snapshots', 'function trimHistoryToBudget()'],
  ['pending stroke preview cancellation', 'cancelAnimationFrame(strokeRenderFrame)'],
  ['lost pointer capture handling', "addEventListener('lostpointercapture'"],
  ['local draft persistence', 'indexedDB.open(DRAFT_DB, 1)'],
  ['draft restoration on startup', 'await restoreDraft();'],
  ['serialized draft writes', 'let draftWriteQueue = Promise.resolve();'],
  ['immutable queued draft snapshot', 'JSON.parse(JSON.stringify(glyphData))'],
  ['restored stroke validation', 'Number.isFinite(Number(point[0]))'],
  ['IndexedDB store migration guard', 'objectStoreNames.contains(DRAFT_STORE)'],
  ['visible .notdef glyph', "name: '.notdef'"],
  ['normalized left side bearing', 'const xOffset = sideBearing - minX * scale;'],
  ['advance width from glyph bounds', '(maxX - minX) * scale'],
  ['TrueType outer/hole winding normalization', "role === 'outer' && signedArea > 0"],
  ['explicit contour role migration', "stroke && stroke.role === 'hole' ? 'hole' : 'outer'"],
  ['compound nonzero contour fill', "setAttribute('fill-rule', 'nonzero')"],
  ['Boolean polygon union dependency', "import polygonClipping from 'polygon-clipping';"],
  ['explicit contour depth resolution', 'function getContourDepth(stroke)'],
  ['nested contour level grouping', 'const levels = new Map();'],
  ['alternating even-depth fill', 'if (depth % 2 === 0)'],
  ['nested counter subtraction', 'polygonClipping.difference(result, levelUnion)'],
  ['nested topology pipeline', 'buildNestedContourGeometry(contours)'],
  ['microscopic geometry tolerance', 'Math.abs(contourSignedArea(ring)) > 1e-3'],
  ['compound geometry export', 'getCompoundPathRecords(getCompoundGlyphGeometry(strokes, compoundOverrides[char]))'],
  ['cached glyph Boolean geometry', 'const glyphGeometryCache = new WeakMap();'],
  ['nested parent-depth validation', 'isContourWithinParentDepth(selected, strokes, selectedStrokeIndex, depth)'],
  ['restored depth is restricted to supported UI levels', 'storedDepth <= 3'],
  ['restored legacy hole role migrates to depth one', "stroke.role === 'hole' ? 1 : 0"],
  ['restored role is normalized from depth parity', "role: depth % 2 ? 'hole' : 'outer'"],
  ['four-level contour selector', 'value="nested-hole"'],
  ['depth-preserving role compatibility', 'selected.depth = depth'],
  ['nested parent containment checks actual polygon vertices', 'candidate.every(point => pointInsideRing(point, parent))'],
  ['nested parent containment rejects boundary contact', 'segmentsIntersect(a, b, parent[j], parent[(j + 1) % parent.length])'],
  ['segment endpoint and collinear rejection', 'return onSegment(a, c, b) || onSegment(a, d, b) || onSegment(c, a, d) || onSegment(c, b, d);'],
  ['contour role editor controls', "getElementById('contourRoleSelect')"],
  ['centerline node editor mode', "getElementById('nodeEditModeBtn')"],
  ['vector outline editor mode', "getElementById('outlineEditModeBtn')"],
  ['editable outline geometry override', 'stroke.outlineOverride'],
  ['outline vertex drag handler', 'activeOutlineDrag.pointIndex'],
  ['outline self-intersection guard', 'function isValidEditableRing(points, changedVertexIndex = null, originalPoints = null)'],
  ['centerline node handles', "setAttribute('data-node-index', String(pointIndex))"],
  ['centerline node dragging', 'activeNodeDrag.pointIndex'],
  ['node drag undo commit only on change', 'if (commit && changed) {\ninvalidateCompoundOverride();\nsaveHistory();'],
  ['trajectory point insertion', 'addTrajectoryPointBtn.onclick'],
  ['trajectory point deletion', 'deleteTrajectoryPointBtn.onclick'],
  ['OpenType preview MIME type', "type: 'font/otf'"],
  ['TrueType export MIME type', "type: 'font/ttf'"],
  ['OTF-to-TTF conversion import', "import { createFont } from 'fonteditor-core';"],
  ['OTF parsing before conversion', "createFont(otfBuffer, {type: 'otf'})"],
  ['TrueType output conversion', "converter.write({type: 'ttf', hinting: false, kerning: false})"],
  ['TrueType sfnt signature validation', 'signature[1] !== 1'],
  ['honest TrueType download extension', 'link.download = fileName;'],
  ['download uses a user-triggered anchor', 'link.click();'],
  ['vertical ascender metric covers maximum brush extent', 'const ascender = 950;'],
  ['vertical descender metric covers maximum brush extent', 'const descender = -370;'],
  ['full Unicode code point mapping', 'char.codePointAt(0)'],
  ['supplementary-plane glyph naming', "'u' + codePoint.toString(16).toUpperCase().padStart(5, '0')"],
  ['nearest outline handle hit testing', 'candidateHandles.reduce((best, handle) =>'],
  ['final Boolean shape editing mode', "const compoundEditModeBtn = document.getElementById('compoundEditModeBtn');"],
  ['per-glyph final geometry overrides', 'const compoundOverrides = {};'],
  ['compound geometry persisted in project snapshots', 'compoundOverrides: JSON.parse(JSON.stringify(compoundOverrides))'],
  ['compound geometry topology validation', 'function isValidCompoundEdit(candidate, original)'],
  ['compound vertex drag lifecycle', 'function finishCompoundDrag(commit)'],
  ['TTF export uses final Boolean geometry', 'getCompoundGlyphGeometry(strokes, compoundOverrides[char])'],
  ['browser regression for final Boolean geometry editing', 'edits final Boolean compound rings with undo, redo, draft persistence and TTF export'],
  ['font library uses IndexedDB', "const FONT_LIBRARY_PREFIX = 'font-library:';"],
  ['font library saves generated TTF binaries', 'blob: fontFile.blob'],
  ['font library saves editable project snapshots', 'projectSnapshot: serializeProjectSnapshot()'],
  ['font library imports validated TTF and OTF files', 'const parsed = opentype.parse(buffer.slice(0));'],
  ['font library supports search', "librarySearch.addEventListener('input', renderFontLibrary)"],
  ['font library supports backup export', "format:'GlyphFlowFontLibrary'"],
  ['font library supports backup restore', "backup.format !== 'GlyphFlowFontLibrary'"],
  ['PWA manifest linked from the app', 'rel="manifest"'],
  ['service worker registered by the app', "navigator.serviceWorker.register('./sw.js'"]
];

for (const [label, token] of requiredContracts) {
  assert.ok(html.includes(token) || moduleSource.includes(token) || browserTests.includes(token), `Missing required contract: ${label}`);
}

assert.ok(!html.includes('font.download()'), 'Deprecated library download helper must not be used');
assert.ok(!html.includes('Скачать .OTF'), 'The UI must provide the requested TrueType TTF export');
assert.equal(pwaManifest.display, 'standalone', 'PWA must launch in standalone mode');
assert.ok(pwaManifest.icons?.some(icon => icon.src === './icons/glyphflow.svg' && icon.purpose.includes('maskable')), 'PWA manifest must expose a maskable app icon');
assert.equal(publicManifest, sourceManifest, 'Vite public manifest must match the source manifest');
assert.equal(publicServiceWorker, serviceWorker, 'Vite public service worker must match the tested source worker');
assert.equal(publicIcon, sourceIcon, 'Vite public icon must match the source icon');
assert.ok(serviceWorker.includes("const CACHE_NAME = CACHE_PREFIX + 'v2';"), 'Service worker must version its app-shell cache');
assert.ok(serviceWorker.includes("new URL('manifest.webmanifest', APP_SCOPE).href"), 'Service worker must cache the manifest');
assert.equal(packageJson.dependencies['perfect-freehand'], '1.2.0', 'Brush runtime must be pinned locally');
assert.equal(packageJson.dependencies['fonteditor-core'], '2.6.3', 'TTF conversion runtime must be pinned locally');
assert.equal(packageJson.dependencies['opentype.js'], '1.3.4', 'OpenType runtime must be pinned locally');
assert.equal(packageJson.dependencies['polygon-clipping'], '0.15.7', 'Boolean geometry runtime must be pinned locally');
assert.ok(browserTests.includes('exposes an installable PWA manifest'), 'Browser tests must cover PWA installation metadata and shell caching');

console.log(`GlyphFlow checks passed: module syntax + ${requiredContracts.length} structural contracts.`);
console.log('Note: these checks do not replace browser, touch-device, or independent TTF validation.');
