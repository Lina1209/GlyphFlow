import opentype from 'opentype.js';

// Импортируем библиотеку каллиграфической кисти perfect-freehand
import { getStroke } from 'perfect-freehand';
import { createFont } from 'fonteditor-core';
import polygonClipping from 'polygon-clipping';
import { getGlyphMetadata, getSingleCodePoint, getLoadedUnicodeVersion, loadUnicodeCatalog } from './glyph-metadata.js';

// Keep the historical browser parser API available for font inspection and integrations.
window.opentype = opentype;

// Набор символов для старта (Кириллица + Латиница + Цифры)
const CHARS = [
...'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ',
...'абвгдеёжзийклмнопрстуфхцчшщъыьэюя',
...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
...'0123456789!?.,-'
];

// Хранилище исходных штрихов и ручных правок итоговой Boolean-геометрии.
const glyphData = {};
const compoundOverrides = {};
let currentChar = 'А';
let currentPoints = [];
let activeProjectPointCount = 0;
let isDrawing = false;
let activePointerId = null;
let contourEditMode = false;
let nodeEditMode = false;
let outlineEditMode = false;
let activeNodeDrag = null;
let activeOutlineDrag = null;
let compoundEditMode = false;
let activeCompoundDrag = null;
let selectedCompoundRing = null;
let selectedNodeIndex = null;
let selectedOutlineIndex = null;
let selectedStrokeIndex = null;
let panPointerId = null;
let panStart = null;
// Отдельное состояние контактных указателей для двухпальцевого жеста.
const touchPointers = new Map();
let pinchStart = null;
let touchGestureConsumed = false;
let viewBox = { x: 0, y: 0, size: 360 };
const FONT_METADATA_LIMITS = {
designer: 128, manufacturer: 128, version: 32, description: 1024,
copyright: 512, trademark: 256, license: 2048,
licenseURL: 512, designerURL: 512, manufacturerURL: 512
};
const FONT_METADATA_FIELDS = Object.keys(FONT_METADATA_LIMITS);
function sanitizeFontMetadata(source = {}) {
if (!source || typeof source !== 'object' || Array.isArray(source)) {
throw new Error('Метаданные шрифта имеют неверную структуру.');
}
const clean = {};
for (const key of FONT_METADATA_FIELDS) {
const value = source[key] === undefined || source[key] === null ? '' : source[key];
if (typeof value !== 'string' || value.length > FONT_METADATA_LIMITS[key]) {
throw new Error('Поле метаданных «' + key + '» имеет неверный тип или превышает лимит длины.');
}
const normalized = value.trim();
if (key.endsWith('URL') && normalized) {
let url;
try { url = new URL(normalized); } catch { throw new Error('Некорректная ссылка в метаданных «' + key + '».'); }
if (!['https:', 'http:'].includes(url.protocol)) {
throw new Error('Ссылки в метаданных должны использовать HTTP или HTTPS.');
}
}
clean[key] = normalized;
}
return clean;
}
function getFontMetadata() {
const values = {};
for (const key of FONT_METADATA_FIELDS) {
const field = document.getElementById('font' + key[0].toUpperCase() + key.slice(1));
values[key] = field?.value || '';
}
return sanitizeFontMetadata(values);
}
function getFontRevision(version) {
const match = String(version || '').match(/(\d+(?:\.\d{1,3})?)/);
const revision = match ? Number(match[1]) : 1;
return Number.isFinite(revision) && revision >= 0 && revision <= 65535.999 ? revision : 1;
}
function applyFontMetadata(metadata) {
const clean = sanitizeFontMetadata(metadata || {});
for (const key of FONT_METADATA_FIELDS) {
const field = document.getElementById('font' + key[0].toUpperCase() + key.slice(1));
if (field) field.value = clean[key];
}
}
function serializeProjectSnapshot() {
return JSON.stringify({version: 2, glyphData, compoundOverrides, fontMetadata: getFontMetadata()});
}
const MAX_STROKE_POINTS = 10000;
const MAX_STROKES_PER_GLYPH = 256;
const MAX_PROJECT_POINTS = 200000;
const MAX_PROJECT_SNAPSHOT_CHARS = 25 * 1024 * 1024;
const MAX_COMPOUND_VERTICES = 50000;

function sanitizeProjectModel(parsed) {
if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
throw new Error('Структура проекта повреждена.');
}
const sourceGlyphs = parsed.glyphData && typeof parsed.glyphData === 'object'
? parsed.glyphData
: parsed;
if (!sourceGlyphs || typeof sourceGlyphs !== 'object' || Array.isArray(sourceGlyphs)) {
throw new Error('В проекте отсутствуют данные символов.');
}
const cleanGlyphs = Object.create(null);
let totalPoints = 0;
for (const char of CHARS) {
const strokes = sourceGlyphs[char];
if (strokes === undefined) continue;
if (!Array.isArray(strokes) || strokes.length > MAX_STROKES_PER_GLYPH) {
throw new Error('Слишком много штрихов или повреждён список символа «' + char + '».');
}
const cleanStrokes = [];
for (const stroke of strokes) {
if (!stroke || typeof stroke !== 'object' || !Array.isArray(stroke.points) ||
stroke.points.length < 1 || stroke.points.length > MAX_STROKE_POINTS) {
throw new Error('Обнаружен повреждённый или слишком длинный штрих символа «' + char + '».');
}
totalPoints += stroke.points.length;
if (totalPoints > MAX_PROJECT_POINTS) {
throw new Error('Проект превышает безопасный лимит точек. Разделите работу на несколько проектов.');
}
const points = stroke.points.map(point => {
if (!Array.isArray(point) || point.length < 2 ||
!Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1])) ||
Math.abs(Number(point[0])) > 1000000 || Math.abs(Number(point[1])) > 1000000) {
throw new Error('В проекте найдены некорректные координаты.');
}
return [Number(point[0]), Number(point[1])];
});
const size = Number(stroke.size);
const thinning = Number(stroke.thinning);
if (!Number.isFinite(size) || size <= 0 || size > 1000 ||
!Number.isFinite(thinning) || thinning < -1 || thinning > 1) {
throw new Error('В проекте найдены недопустимые параметры кисти.');
}
const storedDepth = Number(stroke.depth);
const depth = Number.isInteger(storedDepth) && storedDepth >= 0 && storedDepth <= 3
? storedDepth
: stroke.role === 'hole' ? 1 : 0;
const cleanStroke = {...stroke, points, size, thinning, depth, role: depth % 2 ? 'hole' : 'outer'};
if (stroke.outlineOverride !== undefined) {
if (!Array.isArray(stroke.outlineOverride) ||
stroke.outlineOverride.length > MAX_STROKE_POINTS ||
stroke.outlineOverride.some(point => !Array.isArray(point) || point.length < 2 ||
!Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1])))) {
throw new Error('В проекте найден повреждённый контур штриха.');
}
cleanStroke.outlineOverride = stroke.outlineOverride.map(point => [Number(point[0]), Number(point[1])]);
}
cleanStrokes.push(cleanStroke);
}
if (cleanStrokes.length) cleanGlyphs[char] = cleanStrokes;
}
const cleanOverrides = Object.create(null);
const sourceOverrides = parsed.glyphData ? parsed.compoundOverrides : null;
if (sourceOverrides !== undefined && sourceOverrides !== null &&
(typeof sourceOverrides !== 'object' || Array.isArray(sourceOverrides))) {
throw new Error('Структура составных контуров повреждена.');
}
let compoundVertices = 0;
for (const char of CHARS) {
const geometry = sourceOverrides?.[char];
if (geometry === undefined) continue;
if (!Array.isArray(geometry)) throw new Error('Повреждён составной контур символа «' + char + '».');
for (const polygon of geometry) {
if (!Array.isArray(polygon)) throw new Error('Повреждён составной контур символа «' + char + '».');
for (const ring of polygon) {
if (!Array.isArray(ring) || ring.length < 3 || ring.length > MAX_STROKE_POINTS ||
ring.some(point => !Array.isArray(point) || point.length < 2 ||
!Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1])))) {
throw new Error('Повреждена геометрия символа «' + char + '».');
}
compoundVertices += ring.length;
if (compoundVertices > MAX_COMPOUND_VERTICES) {
throw new Error('Составная геометрия проекта превышает безопасный лимит.');
}
}
}
const valid = sanitizeCompoundGeometry(geometry);
if (!valid) throw new Error('Не удалось проверить составной контур символа «' + char + '».');
cleanOverrides[char] = valid;
}
const cleanFontMetadata = parsed.fontMetadata === undefined ? getFontMetadata() : sanitizeFontMetadata(parsed.fontMetadata);
return {glyphData: cleanGlyphs, compoundOverrides: cleanOverrides, fontMetadata: cleanFontMetadata};
}

function restoreProjectSnapshot(snapshot) {
if (typeof snapshot !== 'string' || snapshot.length > MAX_PROJECT_SNAPSHOT_CHARS) {
throw new Error('Размер проекта превышает безопасный лимит или снимок повреждён.');
}
const parsed = JSON.parse(snapshot);
const clean = sanitizeProjectModel(parsed);
Object.keys(glyphData).forEach(key => delete glyphData[key]);
Object.entries(clean.glyphData).forEach(([char, strokes]) => { glyphData[char] = strokes; });
Object.keys(compoundOverrides).forEach(key => delete compoundOverrides[key]);
Object.entries(clean.compoundOverrides).forEach(([char, geometry]) => { compoundOverrides[char] = geometry; });
applyFontMetadata(clean.fontMetadata);
}
let history = [serializeProjectSnapshot()];
let historyIndex = 0;
let previewFontUrl = null;

// Элементы DOM
const glyphGrid = document.getElementById('glyphGrid');
const drawSvg = document.getElementById('drawSvg');
const guideSvg = document.getElementById('guideSvg');
const currentCharLabel = document.getElementById('currentCharLabel');
const brushSizeInput = document.getElementById('brushSize');
const brushThinningInput = document.getElementById('brushThinning');
const sizeVal = document.getElementById('sizeVal');
const thinningVal = document.getElementById('thinningVal');
const previewInput = document.getElementById('previewInput');
const livePreviewOutput = document.getElementById('livePreviewOutput');
const progressText = document.getElementById('progressText');
const contourModeBtn = document.getElementById('contourModeBtn');
const nodeEditModeBtn = document.getElementById('nodeEditModeBtn');
const outlineEditModeBtn = document.getElementById('outlineEditModeBtn');
const compoundEditModeBtn = document.getElementById('compoundEditModeBtn');
const addTrajectoryPointBtn = document.getElementById('addTrajectoryPointBtn');
const deleteTrajectoryPointBtn = document.getElementById('deleteTrajectoryPointBtn');
const contourRoleSelect = document.getElementById('contourRoleSelect');
const applyContourRoleBtn = document.getElementById('applyContourRoleBtn');
const contourStatus = document.getElementById('contourStatus');

// Преобразование массива точек от perfect-freehand в SVG-путь
function getSvgPathFromStroke(stroke) {
if (!stroke.length) return '';
const d = stroke.reduce(
(acc, [x0, y0], i, arr) => {
const [x1, y1] = arr[(i + 1) % arr.length];
acc.push(x0.toFixed(1), y0.toFixed(1), ((x0 + x1) / 2).toFixed(1), ((y0 + y1) / 2).toFixed(1));
return acc;
},
['M', ...stroke[0].map(n => n.toFixed(1)), 'Q']
);
d.push('Z');
return d.join(' ');
}

// Отрисовка сетки символов слева
function renderCurrentGlyphMetadata() {
const panel = document.getElementById('currentGlyphMetadata');
if (!panel) return;
const item = getGlyphMetadata(currentChar);
if (!item) {
panel.textContent = 'Для этого символа нет карточки метаданных.';
return;
}
panel.replaceChildren();
const fields = [
['Unicode', item.codePoint],
['Unicode Name', item.unicodeName || (item.metadataSource?.startsWith('Unicode') ? 'Официальное имя не назначено или не опубликовано' : 'Не найдено в локальном каталоге')],
['Glyph Name', item.glyphName],
['Категория', item.category],
['Unicode General Category', item.generalCategory],
['Unicode Script', item.script],
['Combining Class', item.combiningClass ?? '—'],
['Источник метаданных', item.metadataSource || 'Локальный каталог'],
['Статус', item.metadataStatus || 'needs-review'],
['Описание', item.description]
];
fields.forEach(([label, value]) => {
const row = document.createElement('div');
row.className = 'flex flex-col sm:flex-row sm:gap-2 text-xs';
const key = document.createElement('span');
key.className = 'text-slate-400 shrink-0';
key.textContent = label + ':';
const text = document.createElement('span');
text.className = 'text-slate-100 break-words';
text.textContent = value;
row.append(key, text);
panel.appendChild(row);
});
}

function renderGrid() {
glyphGrid.innerHTML = '';
let completedCount = 0;
CHARS.forEach(char => {
const hasStrokes = glyphData[char] && glyphData[char].length > 0;
if (hasStrokes) completedCount++;
const metadata = getGlyphMetadata(char);
const btn = document.createElement('button');
btn.textContent = char;
btn.setAttribute('aria-label', metadata
? char + ', ' + metadata.unicodeName + ', ' + metadata.codePoint
: char);
btn.title = metadata ? metadata.unicodeName + ' · ' + metadata.codePoint : char;
btn.className = `h-10 rounded-lg font-medium text-sm transition flex items-center justify-center border ${
char === currentChar
? 'bg-indigo-600 border-indigo-400 text-white shadow-md'
: hasStrokes
? 'bg-emerald-950/60 border-emerald-600/60 text-emerald-300 hover:bg-emerald-900/60'
: 'bg-slate-900/70 border-slate-700 text-slate-400 hover:bg-slate-700'
}`;
btn.onclick = () => selectChar(char);
glyphGrid.appendChild(btn);
});
progressText.textContent = `Готово: ${completedCount} / ${CHARS.length}`;
renderCurrentGlyphMetadata();
}

// Переключение активной буквы
function selectChar(char) {
if (activeNodeDrag) finishNodeDrag(false);
if (activeOutlineDrag) finishOutlineDrag(false);
if (activeCompoundDrag) finishCompoundDrag(false);
if (isDrawing) finishStroke(false, false);
currentChar = char;
selectedCompoundRing = null;
selectedStrokeIndex = null;
selectedNodeIndex = null;
selectedOutlineIndex = null;
updateContourTools();
currentCharLabel.textContent = char;
renderGrid();
renderCanvas();
}

const glyphGeometryCache = new WeakMap();
function getStrokeOutline(stroke) {
if (!stroke) return [];
if (Array.isArray(stroke.outlineOverride) && stroke.outlineOverride.length >= 3) {
const override = cleanPolygonRing(stroke.outlineOverride);
if (override.length >= 3) return override;
}
if (!Array.isArray(stroke.points) || !stroke.points.length) return [];
return getStroke(stroke.points, {
size: Number(stroke.size) || 16,
thinning: Number.isFinite(Number(stroke.thinning)) ? Number(stroke.thinning) : 0.6,
smoothing: 0.5,
streamline: 0.5,
});
}
function getContourRole(stroke) {
if (Number.isInteger(stroke && stroke.depth) && stroke.depth >= 0) return stroke.depth % 2 ? 'hole' : 'outer';
return stroke && stroke.role === 'hole' ? 'hole' : 'outer';
}
function contourSignedArea(points) {
let area = 0;
for (let i = 0; i < points.length; i++) {
const a = points[i], b = points[(i + 1) % points.length];
area += a[0] * b[1] - b[0] * a[1];
}
return area / 2;
}
function orientSvgContour(outline, role) {
if (outline.length < 3) return outline;
const area = contourSignedArea(outline);
const wantsPositive = role !== 'hole';
return ((area > 0) === wantsPositive) ? outline : [...outline].reverse();
}
function cleanPolygonRing(points) {
const ring = [];
for (const point of points || []) {
if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
const previous = ring[ring.length - 1];
if (!previous || Math.abs(previous[0] - point[0]) > 1e-7 || Math.abs(previous[1] - point[1]) > 1e-7) {
ring.push([point[0], point[1]]);
}
}
if (ring.length > 2 &&
Math.abs(ring[0][0] - ring[ring.length - 1][0]) <= 1e-7 &&
Math.abs(ring[0][1] - ring[ring.length - 1][1]) <= 1e-7) ring.pop();
// Discard sub-pixel numerical remnants before they become phantom glyph components.
return ring.length >= 3 && Math.abs(contourSignedArea(ring)) > 1e-3 ? ring : [];
}
function getContourDepth(stroke) {
if (Number.isInteger(stroke && stroke.depth) && stroke.depth >= 0) return stroke.depth;
return getContourRole(stroke) === 'hole' ? 1 : 0;
}
// Even depths add filled regions; odd depths subtract counters. Union each
// level first so overlapping strokes at the same nesting depth behave as one region.
function buildNestedContourGeometry(contours) {
const levels = new Map();
(contours || []).forEach(contour => {
const depth = Number(contour && contour.depth);
const ring = cleanPolygonRing(contour && contour.ring);
if (!Number.isInteger(depth) || depth < 0 || ring.length < 3) return;
if (!levels.has(depth)) levels.set(depth, []);
levels.get(depth).push([[ring]]);
});
let result = [];
[...levels.keys()].sort((a, b) => a - b).forEach(depth => {
const levelUnion = polygonClipping.union(...levels.get(depth));
if (depth % 2 === 0) {
result = result.length ? polygonClipping.union(result, levelUnion) : levelUnion;
} else if (result.length) {
result = polygonClipping.difference(result, levelUnion);
}
});
return result;
}
function cloneCompoundGeometry(geometry) {
return (geometry || []).map(polygon => {
const rings = (polygon || []).map(ring => cleanPolygonRing(ring));
if (!rings.length || rings[0].length < 3) return null;
// A Boolean library may leave a zero-area remnant after touching edges.
// It is not a real component and must never become an editable empty polygon.
return [rings[0], ...rings.slice(1).filter(ring => ring.length >= 3)];
}).filter(Boolean);
}
function compoundTopologySignature(geometry) {
return (geometry || []).map(polygon => polygon.length).sort((a, b) => a - b).join(',');
}
function sanitizeCompoundGeometry(input) {
if (!Array.isArray(input) || !input.length) return null;
const candidate = input.map(polygon => {
if (!Array.isArray(polygon) || !polygon.length) return null;
const rings = polygon.map(ring => cleanPolygonRing(ring));
if (rings.some(ring => ring.length < 3 || Math.abs(contourSignedArea(ring)) <= 1e-3)) return null;
return rings;
});
if (candidate.some(polygon => !polygon)) return null;
try {
const normalized = polygonClipping.union(candidate);
if (!normalized.length || compoundTopologySignature(normalized) !== compoundTopologySignature(candidate)) return null;
if (!Number.isFinite(multiPolygonArea(normalized)) || multiPolygonArea(normalized) <= 1e-3) return null;
return candidate;
} catch (err) {
return null;
}
}
function invalidateCompoundOverride(char = currentChar) {
if (Object.prototype.hasOwnProperty.call(compoundOverrides, char)) delete compoundOverrides[char];
}
function getCompoundGlyphGeometry(strokes, override = null) {
if (Array.isArray(override) && override.length) return override;
if (!Array.isArray(strokes) || !strokes.length) return [];
const cached = glyphGeometryCache.get(strokes);
if (cached) return cached;
const contours = strokes.map(stroke => ({
depth: getContourDepth(stroke),
ring: getStrokeOutline(stroke)
}));
const result = buildNestedContourGeometry(contours);
glyphGeometryCache.set(strokes, result);
return result;
}
function getCompoundPathRecords(geometry) {
const records = [];
(geometry || []).forEach((polygon, polygonIndex) => {
polygon.forEach((ring, ringIndex) => {
const outline = cleanPolygonRing(ring);
if (outline.length >= 3) {
const role = ringIndex === 0 ? 'outer' : 'hole';
records.push({outline: orientSvgContour(outline, role), role, polygonIndex, ringIndex});
}
});
});
return records;
}
function multiPolygonArea(geometry) {
return (geometry || []).reduce((total, polygon) => {
if (!polygon.length) return total;
const outerArea = Math.abs(contourSignedArea(polygon[0]));
const holesArea = polygon.slice(1).reduce((sum, ring) => sum + Math.abs(contourSignedArea(ring)), 0);
return total + Math.max(0, outerArea - holesArea);
}, 0);
}
function isSimpleRingAfterVertexMove(ring, pointIndex) {
const count = ring.length;
if (count < 3) return false;
const affectedEdges = [(pointIndex - 1 + count) % count, pointIndex];
for (const edgeIndex of affectedEdges) {
const a = ring[edgeIndex];
const b = ring[(edgeIndex + 1) % count];
for (let otherIndex = 0; otherIndex < count; otherIndex++) {
const otherNext = (otherIndex + 1) % count;
if (otherIndex === edgeIndex || otherNext === edgeIndex ||
otherIndex === (edgeIndex + 1) % count || otherNext === (edgeIndex + 1) % count) continue;
if (segmentsIntersect(a, b, ring[otherIndex], ring[otherNext])) return false;
}
}
return true;
}
function closePolygonClippingRings(geometry) {
return (geometry || []).map(polygon => polygon.map(ring => {
const cleaned = cleanPolygonRing(ring);
if (cleaned.length < 3) return [];
const first = cleaned[0], last = cleaned[cleaned.length - 1];
return [...cleaned.map(point => [...point]), [...first]];
}));
}
function isValidCompoundEdit(candidate, original) {
const reject = reason => {
if (typeof drawSvg !== 'undefined') drawSvg.dataset.compoundTopologyDebug = reason;
return false;
};
if (!Array.isArray(candidate) || !candidate.length || !Array.isArray(original) ||
candidate.length !== original.length) return reject('polygon-count-changed');
const allRings = [];
for (let polygonIndex = 0; polygonIndex < candidate.length; polygonIndex++) {
const polygon = candidate[polygonIndex], originalPolygon = original[polygonIndex];
if (!Array.isArray(polygon) || !Array.isArray(originalPolygon) ||
polygon.length !== originalPolygon.length || !polygon.length) return reject('ring-count-changed');
for (let ringIndex = 0; ringIndex < polygon.length; ringIndex++) {
const ring = cleanPolygonRing(polygon[ringIndex]);
const originalRing = cleanPolygonRing(originalPolygon[ringIndex]);
if (ring.length < 3 || ring.length !== originalRing.length ||
Math.sign(contourSignedArea(ring)) !== Math.sign(contourSignedArea(originalRing))) {
return reject(JSON.stringify({reason: 'invalid-ring-or-winding', polygonIndex, ringIndex,
ringLength: ring.length, originalRingLength: originalRing.length,
rawRingLength: polygon[ringIndex]?.length ?? null,
originalRawRingLength: originalPolygon[ringIndex]?.length ?? null,
area: contourSignedArea(ring), originalArea: contourSignedArea(originalRing)}));
}
for (let i = 0; i < ring.length; i++) {
const a = ring[i], b = ring[(i + 1) % ring.length];
for (let j = i + 1; j < ring.length; j++) {
const next = (j + 1) % ring.length;
if (j === i || j === (i + 1) % ring.length || next === i) continue;
if (segmentsIntersect(a, b, ring[j], ring[next])) return reject('self-intersection');
}
}
allRings.push({polygonIndex, ringIndex, ring, originalRing});
}
}
const pointInsideRing = (point, ring) => {
let inside = false;
for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
const a = ring[i], b = ring[j];
if ((a[1] > point[1]) !== (b[1] > point[1]) &&
point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
}
return inside;
};
const containment = rings => rings.map((item, index) =>
rings.map((other, otherIndex) => index !== otherIndex && pointInsideRing(item.ring[0], other.ring))
);
for (let i = 0; i < allRings.length; i++) {
for (let j = i + 1; j < allRings.length; j++) {
const first = allRings[i].ring, second = allRings[j].ring;
for (let a = 0; a < first.length; a++) {
for (let b = 0; b < second.length; b++) {
if (segmentsIntersect(first[a], first[(a + 1) % first.length],
second[b], second[(b + 1) % second.length])) return reject('rings-intersect');
}
}
}
}
const originalRings = allRings.map(item => ({
...item,
ring: item.originalRing
}));
if (JSON.stringify(containment(allRings)) !== JSON.stringify(containment(originalRings))) {
return reject('ring-containment-changed');
}
const signature = compoundTopologySignature(candidate);
if (signature !== compoundTopologySignature(original)) return reject('topology-signature-changed');
const area = multiPolygonArea(candidate);
if (!Number.isFinite(area) || area <= 1e-3) return reject('invalid-area');
if (typeof drawSvg !== 'undefined') drawSvg.dataset.compoundTopologyDebug =
JSON.stringify({signature, area, polygonCount: candidate.length});
return true;
}
function segmentsIntersect(a, b, c, d) {
const epsilon = 1e-7;
const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
const onSegment = (p, q, r) =>
Math.abs(cross(p, q, r)) <= epsilon &&
q[0] >= Math.min(p[0], r[0]) - epsilon && q[0] <= Math.max(p[0], r[0]) + epsilon &&
q[1] >= Math.min(p[1], r[1]) - epsilon && q[1] <= Math.max(p[1], r[1]) + epsilon;
const abC = cross(a, b, c), abD = cross(a, b, d);
const cdA = cross(c, d, a), cdB = cross(c, d, b);
if (((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon)) &&
((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))) return true;
return onSegment(a, c, b) || onSegment(a, d, b) || onSegment(c, a, d) || onSegment(c, b, d);
}
function isContourWithinParentDepth(candidateStroke, strokes, candidateIndex, depth) {
if (depth === 0) return true;
const candidate = cleanPolygonRing(getStrokeOutline(candidateStroke));
if (candidate.length < 3) return false;
const parentRings = strokes
.filter((stroke, index) => index !== candidateIndex && getContourDepth(stroke) === depth - 1)
.map(stroke => cleanPolygonRing(getStrokeOutline(stroke)))
.filter(ring => ring.length >= 3);
if (!parentRings.length) return false;
// A contour at depth N must fit inside one complete contour at depth N-1.
// Checking the actual polygon vertices and every edge avoids bounding-box
// false positives and does not confuse a cut-out region with its complement.
const pointInsideRing = (point, ring) => {
let inside = false;
for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
const a = ring[i], b = ring[j];
if ((a[1] > point[1]) !== (b[1] > point[1]) &&
point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
}
return inside;
};
return parentRings.some(parent => {
if (!candidate.every(point => pointInsideRing(point, parent))) return false;
for (let i = 0; i < candidate.length; i++) {
const a = candidate[i], b = candidate[(i + 1) % candidate.length];
for (let j = 0; j < parent.length; j++) {
if (segmentsIntersect(a, b, parent[j], parent[(j + 1) % parent.length])) return false;
}
}
return true;
});
}
function isHoleWithinOuterBounds(holeStroke, strokes, holeIndex) {
return isContourWithinParentDepth(holeStroke, strokes, holeIndex, 1);
}
function updateContourTools() {
const strokes = glyphData[currentChar] || [];
const selected = selectedStrokeIndex === null ? null : strokes[selectedStrokeIndex];
contourModeBtn.textContent = contourEditMode ? 'Завершить выбор' : 'Выбрать контур';
contourModeBtn.classList.toggle('bg-amber-700', contourEditMode);
nodeEditModeBtn.classList.toggle('bg-amber-700', nodeEditMode);
nodeEditModeBtn.setAttribute('aria-pressed', String(nodeEditMode));
outlineEditModeBtn.classList.toggle('bg-amber-700', outlineEditMode);
outlineEditModeBtn.setAttribute('aria-pressed', String(outlineEditMode));
compoundEditModeBtn.classList.toggle('bg-amber-700', compoundEditMode);
compoundEditModeBtn.setAttribute('aria-pressed', String(compoundEditMode));
compoundEditModeBtn.textContent = compoundEditMode ? 'Завершить правку' : 'Итоговая форма';
const selectedPoints = selected ? (selected.points || []) : [];
addTrajectoryPointBtn.disabled = !nodeEditMode || !selected || selectedPoints.length < 2;
deleteTrajectoryPointBtn.disabled = !nodeEditMode || !selected || selectedPoints.length <= 2 || selectedNodeIndex === null;
contourRoleSelect.disabled = compoundEditMode || !contourEditMode || !selected;
applyContourRoleBtn.disabled = compoundEditMode || !contourEditMode || !selected;
if (compoundEditMode) {
const selectedLabel = selectedCompoundRing
? `Выбрано кольцо ${selectedCompoundRing.polygonIndex + 1} · ${selectedCompoundRing.ringIndex === 0 ? 'внешняя граница' : 'отверстие'}.`
: 'Нажмите на внешнюю границу или отверстие итоговой буквы.';
contourStatus.textContent = selectedLabel + ' Перетаскивайте узлы; изменение проверяется на самопересечения и сохранение топологии.';
} else if (nodeEditMode) {
contourStatus.textContent = selected
? `Выбран штрих ${selectedStrokeIndex + 1}. Перетаскивайте круглые узлы траектории, чтобы изменить форму.`
: 'Нажмите на штрих, чтобы показать его узлы.';
} else if (outlineEditMode) {
contourStatus.textContent = selected
? `Выбран штрих ${selectedStrokeIndex + 1}. Перетаскивайте вершины границы; составная геометрия пересчитывается.`
: 'Нажмите на штрих, чтобы показать вершины его границы.';
} else if (selected) {
contourRoleSelect.value = ['outer', 'hole', 'island', 'nested-hole'][Math.min(3, getContourDepth(selected))];
contourStatus.textContent = `Выбран контур ${selectedStrokeIndex + 1}. Уровень ${getContourDepth(selected)}: ${getContourDepth(selected) % 2 ? 'вырезание' : 'заполнение'}.`;
} else if (contourEditMode) {
contourStatus.textContent = 'Нажмите на контур буквы, чтобы выбрать его.';
} else {
contourStatus.textContent = 'Старые и новые штрихи считаются внешними контурами. Включите выбор, чтобы назначить отверстию отдельную роль.';
}
}

// Отрисовка составного контура глифа: внешние области и отверстия имеют разное направление.
function renderCanvas() {
drawSvg.innerHTML = '';
const strokes = glyphData[currentChar] || [];
let compoundGeometry = [];
let fillRecords = [];
try {
compoundGeometry = cloneCompoundGeometry(getCompoundGlyphGeometry(strokes, compoundOverrides[currentChar]));
fillRecords = getCompoundPathRecords(compoundGeometry);
} catch (err) {
console.error('Ошибка объединения контуров глифа:', err);
if (contourStatus) contourStatus.textContent = 'Не удалось объединить контуры. Проверьте геометрию штрихов.';
}
if (fillRecords.length) {
const fillPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
fillPath.setAttribute('d', fillRecords.map(record => getSvgPathFromStroke(record.outline)).join(' '));
fillPath.setAttribute('fill', '#0f172a');
fillPath.setAttribute('fill-rule', 'nonzero');
fillPath.setAttribute('class', 'glyph-fill');
fillPath.setAttribute('pointer-events', 'none');
drawSvg.appendChild(fillPath);
}
if (compoundEditMode) {
fillRecords.forEach(record => {
const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
hitPath.setAttribute('d', getSvgPathFromStroke(record.outline));
hitPath.setAttribute('fill', 'transparent');
hitPath.setAttribute('fill-rule', 'nonzero');
hitPath.setAttribute('pointer-events', 'all');
hitPath.setAttribute('data-compound-polygon-index', String(record.polygonIndex));
hitPath.setAttribute('data-compound-ring-index', String(record.ringIndex));
if (selectedCompoundRing &&
selectedCompoundRing.polygonIndex === record.polygonIndex &&
selectedCompoundRing.ringIndex === record.ringIndex) {
hitPath.setAttribute('stroke', '#f59e0b');
hitPath.setAttribute('stroke-width', '2');
}
drawSvg.appendChild(hitPath);
});
if (selectedCompoundRing) {
const selectedRing = compoundGeometry[selectedCompoundRing.polygonIndex]?.[selectedCompoundRing.ringIndex] || [];
const step = Math.max(1, Math.ceil(selectedRing.length / 48));
selectedRing.forEach((point, pointIndex) => {
if (pointIndex % step !== 0 && pointIndex !== selectedRing.length - 1) return;
const node = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
node.setAttribute('cx', String(point[0]));
node.setAttribute('cy', String(point[1]));
node.setAttribute('r', '4.5');
node.setAttribute('fill', pointIndex === selectedCompoundRing.pointIndex ? '#22c55e' : '#38bdf8');
node.setAttribute('stroke', '#ffffff');
node.setAttribute('stroke-width', '1.5');
node.setAttribute('data-compound-point-index', String(pointIndex));
node.setAttribute('role', 'slider');
node.setAttribute('aria-label', `Вершина итоговой формы ${pointIndex + 1}`);
node.setAttribute('pointer-events', 'all');
drawSvg.appendChild(node);
});
}
}
if (!compoundEditMode && (contourEditMode || nodeEditMode || outlineEditMode)) {
strokes.forEach((stroke, index) => {
const outline = orientSvgContour(getStrokeOutline(stroke), getContourRole(stroke));
if (outline.length < 3) return;
const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
hitPath.setAttribute('d', getSvgPathFromStroke(outline));
hitPath.setAttribute('fill', 'transparent');
hitPath.setAttribute('fill-rule', 'nonzero');
// Give thin/tapered counters a forgiving hit target so selecting one contour
// cannot accidentally keep the previously selected contour active.
hitPath.setAttribute('stroke', 'transparent');
hitPath.setAttribute('stroke-width', '10');
hitPath.setAttribute('stroke-linejoin', 'round');
hitPath.setAttribute('pointer-events', 'all');
hitPath.setAttribute('data-contour-index', String(index));
if (index === selectedStrokeIndex) {
hitPath.setAttribute('stroke', '#f59e0b');
hitPath.setAttribute('stroke-width', '2');
}
drawSvg.appendChild(hitPath);
const selectorPoint = outline.reduce((best, point) => !best || point[0] > best[0] ? point : best, null);
if (selectorPoint) {
const selectorHandle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
selectorHandle.setAttribute('cx', String(selectorPoint[0]));
selectorHandle.setAttribute('cy', String(selectorPoint[1]));
selectorHandle.setAttribute('r', '8');
selectorHandle.setAttribute('fill', '#f59e0b');
selectorHandle.setAttribute('stroke', '#ffffff');
selectorHandle.setAttribute('stroke-width', '1.5');
selectorHandle.setAttribute('opacity', '0.9');
selectorHandle.setAttribute('pointer-events', 'all');
selectorHandle.setAttribute('data-contour-index', String(index));
selectorHandle.setAttribute('class', 'contour-select-handle');
selectorHandle.setAttribute('role', 'button');
selectorHandle.setAttribute('aria-label', `Выбрать контур ${index + 1}`);
drawSvg.appendChild(selectorHandle);
}
});
}
if (outlineEditMode && selectedStrokeIndex !== null && strokes[selectedStrokeIndex]) {
const outlinePoints = cleanPolygonRing(getStrokeOutline(strokes[selectedStrokeIndex]));
const outlineStep = Math.max(1, Math.ceil(outlinePoints.length / 48));
outlinePoints.forEach((point, pointIndex) => {
if (pointIndex % outlineStep !== 0 && pointIndex !== outlinePoints.length - 1) return;
const node = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
node.setAttribute('cx', String(point[0]));
node.setAttribute('cy', String(point[1]));
node.setAttribute('r', '4.5');
node.setAttribute('fill', pointIndex === selectedOutlineIndex ? '#22c55e' : '#38bdf8');
node.setAttribute('stroke', '#ffffff');
node.setAttribute('stroke-width', '1.5');
node.setAttribute('data-outline-index', String(pointIndex));
node.setAttribute('role', 'slider');
node.setAttribute('aria-label', `Вершина границы ${pointIndex + 1}`);
node.setAttribute('pointer-events', 'all');
drawSvg.appendChild(node);
});
}
if (nodeEditMode && selectedStrokeIndex !== null && strokes[selectedStrokeIndex]) {
const selectedPoints = strokes[selectedStrokeIndex].points || [];
// Keep the overlay usable on dense trajectories: show at most 48 evenly
// distributed handles plus the final endpoint, while preserving source indices.
const nodeStep = Math.max(1, Math.ceil(selectedPoints.length / 48));
selectedPoints.forEach((point, pointIndex) => {
if (pointIndex % nodeStep !== 0 && pointIndex !== selectedPoints.length - 1) return;
const node = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
node.setAttribute('cx', String(point[0]));
node.setAttribute('cy', String(point[1]));
node.setAttribute('r', '4');
node.setAttribute('fill', pointIndex === selectedNodeIndex ? '#22c55e' : '#f59e0b');
node.setAttribute('stroke', '#ffffff');
node.setAttribute('stroke-width', '1.5');
node.setAttribute('data-node-index', String(pointIndex));
node.setAttribute('role', 'slider');
node.setAttribute('aria-label', `Узел траектории ${pointIndex + 1}`);
node.setAttribute('pointer-events', 'all');
drawSvg.appendChild(node);
});
}

// Рисуем текущий незавершенный штрих
if (isDrawing && currentPoints.length > 0) {
const outline = getStroke(currentPoints, {
size: Number(brushSizeInput.value),
thinning: Number(brushThinningInput.value),
smoothing: 0.5,
streamline: 0.5,
});
const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
path.setAttribute('d', getSvgPathFromStroke(outline));
path.setAttribute('fill', '#4f46e5');
path.setAttribute('pointer-events', 'none');
drawSvg.appendChild(path);
}
}

// Масштабирование и перемещение выполняются через viewBox, поэтому координаты штрихов
// остаются в исходной системе 360x360 и не меняют геометрию при зуме.
const MIN_VIEW_SIZE = 120;
const MAX_VIEW_SIZE = 720;
const zoomLevel = document.getElementById('zoomLevel');
function clampViewBox() {
viewBox.x = Math.max(-180, Math.min(540 - viewBox.size, viewBox.x));
viewBox.y = Math.max(-180, Math.min(540 - viewBox.size, viewBox.y));
}
function applyViewBox() {
clampViewBox();
const nextViewBox = `${viewBox.x} ${viewBox.y} ${viewBox.size} ${viewBox.size}`;
drawSvg.setAttribute('viewBox', nextViewBox);
guideSvg.setAttribute('viewBox', nextViewBox);
zoomLevel.textContent = `${Math.round(360 / viewBox.size * 100)}%`;
}
function svgPointFromClient(clientX, clientY) {
const point = drawSvg.createSVGPoint();
point.x = clientX;
point.y = clientY;
return point.matrixTransform(drawSvg.getScreenCTM().inverse());
}
function zoomAt(factor, clientX, clientY) {
const anchor = clientX == null ? {x: viewBox.x + viewBox.size / 2, y: viewBox.y + viewBox.size / 2} : svgPointFromClient(clientX, clientY);
const nextSize = Math.max(MIN_VIEW_SIZE, Math.min(MAX_VIEW_SIZE, viewBox.size * factor));
const ratioX = (anchor.x - viewBox.x) / viewBox.size;
const ratioY = (anchor.y - viewBox.y) / viewBox.size;
viewBox.size = nextSize;
viewBox.x = anchor.x - ratioX * nextSize;
viewBox.y = anchor.y - ratioY * nextSize;
applyViewBox();
}
function panView(dx, dy) {
viewBox.x += dx;
viewBox.y += dy;
applyViewBox();
}
document.getElementById('zoomInBtn').onclick = () => zoomAt(0.8);
document.getElementById('zoomOutBtn').onclick = () => zoomAt(1.25);
document.getElementById('zoomResetBtn').onclick = () => { viewBox = {x: 0, y: 0, size: 360}; applyViewBox(); };
document.getElementById('panLeftBtn').onclick = () => panView(-40, 0);
document.getElementById('panRightBtn').onclick = () => panView(40, 0);
document.getElementById('panUpBtn').onclick = () => panView(0, -40);
document.getElementById('panDownBtn').onclick = () => panView(0, 40);
drawSvg.addEventListener('wheel', e => {
e.preventDefault();
zoomAt(e.deltaY < 0 ? 0.9 : 1.1, e.clientX, e.clientY);
}, {passive: false});
drawSvg.addEventListener('contextmenu', e => e.preventDefault());

// Keyboard navigation for users who cannot or prefer not to use a pointer.
// The SVG receives focus and exposes these shortcuts through aria-keyshortcuts.
drawSvg.addEventListener('keydown', e => {
  const panStep = e.shiftKey ? 48 : 24;
  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      panView(-panStep, 0);
      break;
    case 'ArrowRight':
      e.preventDefault();
      panView(panStep, 0);
      break;
    case 'ArrowUp':
      e.preventDefault();
      panView(0, -panStep);
      break;
    case 'ArrowDown':
      e.preventDefault();
      panView(0, panStep);
      break;
    case '+':
    case '=':
      e.preventDefault();
      zoomAt(0.8);
      break;
    case '-':
    case '_':
      e.preventDefault();
      zoomAt(1.25);
      break;
    case 'Home':
      e.preventDefault();
      viewBox = {x: 0, y: 0, size: 360};
      applyViewBox();
      break;
  }
});

// Получение точных координат SVG с учётом текущего масштаба и положения viewBox.
function getPointerPos(e) {
const point = svgPointFromClient(e.clientX, e.clientY);
return [point.x, point.y, e.pressure || 0.5];
}

// События рисования и перетаскивания холста мышью (Alt + перетаскивание или средняя кнопка).
function touchDistance(a, b) {
return Math.hypot(a.x - b.x, a.y - b.y);
}
function updatePinchView() {
if (touchPointers.size < 2 || !pinchStart) return;
const points = [...touchPointers.values()];
const first = points[0];
const second = points[1];
const midpoint = {x: (first.x + second.x) / 2, y: (first.y + second.y) / 2};
const distance = Math.max(1, touchDistance(first, second));
const rect = drawSvg.getBoundingClientRect();
const nextSize = Math.max(MIN_VIEW_SIZE, Math.min(MAX_VIEW_SIZE,
pinchStart.viewBox.size * pinchStart.distance / distance));
const ratioX = (pinchStart.midpoint.x - rect.left) / Math.max(1, rect.width);
const ratioY = (pinchStart.midpoint.y - rect.top) / Math.max(1, rect.height);
const anchorX = pinchStart.viewBox.x + ratioX * pinchStart.viewBox.size;
const anchorY = pinchStart.viewBox.y + ratioY * pinchStart.viewBox.size;
const nextRatioX = (midpoint.x - rect.left) / Math.max(1, rect.width);
const nextRatioY = (midpoint.y - rect.top) / Math.max(1, rect.height);
viewBox.size = nextSize;
viewBox.x = anchorX - nextRatioX * nextSize;
viewBox.y = anchorY - nextRatioY * nextSize;
applyViewBox();
}
drawSvg.addEventListener('pointerdown', (e) => {
if (compoundEditMode) {
const handle = e.target.closest?.('[data-compound-point-index]');
drawSvg.dataset.compoundPointerDown = e.target.tagName || 'unknown';
drawSvg.dataset.compoundHandleFound = String(Boolean(handle));
if (handle && selectedCompoundRing) {
drawSvg.dataset.compoundDragState = 'pointerdown-handle';
const geometry = cloneCompoundGeometry(getCompoundGlyphGeometry(glyphData[currentChar] || [], compoundOverrides[currentChar]));
const polygonIndex = selectedCompoundRing.polygonIndex;
const ringIndex = selectedCompoundRing.ringIndex;
const pointIndex = Number(handle.getAttribute('data-compound-point-index'));
const ring = geometry[polygonIndex]?.[ringIndex];
if (ring && ring[pointIndex]) {
drawSvg.dataset.compoundPointIndex = String(pointIndex);
activeCompoundDrag = {
pointerId: e.pointerId,
char: currentChar,
polygonIndex,
ringIndex,
pointIndex,
originalGeometry: cloneCompoundGeometry(geometry),
originalRing: ring.map(point => [...point]),
originalOverride: compoundOverrides[currentChar] ? cloneCompoundGeometry(compoundOverrides[currentChar]) : null
};
selectedCompoundRing = {...selectedCompoundRing, pointIndex};
try { drawSvg.setPointerCapture(e.pointerId); }
catch (err) { activeCompoundDrag = null; e.preventDefault(); return; }
updateContourTools();
e.preventDefault();
return;
}
}
const hit = e.target.closest?.('[data-compound-polygon-index]');
if (hit) {
selectedCompoundRing = {
polygonIndex: Number(hit.getAttribute('data-compound-polygon-index')),
ringIndex: Number(hit.getAttribute('data-compound-ring-index')),
pointIndex: null
};
updateContourTools();
renderCanvas();
}
e.preventDefault();
return;
}
if (outlineEditMode) {
const vertex = e.target.closest?.('[data-outline-index]');
if (vertex && selectedStrokeIndex !== null) {
const stroke = (glyphData[currentChar] || [])[selectedStrokeIndex];
const pointerPosition = getPointerPos(e);
const candidateHandles = [...drawSvg.querySelectorAll('[data-outline-index]')];
const nearestHandle = candidateHandles.reduce((best, handle) => {
const x = Number(handle.getAttribute('cx'));
const y = Number(handle.getAttribute('cy'));
const distance = Math.hypot(x - pointerPosition[0], y - pointerPosition[1]);
return !best || distance < best.distance ? {handle, distance} : best;
}, null);
const pointIndex = Number((nearestHandle && nearestHandle.handle || vertex).getAttribute('data-outline-index'));
const outline = stroke ? cleanPolygonRing(getStrokeOutline(stroke)) : [];
if (outline[pointIndex]) {
selectedOutlineIndex = pointIndex;
activeOutlineDrag = {pointerId: e.pointerId, strokeIndex: selectedStrokeIndex, pointIndex,
originalOutline: outline.map(point => [...point]),
originalOverride: Array.isArray(stroke.outlineOverride) ? stroke.outlineOverride.map(point => [...point]) : null};
try { drawSvg.setPointerCapture(e.pointerId); }
catch (err) { activeOutlineDrag = null; e.preventDefault(); return; }
vertex.setAttribute('fill', '#22c55e');
updateContourTools();
e.preventDefault();
return;
}
}
const hit = e.target.closest?.('[data-contour-index]');
if (hit) {
selectedStrokeIndex = Number(hit.getAttribute('data-contour-index'));
selectedOutlineIndex = null;
updateContourTools();
renderCanvas();
}
e.preventDefault();
return;
}
if (nodeEditMode) {
const node = e.target.closest?.('[data-node-index]');
if (node && selectedStrokeIndex !== null) {
const stroke = (glyphData[currentChar] || [])[selectedStrokeIndex];
const pointIndex = Number(node.getAttribute('data-node-index'));
if (stroke && stroke.points && stroke.points[pointIndex]) {
selectedNodeIndex = pointIndex;
activeNodeDrag = {
pointerId: e.pointerId,
strokeIndex: selectedStrokeIndex,
pointIndex,
originalPoint: [...stroke.points[pointIndex]],
originalOutlineOverride: Array.isArray(stroke.outlineOverride) ? stroke.outlineOverride.map(point => [...point]) : null
};
updateContourTools();
renderCanvas();
try { drawSvg.setPointerCapture(e.pointerId); } catch (err) { activeNodeDrag = null; }
e.preventDefault();
return;
}
}
const hit = e.target.closest?.('[data-contour-index]');
if (hit) {
selectedStrokeIndex = Number(hit.getAttribute('data-contour-index'));
selectedNodeIndex = null;
updateContourTools();
renderCanvas();
}
e.preventDefault();
return;
}
if (contourEditMode) {
const hit = e.target.closest?.('[data-contour-index]');
if (hit) {
selectedStrokeIndex = Number(hit.getAttribute('data-contour-index'));
updateContourTools();
renderCanvas();
}
e.preventDefault();
return;
}
if (e.pointerType === 'touch') {
e.preventDefault();
touchPointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
try { drawSvg.setPointerCapture(e.pointerId); } catch (err) {}
if (touchPointers.size === 1) {
touchGestureConsumed = false;
} else if (touchPointers.size >= 2) {
touchGestureConsumed = true;
if (isDrawing) finishStroke(false, false);
if (panPointerId !== null) {
try { if (drawSvg.hasPointerCapture(panPointerId)) drawSvg.releasePointerCapture(panPointerId); } catch (err) {}
panPointerId = null;
panStart = null;
}
const points = [...touchPointers.values()];
pinchStart = {
distance: Math.max(1, touchDistance(points[0], points[1])),
midpoint: {x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2},
viewBox: {...viewBox}
};
}
if (touchGestureConsumed) return;
}
if (e.button === 1 || e.button === 2 || (e.altKey && e.pointerType !== 'touch')) {
e.preventDefault();
panPointerId = e.pointerId;
panStart = {clientX: e.clientX, clientY: e.clientY, x: viewBox.x, y: viewBox.y};
try { drawSvg.setPointerCapture(e.pointerId); } catch (err) { panPointerId = null; panStart = null; }
return;
}
if (e.button !== 0 || !e.isPrimary || isDrawing || panPointerId !== null) return;
const existingStrokes = glyphData[currentChar] || [];
if (existingStrokes.length >= MAX_STROKES_PER_GLYPH) {
contourStatus.textContent = 'Достигнут лимит: не более ' + MAX_STROKES_PER_GLYPH + ' штрихов на символ.';
return;
}
const existingProjectPoints = Object.values(glyphData).reduce((total, strokes) =>
total + (Array.isArray(strokes) ? strokes.reduce((sum, stroke) =>
sum + (Array.isArray(stroke.points) ? stroke.points.length : 0), 0) : 0), 0);
if (existingProjectPoints >= MAX_PROJECT_POINTS) {
contourStatus.textContent = 'Достигнут лимит точек проекта. Сохраните резервную копию и начните отдельный проект.';
return;
}
activeProjectPointCount = existingProjectPoints;
try {
if (e.pointerType !== 'touch') drawSvg.setPointerCapture(e.pointerId);
} catch (err) {
console.warn('Не удалось захватить указатель:', err);
return;
}
activePointerId = e.pointerId;
isDrawing = true;
currentPoints = [getPointerPos(e)];
renderCanvas();
});

drawSvg.addEventListener('pointermove', (e) => {
if (activeCompoundDrag && e.pointerId === activeCompoundDrag.pointerId) {
const drag = activeCompoundDrag;
const candidate = cloneCompoundGeometry(compoundOverrides[drag.char] || drag.originalGeometry);
const ring = candidate[drag.polygonIndex]?.[drag.ringIndex];
if (ring && ring[drag.pointIndex]) {
const position = getPointerPos(e);
ring[drag.pointIndex] = [position[0], position[1]];
const validRing = isValidEditableRing(ring, drag.pointIndex, drag.originalRing);
const simpleRing = validRing && isSimpleRingAfterVertexMove(ring, drag.pointIndex);
const validTopology = simpleRing && isValidCompoundEdit(candidate, drag.originalGeometry);
drawSvg.dataset.compoundDragState = validTopology ? 'accepted' : 'rejected';
drawSvg.dataset.compoundValidation = JSON.stringify({validRing, simpleRing, validTopology, ringLength: ring.length, originalLength: drag.originalRing.length});
if (validTopology) {
compoundOverrides[drag.char] = candidate;
selectedCompoundRing = {...selectedCompoundRing, pointIndex: drag.pointIndex};
renderCanvas();
updateLiveFont();
}
}
e.preventDefault();
return;
}
if (activeNodeDrag && e.pointerId === activeNodeDrag.pointerId) {
const stroke = (glyphData[currentChar] || [])[activeNodeDrag.strokeIndex];
if (stroke && stroke.points && stroke.points[activeNodeDrag.pointIndex]) {
delete stroke.outlineOverride;
stroke.points[activeNodeDrag.pointIndex] = getPointerPos(e);
if (glyphData[currentChar]) glyphGeometryCache.delete(glyphData[currentChar]);
renderCanvas();
}
e.preventDefault();
return;
}
if (activeOutlineDrag && e.pointerId === activeOutlineDrag.pointerId) {
const stroke = (glyphData[currentChar] || [])[activeOutlineDrag.strokeIndex];
if (stroke) {
const candidate = (stroke.outlineOverride || activeOutlineDrag.originalOutline).map(point => [...point]);
const position = getPointerPos(e);
candidate[activeOutlineDrag.pointIndex] = [position[0], position[1]];
const validCandidate = isValidEditableRing(candidate, activeOutlineDrag.pointIndex, activeOutlineDrag.originalOutline);
drawSvg.dataset.outlineDragState = validCandidate ? 'accepted' : 'rejected';
if (validCandidate) stroke.outlineOverride = candidate;
if (validCandidate) {
if (glyphData[currentChar]) glyphGeometryCache.delete(glyphData[currentChar]);
// Keep the SVG tree intact during pointer capture. Rebuilding innerHTML here
// can detach the active interaction surface in some browser implementations.
const handle = drawSvg.querySelector(`[data-outline-index="${activeOutlineDrag.pointIndex}"]`);
if (handle) {
handle.setAttribute('cx', String(position[0]));
handle.setAttribute('cy', String(position[1]));
}
const selectedHitPath = drawSvg.querySelector(`[data-contour-index="${activeOutlineDrag.strokeIndex}"]`);
if (selectedHitPath) selectedHitPath.setAttribute('d', getSvgPathFromStroke(orientSvgContour(candidate, getContourRole(stroke))));
try {
const previewRecords = getCompoundPathRecords(getCompoundGlyphGeometry(glyphData[currentChar] || []));
const fillPath = drawSvg.querySelector('.glyph-fill');
if (fillPath) fillPath.setAttribute('d', previewRecords.map(record => getSvgPathFromStroke(record.outline)).join(' '));
} catch (err) {
console.error('Не удалось обновить предпросмотр границы:', err);
}
}
}
e.preventDefault();
return;
}
if (e.pointerType === 'touch' && touchPointers.has(e.pointerId)) {
touchPointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
if (touchPointers.size >= 2 && pinchStart) {
updatePinchView();
return;
}
if (touchGestureConsumed) return;
}
if (e.pointerId === panPointerId && panStart) {
const rect = drawSvg.getBoundingClientRect();
const factor = viewBox.size / Math.max(1, rect.width);
viewBox.x = panStart.x - (e.clientX - panStart.clientX) * factor;
viewBox.y = panStart.y - (e.clientY - panStart.clientY) * factor;
applyViewBox();
return;
}
if (!isDrawing || e.pointerId !== activePointerId) return;
if (currentPoints.length >= MAX_STROKE_POINTS) {
contourStatus.textContent = 'Достигнут лимит ' + MAX_STROKE_POINTS + ' точек на штрих. Завершите штрих и продолжайте новым.';
return;
}
if (activeProjectPointCount + currentPoints.length >= MAX_PROJECT_POINTS) {
contourStatus.textContent = 'Достигнут лимит точек проекта. Сохраните резервную копию и начните отдельный проект.';
return;
}
currentPoints.push(getPointerPos(e));
scheduleStrokePreviewRender();
});

const DRAFT_DB = 'glyphflow-local';
const DRAFT_STORE = 'projects';
let draftWriteQueue = Promise.resolve();
let lastDraftSavedAt = 0;
let draftWriteConflict = false;
const draftSyncStatus = document.getElementById('draftSyncStatus');
const draftSyncChannel = 'BroadcastChannel' in window
? new BroadcastChannel('glyphflow-draft-sync-v1')
: null;

function showDraftWriteConflict() {
draftWriteConflict = true;
if (draftSyncStatus) {
draftSyncStatus.textContent = 'Черновик изменён в другой вкладке. Эта вкладка больше не будет перезаписывать сохранённую версию. Обновите страницу, чтобы загрузить последние изменения.';
draftSyncStatus.classList.remove('hidden');
}
}

function showDraftWriteError(err) {
if (draftWriteConflict || !draftSyncStatus) return;
draftSyncStatus.textContent = 'Не удалось сохранить черновик: ' + describeStorageError(err, 'ошибка автосохранения');
draftSyncStatus.classList.remove('hidden');
}

function clearDraftWriteError() {
if (draftWriteConflict || !draftSyncStatus) return;
draftSyncStatus.textContent = '';
draftSyncStatus.classList.add('hidden');
}

if (draftSyncChannel) {
draftSyncChannel.addEventListener('message', event => {
const savedAt = Number(event.data?.savedAt);
if (Number.isFinite(savedAt) && savedAt > lastDraftSavedAt) showDraftWriteConflict();
});
}

function openDraftDB() {
return new Promise((resolve, reject) => {
if (!('indexedDB' in window)) return reject(new Error('IndexedDB недоступен'));
const request = indexedDB.open(DRAFT_DB, 1);
let settled = false;
request.onupgradeneeded = () => {
if (!request.result.objectStoreNames.contains(DRAFT_STORE)) {
request.result.createObjectStore(DRAFT_STORE);
}
};
request.onsuccess = () => {
if (settled) {
request.result.close();
return;
}
settled = true;
// Release old connections when another tab requests a schema upgrade.
request.result.onversionchange = () => request.result.close();
resolve(request.result);
};
request.onerror = () => {
if (settled) return;
settled = true;
reject(request.error);
};
request.onblocked = () => {
if (settled) return;
settled = true;
reject(new Error('Открытие IndexedDB заблокировано другой вкладкой'));
};
});
}

// Снимок создаётся сразу, а записи выполняются строго по порядку вызовов.
function persistDraft() {
if (draftWriteConflict) return draftWriteQueue;
let snapshot;
try {
snapshot = {
glyphData: JSON.parse(JSON.stringify(glyphData)),
compoundOverrides: JSON.parse(JSON.stringify(compoundOverrides)),
fontName: document.getElementById('fontName').value,
fontMetadata: getFontMetadata(),
savedAt: Math.max(Date.now(), lastDraftSavedAt + 1)
};
} catch (err) {
console.warn('Не удалось подготовить черновик к сохранению:', err);
showDraftWriteError(err);
return draftWriteQueue;
}

draftWriteQueue = draftWriteQueue.catch(() => {}).then(async () => {
let db;
try {
if (draftWriteConflict) return;
db = await openDraftDB();
const tx = db.transaction(DRAFT_STORE, 'readwrite');
const store = tx.objectStore(DRAFT_STORE);
const currentRequest = store.get('current');
await new Promise((resolve, reject) => {
let conflictDetected = false;
currentRequest.onsuccess = () => {
const current = currentRequest.result;
if (current && Number(current.savedAt) > lastDraftSavedAt) {
conflictDetected = true;
try { tx.abort(); } catch {}
return;
}
store.put(snapshot, 'current');
};
currentRequest.onerror = () => reject(currentRequest.error);
tx.oncomplete = resolve;
tx.onerror = () => reject(tx.error);
tx.onabort = () => reject(conflictDetected
? new Error('Черновик уже сохранён в другой вкладке')
: (tx.error || new Error('Сохранение черновика отменено')));
});
lastDraftSavedAt = snapshot.savedAt;
clearDraftWriteError();
draftSyncChannel?.postMessage({ savedAt: lastDraftSavedAt });
} finally {
if (db) db.close();
}
}).catch(err => {
if (err?.message === 'Черновик уже сохранён в другой вкладке') showDraftWriteConflict();
else {
console.warn('Автосохранение недоступно:', err);
showDraftWriteError(err);
}
});
return draftWriteQueue;
}

async function restoreDraft() {
let db;
try {
db = await openDraftDB();
const tx = db.transaction(DRAFT_STORE, 'readonly');
const request = tx.objectStore(DRAFT_STORE).get('current');
const draft = await new Promise((resolve, reject) => {
let result;
request.onsuccess = () => { result = request.result; };
request.onerror = () => reject(request.error || new Error('Не удалось прочитать сохранённый черновик.'));
tx.oncomplete = () => resolve(result);
tx.onerror = () => reject(tx.error || request.error || new Error('Ошибка чтения сохранённого черновика.'));
tx.onabort = () => reject(tx.error || new Error('Чтение сохранённого черновика было прервано.'));
});
if (draft !== undefined) {
// Preserve the stored revision even when its payload is invalid, so a fresh
// edit can replace a damaged draft instead of looking like a competing tab.
lastDraftSavedAt = Number.isFinite(Number(draft?.savedAt)) ? Number(draft.savedAt) : 0;
if (!draft || typeof draft !== 'object' || Array.isArray(draft) ||
!draft.glyphData || typeof draft.glyphData !== 'object' || Array.isArray(draft.glyphData)) {
throw new Error('Сохранённый черновик имеет неверную структуру.');
}
restoreProjectSnapshot(JSON.stringify({
version: 2,
glyphData: draft.glyphData,
compoundOverrides: draft.compoundOverrides || {},
fontMetadata: draft.fontMetadata
}));
lastDraftSavedAt = Number.isFinite(Number(draft.savedAt)) ? Number(draft.savedAt) : 0;
if (typeof draft.fontName === 'string' && draft.fontName.trim()) {
document.getElementById('fontName').value = draft.fontName.slice(0, 48);
}
history = [serializeProjectSnapshot()];
historyIndex = 0;
}
} catch (err) {
console.warn('Не удалось восстановить черновик:', err);
if (draftSyncStatus) {
draftSyncStatus.textContent = 'Не удалось восстановить черновик: ' +
(err.message || 'сохранённые данные повреждены') + ' Сохранённые данные не удалены.';
draftSyncStatus.classList.remove('hidden');
}
} finally {
if (db) db.close();
}
}
// Undo snapshots are full-project JSON strings. Bound both their count and
// estimated UTF-16 storage so long editing sessions cannot grow history forever.
const MAX_HISTORY_ENTRIES = 40;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
function trimHistoryToBudget() {
let retainedBytes = 0;
let firstRetained = history.length - 1;
for (let index = history.length - 1; index >= 0; index--) {
const snapshotBytes = history[index].length * 2;
const entriesFromIndex = history.length - index;
if (index < history.length - 1 &&
(entriesFromIndex > MAX_HISTORY_ENTRIES || retainedBytes + snapshotBytes > MAX_HISTORY_BYTES)) break;
retainedBytes += snapshotBytes;
firstRetained = index;
}
if (firstRetained > 0) {
history = history.slice(firstRetained);
historyIndex = Math.max(0, historyIndex - firstRetained);
}
}
function saveHistory() {
if (glyphData[currentChar]) glyphGeometryCache.delete(glyphData[currentChar]);
const snapshot = serializeProjectSnapshot();
if (history[historyIndex] === snapshot) return;
history = history.slice(0, historyIndex + 1);
history.push(snapshot);
historyIndex = history.length - 1;
trimHistoryToBudget();
persistDraft();
}
function restoreHistory(index) {
if (index < 0 || index >= history.length) return;
if (activeNodeDrag) finishNodeDrag(false);
if (activeOutlineDrag) finishOutlineDrag(false);
if (activeCompoundDrag) finishCompoundDrag(false);
restoreProjectSnapshot(history[index]);
historyIndex = index;
selectedStrokeIndex = null;
selectedCompoundRing = null;
persistDraft();
renderCanvas(); renderGrid(); updateLiveFont(); updateContourTools();
}
let strokeRenderFrame = null;
function scheduleStrokePreviewRender() {
if (strokeRenderFrame !== null) return;
strokeRenderFrame = requestAnimationFrame(() => {
strokeRenderFrame = null;
if (isDrawing && currentPoints.length) renderCanvas();
});
}
function finishStroke(commit = true, releaseCapture = true) {
if (!isDrawing) return;
if (strokeRenderFrame !== null) {
cancelAnimationFrame(strokeRenderFrame);
strokeRenderFrame = null;
}
isDrawing = false;
if (commit && currentPoints.length) {
invalidateCompoundOverride();
if (!glyphData[currentChar]) glyphData[currentChar] = [];
glyphData[currentChar].push({points: currentPoints, size: Number(brushSizeInput.value), thinning: Number(brushThinningInput.value), role: 'outer'});
saveHistory();
}
currentPoints = [];
if (releaseCapture && activePointerId !== null && drawSvg.hasPointerCapture(activePointerId)) drawSvg.releasePointerCapture(activePointerId);
activePointerId = null;
renderCanvas(); renderGrid(); updateLiveFont();
}
function finishTouchPointer(e, cancelled = false) {
if (e.pointerType === 'touch' && touchPointers.has(e.pointerId)) {
touchPointers.delete(e.pointerId);
if (touchPointers.size < 2) pinchStart = null;
if (touchPointers.size === 0) touchGestureConsumed = false;
if (cancelled && isDrawing && e.pointerId === activePointerId) finishStroke(false);
return true;
}
return false;
}
function isValidEditableRing(points, changedVertexIndex = null, originalPoints = null) {
const ring = cleanPolygonRing(points);
const original = Array.isArray(originalPoints) ? cleanPolygonRing(originalPoints) : null;
if (ring.length < 3 || ring.length !== points.length || Math.abs(contourSignedArea(ring)) <= 1e-3) return false;
if (original && (original.length !== ring.length ||
Math.sign(contourSignedArea(original)) !== Math.sign(contourSignedArea(ring)))) return false;
// Do not reject a local edit merely because the source brush outline contains
// a pre-existing near-touch or intersection. Keep the ring finite, non-degenerate,
// same-sized and same-winding; the Boolean geometry pipeline validates the result.
return ring.every(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
}
function finishCompoundDrag(commit) {
if (!activeCompoundDrag) return;
const drag = activeCompoundDrag;
activeCompoundDrag = null;
drawSvg.dataset.compoundFinishCommit = String(commit);
if (!commit) {
if (drag.originalOverride) compoundOverrides[drag.char] = cloneCompoundGeometry(drag.originalOverride);
else delete compoundOverrides[drag.char];
} else {
const current = compoundOverrides[drag.char];
if (current && JSON.stringify(current) !== JSON.stringify(drag.originalGeometry)) saveHistory();
}
renderCanvas();
updateLiveFont();
updateContourTools();
}
function finishOutlineDrag(commit) {
if (!activeOutlineDrag) return;
const drag = activeOutlineDrag;
activeOutlineDrag = null;
const stroke = (glyphData[currentChar] || [])[drag.strokeIndex];
if (!stroke) return;
if (!commit) {
if (drag.originalOverride) stroke.outlineOverride = drag.originalOverride;
else delete stroke.outlineOverride;
}
const finalOutline = getStrokeOutline(stroke);
const changed = commit && finalOutline.length === drag.originalOutline.length &&
finalOutline.some((point, index) => Math.abs(point[0] - drag.originalOutline[index][0]) > 1e-6 ||
Math.abs(point[1] - drag.originalOutline[index][1]) > 1e-6);
if (glyphData[currentChar]) glyphGeometryCache.delete(glyphData[currentChar]);
if (changed) {
invalidateCompoundOverride();
saveHistory();
}
renderCanvas();
updateLiveFont();
updateContourTools();
}
function finishNodeDrag(commit) {
if (!activeNodeDrag) return;
const drag = activeNodeDrag;
activeNodeDrag = null;
const stroke = (glyphData[currentChar] || [])[drag.strokeIndex];
if (!commit && stroke && stroke.points && stroke.points[drag.pointIndex]) {
stroke.points[drag.pointIndex] = drag.originalPoint;
if (drag.originalOutlineOverride) stroke.outlineOverride = drag.originalOutlineOverride;
else delete stroke.outlineOverride;
}
const finalPoint = stroke && stroke.points && stroke.points[drag.pointIndex];
const changed = Boolean(finalPoint && (Math.abs(finalPoint[0] - drag.originalPoint[0]) > 1e-6 || Math.abs(finalPoint[1] - drag.originalPoint[1]) > 1e-6));
if (glyphData[currentChar]) glyphGeometryCache.delete(glyphData[currentChar]);
if (commit && changed) {
invalidateCompoundOverride();
saveHistory();
}
renderCanvas();
updateLiveFont();
updateContourTools();
}
drawSvg.addEventListener('pointerup', (e) => {
if (activeCompoundDrag && e.pointerId === activeCompoundDrag.pointerId) { finishCompoundDrag(true); return; }
if (activeNodeDrag && e.pointerId === activeNodeDrag.pointerId) { finishNodeDrag(true); return; }
if (activeOutlineDrag && e.pointerId === activeOutlineDrag.pointerId) { finishOutlineDrag(true); return; }
if (finishTouchPointer(e, false)) {
if (e.pointerId === activePointerId && isDrawing) finishStroke(true);
return;
}
if (e.pointerId === panPointerId) { panPointerId = null; panStart = null; return; }
if (e.pointerId === activePointerId) finishStroke(true);
});
drawSvg.addEventListener('pointercancel', (e) => {
if (activeCompoundDrag && e.pointerId === activeCompoundDrag.pointerId) { finishCompoundDrag(false); return; }
if (activeNodeDrag && e.pointerId === activeNodeDrag.pointerId) { finishNodeDrag(false); return; }
if (activeOutlineDrag && e.pointerId === activeOutlineDrag.pointerId) { finishOutlineDrag(false); return; }
if (finishTouchPointer(e, true)) {
if (e.pointerId === activePointerId && isDrawing) finishStroke(false);
return;
}
if (e.pointerId === panPointerId) { panPointerId = null; panStart = null; return; }
if (e.pointerId === activePointerId) finishStroke(false);
});
drawSvg.addEventListener('lostpointercapture', (e) => {
if (activeCompoundDrag && e.pointerId === activeCompoundDrag.pointerId) { finishCompoundDrag(false); return; }
if (activeNodeDrag && e.pointerId === activeNodeDrag.pointerId) { finishNodeDrag(false); return; }
if (activeOutlineDrag && e.pointerId === activeOutlineDrag.pointerId) { finishOutlineDrag(false); return; }
if (finishTouchPointer(e, true)) {
if (e.pointerId === activePointerId && isDrawing) finishStroke(false);
return;
}
if (e.pointerId === panPointerId) { panPointerId = null; panStart = null; }
if (e.pointerId === activePointerId && isDrawing) finishStroke(false);
});
// Кнопки управления
document.getElementById('undoBtn').onclick = () => restoreHistory(historyIndex - 1);
document.getElementById('redoBtn').onclick = () => restoreHistory(historyIndex + 1);
contourModeBtn.onclick = () => {
if (activeOutlineDrag) finishOutlineDrag(false);
if (activeCompoundDrag) finishCompoundDrag(false);
contourEditMode = !contourEditMode;
nodeEditMode = false;
outlineEditMode = false;
compoundEditMode = false;
selectedCompoundRing = null;
selectedStrokeIndex = null;
selectedNodeIndex = null;
selectedOutlineIndex = null;
updateContourTools();
renderCanvas();
};
nodeEditModeBtn.onclick = () => {
if (activeNodeDrag) finishNodeDrag(false);
if (activeOutlineDrag) finishOutlineDrag(false);
if (activeCompoundDrag) finishCompoundDrag(false);
nodeEditMode = !nodeEditMode;
outlineEditMode = false;
contourEditMode = false;
compoundEditMode = false;
selectedCompoundRing = null;
selectedStrokeIndex = null;
selectedNodeIndex = null;
selectedOutlineIndex = null;
updateContourTools();
renderCanvas();
};
outlineEditModeBtn.onclick = () => {
if (activeNodeDrag) finishNodeDrag(false);
if (activeOutlineDrag) finishOutlineDrag(false);
if (activeCompoundDrag) finishCompoundDrag(false);
outlineEditMode = !outlineEditMode;
nodeEditMode = false;
contourEditMode = false;
compoundEditMode = false;
selectedCompoundRing = null;
selectedStrokeIndex = null;
selectedNodeIndex = null;
selectedOutlineIndex = null;
updateContourTools();
renderCanvas();
};
compoundEditModeBtn.onclick = () => {
if (activeNodeDrag) finishNodeDrag(false);
if (activeOutlineDrag) finishOutlineDrag(false);
if (activeCompoundDrag) finishCompoundDrag(false);
compoundEditMode = !compoundEditMode;
contourEditMode = false;
nodeEditMode = false;
outlineEditMode = false;
selectedStrokeIndex = null;
selectedNodeIndex = null;
selectedOutlineIndex = null;
selectedCompoundRing = null;
updateContourTools();
renderCanvas();
};
addTrajectoryPointBtn.onclick = () => {
const strokes = glyphData[currentChar] || [];
const stroke = selectedStrokeIndex === null ? null : strokes[selectedStrokeIndex];
if (!nodeEditMode || !stroke || !Array.isArray(stroke.points) || stroke.points.length < 2) return;
const insertAt = selectedNodeIndex === null
? stroke.points.length - 1
: Math.min(selectedNodeIndex + 1, stroke.points.length - 1);
const left = stroke.points[insertAt - 1];
const right = stroke.points[insertAt];
if (!left || !right) return;
const midpoint = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
if (Number.isFinite(left[2]) && Number.isFinite(right[2])) midpoint.push((left[2] + right[2]) / 2);
else if (Number.isFinite(left[2])) midpoint.push(left[2]);
else if (Number.isFinite(right[2])) midpoint.push(right[2]);
delete stroke.outlineOverride;
stroke.points.splice(insertAt, 0, midpoint);
invalidateCompoundOverride();
selectedNodeIndex = insertAt;
glyphGeometryCache.delete(strokes);
saveHistory();
renderCanvas();
updateLiveFont();
updateContourTools();
};
deleteTrajectoryPointBtn.onclick = () => {
const strokes = glyphData[currentChar] || [];
const stroke = selectedStrokeIndex === null ? null : strokes[selectedStrokeIndex];
if (!nodeEditMode || !stroke || !Array.isArray(stroke.points) || stroke.points.length <= 2 || selectedNodeIndex === null) return;
delete stroke.outlineOverride;
stroke.points.splice(selectedNodeIndex, 1);
invalidateCompoundOverride();
selectedNodeIndex = Math.min(selectedNodeIndex, stroke.points.length - 1);
glyphGeometryCache.delete(strokes);
saveHistory();
renderCanvas();
updateLiveFont();
updateContourTools();
};
applyContourRoleBtn.onclick = () => {
const strokes = glyphData[currentChar] || [];
const selected = selectedStrokeIndex === null ? null : strokes[selectedStrokeIndex];
if (!selected) return;
const depth = ({outer: 0, hole: 1, island: 2, 'nested-hole': 3})[contourRoleSelect.value];
if (!Number.isInteger(depth)) return;
if (depth > 0 && !isContourWithinParentDepth(selected, strokes, selectedStrokeIndex, depth)) {
contourStatus.textContent = `Контур уровня ${depth} должен целиком находиться внутри области уровня ${depth - 1} и не касаться её границы.`;
contourRoleSelect.value = ['outer', 'hole', 'island', 'nested-hole'][Math.min(3, getContourDepth(selected))];
return;
}
selected.depth = depth;
selected.role = depth % 2 ? 'hole' : 'outer';
invalidateCompoundOverride();
saveHistory();
renderCanvas();
updateLiveFont();
updateContourTools();
};

document.getElementById('clearBtn').onclick = () => {
glyphData[currentChar] = [];
invalidateCompoundOverride();
selectedStrokeIndex = null;
saveHistory();
renderCanvas();
renderGrid();
updateLiveFont();
updateContourTools();
};

brushSizeInput.oninput = () => sizeVal.textContent = brushSizeInput.value + 'px';
brushThinningInput.oninput = () => thinningVal.textContent = brushThinningInput.value;
previewInput.oninput = () => livePreviewOutput.textContent = previewInput.value;
document.getElementById('fontName').addEventListener('change', () => { updateLiveFont(); persistDraft(); });
for (const key of FONT_METADATA_FIELDS) {
const field = document.getElementById('font' + key[0].toUpperCase() + key.slice(1));
field?.addEventListener('change', () => {
try {
getFontMetadata();
saveHistory();
updateLiveFont();
} catch (err) {
field.setCustomValidity(err.message);
field.reportValidity();
}
});
field?.addEventListener('input', () => field.setCustomValidity(''));
}

// Генерация объекта шрифта opentype.js
function buildOpenTypeFont() {
const unitsPerEm = 1000;
const ascender = 950;
const descender = -370;
const baselineY = 270;
const scale = 3.2;
const sideBearing = 50;

const notdefPath = new opentype.Path();
notdefPath.moveTo(50, 0);
notdefPath.lineTo(450, 0);
notdefPath.lineTo(450, 700);
notdefPath.lineTo(50, 700);
notdefPath.close();
notdefPath.moveTo(100, 50);
notdefPath.lineTo(100, 650);
notdefPath.lineTo(400, 650);
notdefPath.lineTo(400, 50);
notdefPath.close();

const notdefGlyph = new opentype.Glyph({
name: '.notdef',
unicode: 0,
advanceWidth: 500,
path: notdefPath
});

const spaceGlyph = new opentype.Glyph({
name: 'space',
unicode: 32,
advanceWidth: 350,
path: new opentype.Path()
});

const glyphs = [notdefGlyph, spaceGlyph];

Object.keys(glyphData).forEach(char => {
const strokes = glyphData[char];
if (!strokes || !strokes.length) return;
const codePoint = getSingleCodePoint(char);
if (codePoint === null) {
  throw new Error('Последовательность из нескольких кодовых точек не может быть экспортирована как один cmap-глиф без явного правила лигатуры.');
}

const contours = getCompoundPathRecords(getCompoundGlyphGeometry(strokes, compoundOverrides[char]));
let minX = Infinity;
let maxX = -Infinity;
contours.forEach(({outline}) => outline.forEach(([x]) => {
minX = Math.min(minX, x);
maxX = Math.max(maxX, x);
}));

if (!contours.length || !Number.isFinite(minX) || !Number.isFinite(maxX)) return;

const fontPath = new opentype.Path();
const xOffset = sideBearing - minX * scale;
contours.forEach(({outline, role}) => {
const mapped = outline.map(([x, y]) => ({
x: x * scale + xOffset,
y: (baselineY - y) * scale
}));
// В TrueType внешние контуры и отверстия должны иметь противоположное
// направление. Инверсия оси Y меняет ориентацию исходного SVG-контура.
const signedArea = mapped.reduce((area, current, index) => {
const next = mapped[(index + 1) % mapped.length];
return area + current.x * next.y - next.x * current.y;
}, 0);
if ((role === 'outer' && signedArea > 0) || (role === 'hole' && signedArea < 0)) mapped.reverse();
fontPath.moveTo(mapped[0].x, mapped[0].y);
for (let i = 1; i < mapped.length; i++) {
fontPath.lineTo(mapped[i].x, mapped[i].y);
}
fontPath.close();
});

const glyphWidth = Math.max(1, (maxX - minX) * scale);
const advanceWidth = Math.ceil(glyphWidth + sideBearing * 2);
const glyphMetadata = getGlyphMetadata(char);
if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) return;
const glyphName = glyphMetadata?.glyphName || (codePoint <= 0xFFFF
? 'uni' + codePoint.toString(16).toUpperCase().padStart(4, '0')
: 'u' + codePoint.toString(16).toUpperCase().padStart(5, '0'));

glyphs.push(new opentype.Glyph({
name: glyphName,
unicode: codePoint,
advanceWidth,
path: fontPath
}));
});

const rawFamilyName = document.getElementById('fontName').value.trim() || 'MyHandwriting';
const familyName = rawFamilyName.replace(/[\\{};\n\r]/g, '').slice(0, 48) || 'MyHandwriting';
const metadata = getFontMetadata();
const safePostScriptFamily = familyName.replace(/[^a-zA-Z0-9-]/g, '') || 'MyHandwriting';
return new opentype.Font({
familyName,
styleName: 'Regular',
fullName: familyName + ' Regular',
postScriptName: safePostScriptFamily + '-Regular',
designer: metadata.designer,
manufacturer: metadata.manufacturer,
version: metadata.version || 'Version 1.000',
description: metadata.description,
copyright: metadata.copyright,
trademark: metadata.trademark,
license: metadata.license,
licenseURL: metadata.licenseURL,
designerURL: metadata.designerURL,
manufacturerURL: metadata.manufacturerURL,
unitsPerEm,
ascender,
descender,
glyphs
});
}

// Обновление живого предпросмотра через Blob URL
function updateLiveFont() {
try {
const font = buildOpenTypeFont();
const arrayBuffer = font.toArrayBuffer();
const blob = new Blob([arrayBuffer], { type: 'font/otf' });
const url = URL.createObjectURL(blob);
if (previewFontUrl) URL.revokeObjectURL(previewFontUrl);
previewFontUrl = url;

let styleTag = document.getElementById('dynamic-font-style');
if (!styleTag) {
styleTag = document.createElement('style');
styleTag.id = 'dynamic-font-style';
document.head.appendChild(styleTag);
}
styleTag.textContent = `@font-face { font-family: 'LiveCustomFont'; src: url('${url}'); }`;
} catch (err) {
console.error('Ошибка обновления шрифта:', err);
}
}

// Создание проверенного бинарного TrueType-шрифта.
function createTrueTypeFontBlob() {
const count = Object.values(glyphData).filter(strokes => strokes && strokes.length).length;
if (!count) throw new Error('Сначала нарисуйте хотя бы один символ.');
if (typeof opentype === 'undefined' || !opentype.Font) throw new Error('Библиотека opentype.js не загрузилась.');
const font = buildOpenTypeFont();
const otfBuffer = font.toArrayBuffer();
if (!otfBuffer || otfBuffer.byteLength < 100) throw new Error('Получен пустой промежуточный OTF.');
const converter = createFont(otfBuffer, {type: 'otf'});
const convertedFontData = converter.get();
if (!convertedFontData['OS/2']) throw new Error('Конвертер не создал обязательную таблицу OS/2.');
if (!convertedFontData.head) throw new Error('Конвертер не создал обязательную таблицу head.');
// fonteditor-core resets head.fontRevision during OTF-to-TTF conversion; set it from the same version string embedded in name ID 5.
convertedFontData.head.fontRevision = getFontRevision(getFontMetadata().version || 'Version 1.000');
// The OTF intermediate does not carry OS/2 weight data through fonteditor-core.
// GlyphFlow exports a Regular static face, so explicitly set the OpenType class.
convertedFontData['OS/2'].usWeightClass = 400;
convertedFontData['OS/2'].usWidthClass = 5;
const rawTtf = converter.write({type: 'ttf', hinting: false, kerning: false});
const ttfBuffer = rawTtf instanceof ArrayBuffer
? rawTtf
: rawTtf.buffer.slice(rawTtf.byteOffset, rawTtf.byteOffset + rawTtf.byteLength);
if (!ttfBuffer || ttfBuffer.byteLength < 100) throw new Error('Конвертер вернул пустой TTF.');
const signature = new Uint8Array(ttfBuffer, 0, 4);
if (signature[0] !== 0 || signature[1] !== 1 || signature[2] !== 0 || signature[3] !== 0) {
throw new Error('Результат не имеет сигнатуру TrueType.');
}
const familyName = (font.getEnglishName('fontFamily') || document.getElementById('fontName').value || 'GlyphFlow')
.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'GlyphFlow';
return {blob: new Blob([ttfBuffer], {type: 'font/ttf'}), fileName: familyName + '-Regular.ttf', familyName};
}
function createGlyphCatalogBlob() {
const entries = Object.entries(glyphData).filter(([, strokes]) => Array.isArray(strokes) && strokes.length > 0);
if (!entries.length) throw new Error('Сначала нарисуйте хотя бы один символ.');
const fontName = document.getElementById('fontName')?.value.trim() || 'GlyphFlow';
const glyphs = entries.map(([character]) => {
const codePoints = [...character].map(value => value.codePointAt(0));
const singleCodePoint = codePoints.length === 1;
const metadata = singleCodePoint ? getGlyphMetadata(character) : null;
const knownUnicodeName = Boolean(metadata?.unicodeName);
return {
character,
codePoint: singleCodePoint ? metadata?.codePoint || null : null,
codePoints: codePoints.map(value => 'U+' + value.toString(16).toUpperCase().padStart(4, '0')),
unicodeName: knownUnicodeName ? metadata.unicodeName : null,
glyphName: singleCodePoint
? (metadata?.glyphName || 'uni' + codePoints[0].toString(16).toUpperCase().padStart(4, '0'))
: 'custom.sequence.' + codePoints.map(value => value.toString(16).toUpperCase()).join('_'),
category: metadata?.category || (singleCodePoint ? 'Символ вне локального каталога' : 'Последовательность символов'),
unicodeGeneralCategory: metadata?.generalCategory || null,
unicodeScript: metadata?.script || null,
description: metadata?.description || (singleCodePoint
? (metadata?.metadataSource?.startsWith('Unicode') ? 'Для этой кодовой точки UCD не публикует обычное имя символа; требуется проверка правил именования.' : 'Официальное имя и описание отсутствуют в локальном каталоге GlyphFlow; требуется проверка по UCD.')
: 'Последовательность из нескольких кодовых точек. Для корректного экспорта требуется отдельное правило лигатуры/последовательности.'),
metadataStatus: metadata?.metadataStatus || (knownUnicodeName ? 'verified-local-catalog' : 'needs-review'),
metadataSource: metadata?.metadataSource || 'GlyphFlow local subset',
combiningClass: metadata?.combiningClass ?? null,
mappingStatus: singleCodePoint ? 'single-code-point' : 'sequence-needs-explicit-mapping',
custom: !singleCodePoint || !metadata
};
});
const catalog = {
schema: 'glyphflow-glyph-catalog/v1',
format: 'GlyphFlow Glyph Catalog',
formatVersion: 1,
fontFamily: fontName,
fontMetadata: getFontMetadata(),
createdAt: new Date().toISOString(),
metadataCatalog: {
name: getLoadedUnicodeVersion() ? 'Unicode Character Database property subset' : 'GlyphFlow bundled local metadata subset',
sources: getLoadedUnicodeVersion() ? {
unicodeData: 'https://www.unicode.org/Public/' + getLoadedUnicodeVersion() + '/ucd/UnicodeData.txt',
scripts: 'https://www.unicode.org/Public/' + getLoadedUnicodeVersion() + '/ucd/Scripts.txt',
license: 'https://www.unicode.org/license.txt'
} : {local: 'src/glyph-metadata.js'},
unicodeDataVersion: getLoadedUnicodeVersion(),
completeness: getLoadedUnicodeVersion() ? 'complete-for-exported-properties' : 'partial',
coverage: getLoadedUnicodeVersion() ? 'Unicode character names, general categories and canonical combining classes from UnicodeData.txt; Script property from Scripts.txt; supported algorithmic names expanded by Unicode rules.' : 'Latin A-Z/a-z, Cyrillic А-Я/а-я including Ё/ё, digits, selected punctuation and SPACE',
notice: getLoadedUnicodeVersion() ? 'This export includes the listed Unicode properties, not every property file in the complete UCD. OpenType glyph naming conventions are a separate layer.' : 'This export does not claim to use the complete Unicode Character Database.'
},
glyphNameConventions: {
latin: 'Adobe Glyph List for New Fonts (AGLFN) conventions where applicable',
otherSingleCodePoints: 'uniXXXX/uXXXXX convention; not an official Unicode glyph-name standard',
sequences: 'custom.sequence with explicit code-point sequence'
},
glyphs
};
const json = JSON.stringify(catalog, null, 2) + '\n';
return {
blob: new Blob([json], {type: 'application/json;charset=utf-8'}),
fileName: fontName.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') + '-glyph-catalog.json'
};
}
function triggerFontDownload(blob, fileName) {
const url = URL.createObjectURL(blob);
const link = document.createElement('a');
link.href = url;
link.download = fileName;
document.body.appendChild(link);
link.click();
link.remove();
window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}
document.getElementById('downloadGlyphCatalogBtn').onclick = () => {
try {
const catalogFile = createGlyphCatalogBlob();
triggerFontDownload(catalogFile.blob, catalogFile.fileName);
} catch (err) {
console.error('Ошибка экспорта каталога глифов:', err);
alert(err.message || 'Не удалось создать паспорт символов.');
}
};

document.getElementById('downloadBtn').onclick = () => {
try {
const fontFile = createTrueTypeFontBlob();
triggerFontDownload(fontFile.blob, fontFile.fileName);
} catch (err) {
console.error('Ошибка экспорта TTF:', err);
alert(err.message || 'Не удалось создать TTF. Проверьте данные глифов и попробуйте ещё раз.');
}
};

// Локальная библиотека хранит бинарные файлы и, для созданных в редакторе шрифтов,
// исходный проект. Используется тот же IndexedDB store, что и автосохранение.
const FONT_LIBRARY_PREFIX = 'font-library:';
const libraryList = document.getElementById('fontLibraryList');
const librarySearch = document.getElementById('fontLibrarySearch');
const libraryStatus = document.getElementById('fontLibraryStatus');
const importFontInput = document.getElementById('importFontInput');
function makeLibraryId() {
return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function describeStorageError(err, fallback = 'ошибка IndexedDB') {
if (err?.name === 'QuotaExceededError') return 'недостаточно места в хранилище устройства.';
if (err?.name === 'SecurityError') return 'браузер запретил доступ к локальному хранилищу.';
return err?.message || fallback;
}

async function libraryTransaction(mode, callback) {
const db = await openDraftDB();
try {
return await new Promise((resolve, reject) => {
const tx = db.transaction(DRAFT_STORE, mode);
let result;
try { result = callback(tx.objectStore(DRAFT_STORE)); }
catch (err) {
try { tx.abort(); } catch {}
reject(err);
return;
}
tx.oncomplete = () => resolve(result);
tx.onerror = () => reject(tx.error);
tx.onabort = () => reject(tx.error || new Error('Операция с библиотекой отменена'));
});
} finally { db.close(); }
}
async function getFontLibraryRecords() {
const db = await openDraftDB();
try {
return await new Promise((resolve, reject) => {
const tx = db.transaction(DRAFT_STORE, 'readonly');
const store = tx.objectStore(DRAFT_STORE);
const request = store.openCursor();
const records = [];
request.onsuccess = () => {
const cursor = request.result;
if (!cursor) return;
if (typeof cursor.key === 'string' && cursor.key.startsWith(FONT_LIBRARY_PREFIX)) records.push(cursor.value);
cursor.continue();
};
request.onerror = () => reject(request.error || new Error('Не удалось прочитать библиотеку шрифтов.'));
tx.oncomplete = () => resolve(records.sort((a,b) => (b.savedAt || 0) - (a.savedAt || 0)));
tx.onerror = () => reject(tx.error || new Error('Ошибка чтения библиотеки шрифтов.'));
tx.onabort = () => reject(tx.error || new Error('Чтение библиотеки шрифтов было прервано.'));
});
} finally { db.close(); }
}
async function saveFontRecord(record) {
await libraryTransaction('readwrite', store => store.put(record, FONT_LIBRARY_PREFIX + record.id));
}
async function saveFontRecords(records) {
await libraryTransaction('readwrite', store => {
for (const record of records) store.put(record, FONT_LIBRARY_PREFIX + record.id);
});
}
function formatFontSize(bytes) {
if (!Number.isFinite(bytes) || bytes < 0) return 'Размер неизвестен';
return bytes < 1024 * 1024 ? Math.max(1, Math.round(bytes / 1024)) + ' КБ' : (bytes / (1024 * 1024)).toFixed(2) + ' МБ';
}
function makeLibraryButton(label, className, onClick) {
const button = document.createElement('button');
button.type = 'button';
button.textContent = label;
button.className = className;
button.addEventListener('click', onClick);
return button;
}
async function downloadLibraryRecord(record) {
try {
if (!(record.blob instanceof Blob) || !Number.isSafeInteger(record.blob.size) ||
record.blob.size < 12 || record.blob.size > MAX_IMPORTED_FONT_BYTES) {
throw new Error('Файл шрифта имеет недопустимый размер или повреждён.');
}
const bytes = await record.blob.arrayBuffer();
parseLibraryFontBytes(bytes, record.format || 'ttf');
triggerFontDownload(record.blob, record.fileName || (record.name + '.' + (record.format || 'ttf')));
} catch (err) {
console.warn('Не удалось скачать запись библиотеки:', err);
if (libraryStatus) libraryStatus.textContent = 'Не удалось скачать «' +
(record.name || 'Без названия') + '»: файл повреждён или не является корректным шрифтом. Запись сохранена в библиотеке.';
}
}
async function renderFontLibrary() {
if (!libraryList) return;
libraryList.replaceChildren();
try {
const storedRecords = await getFontLibraryRecords();
const records = storedRecords.filter(record =>
record && typeof record === 'object' && !Array.isArray(record) &&
typeof record.id === 'string' && record.id.length > 0 &&
typeof record.name === 'string' && record.blob instanceof Blob &&
Number.isSafeInteger(record.blob.size) && record.blob.size >= 1 &&
['ttf', 'otf'].includes(record.format)
);
const damagedCount = storedRecords.length - records.length;
const query = (librarySearch?.value || '').trim().toLocaleLowerCase();
const filtered = records.filter(record => record.name.toLocaleLowerCase().includes(query));
const countLabel = document.getElementById('fontLibraryCount');
if (countLabel) countLabel.textContent = String(records.length);
if (damagedCount > 0 && libraryStatus) {
libraryStatus.textContent = 'Обнаружено повреждённых записей: ' + damagedCount + '. Исправные шрифты доступны; повреждённые данные сохранены и не удалены.';
}
if (!filtered.length) {
const empty = document.createElement('p');
empty.className = 'text-sm text-slate-400 py-5 text-center';
empty.textContent = records.length ? 'По запросу ничего не найдено.' : 'Пока библиотека пуста. Сохраните созданный шрифт или импортируйте TTF/OTF.';
libraryList.appendChild(empty);
return;
}
filtered.forEach(record => {
const card = document.createElement('article');
card.className = 'rounded-lg border border-slate-700 bg-slate-900/70 p-3 flex flex-col gap-2';
const top = document.createElement('div');
top.className = 'flex items-start justify-between gap-3';
const details = document.createElement('div');
details.className = 'min-w-0';
const name = document.createElement('h3');
name.className = 'font-semibold text-slate-100 break-words';
name.textContent = record.name || 'Без названия';
const meta = document.createElement('p');
meta.className = 'text-xs text-slate-400 mt-1';
meta.textContent = (record.format || 'TTF').toUpperCase() + ' · ' + formatFontSize(record.size) + ' · ' + (record.projectSnapshot ? 'проект можно продолжить редактировать' : 'импортированный файл');
details.append(name, meta);
const date = document.createElement('span');
date.className = 'text-[11px] text-slate-500 shrink-0';
date.textContent = record.savedAt ? new Date(record.savedAt).toLocaleDateString() : '';
top.append(details, date);
const actions = document.createElement('div');
actions.className = 'flex flex-wrap gap-2';
actions.appendChild(makeLibraryButton('Скачать', 'rounded-md bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 text-xs font-medium', () => downloadLibraryRecord(record)));
if (record.projectSnapshot) actions.appendChild(makeLibraryButton('Открыть проект', 'rounded-md bg-slate-700 hover:bg-slate-600 px-3 py-1.5 text-xs', async () => {
if (!confirm('Открыть этот проект? Текущая работа останется в автосохранении, но станет активным документом редактора.')) return;
await persistDraft();
try {
restoreProjectSnapshot(record.projectSnapshot);
} catch (err) {
libraryStatus.textContent = 'Проект не открыт: ' + (err.message || 'проверка данных не пройдена') + ' Текущая работа сохранена.';
return;
}
document.getElementById('fontName').value = record.name || 'MyHandwriting';
history = [serializeProjectSnapshot()];
historyIndex = 0;
selectedStrokeIndex = null;
selectedCompoundRing = null;
persistDraft();
renderGrid(); renderCanvas(); updateLiveFont(); updateContourTools();
document.getElementById('editorTop')?.scrollIntoView({behavior:'smooth',block:'start'});
libraryStatus.textContent = 'Открыт проект «' + (record.name || 'Без названия') + '».';
}));
actions.appendChild(makeLibraryButton('Удалить', 'rounded-md bg-rose-950/70 hover:bg-rose-900 text-rose-300 px-3 py-1.5 text-xs', async () => {
if (!confirm('Удалить «' + (record.name || 'Без названия') + '» из библиотеки?')) return;
try {
await libraryTransaction('readwrite', store => store.delete(FONT_LIBRARY_PREFIX + record.id));
libraryStatus.textContent = 'Шрифт удалён из библиотеки.';
await renderFontLibrary();
} catch (err) {
console.error('Не удалось удалить шрифт из библиотеки:', err);
libraryStatus.textContent = 'Не удалось удалить шрифт: ' + describeStorageError(err, 'ошибка IndexedDB');
}
}));
card.append(top, actions);
libraryList.appendChild(card);
});
} catch (err) {
console.error('Не удалось прочитать библиотеку шрифтов:', err);
libraryStatus.textContent = 'Не удалось открыть библиотеку: ' + describeStorageError(err, 'ошибка хранилища');
}
}
document.getElementById('saveToLibraryBtn').addEventListener('click', async () => {
try {
const fontFile = createTrueTypeFontBlob();
const name = (document.getElementById('fontName').value || fontFile.familyName || 'MyHandwriting').trim().slice(0, 64);
const record = {
id: makeLibraryId(), name, format: 'ttf', fileName: name.replace(/[^\p{L}\p{N}._-]+/gu, '_') + '.ttf',
blob: fontFile.blob, size: fontFile.blob.size, savedAt: Date.now(),
projectSnapshot: serializeProjectSnapshot()
};
await saveFontRecord(record);
libraryStatus.textContent = '«' + name + '» сохранён в библиотеку вместе с редактируемым проектом.';
await renderFontLibrary();
} catch (err) {
console.error('Не удалось сохранить шрифт:', err);
libraryStatus.textContent = 'Не удалось сохранить: ' + describeStorageError(err, 'ошибка IndexedDB');
}
});
const MAX_IMPORTED_FONT_BYTES = 20 * 1024 * 1024;
function parseLibraryFontBytes(bytes, format) {
if (!['ttf', 'otf'].includes(format)) throw new Error('Поддерживаются только файлы TTF и OTF.');
if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 12 || bytes.byteLength > MAX_IMPORTED_FONT_BYTES) {
throw new Error('Размер файла шрифта вне допустимых пределов.');
}
const parsed = opentype.parse(bytes.slice(0));
if (!parsed || !parsed.glyphs || !Number.isFinite(parsed.glyphs.length) || parsed.glyphs.length < 1) {
throw new Error('Файл не содержит корректную таблицу глифов.');
}
return parsed;
}
importFontInput.addEventListener('change', async () => {
const files = [...(importFontInput.files || [])];
for (const file of files) {
try {
const extension = /\.(ttf|otf)$/i.exec(file.name)?.[1]?.toLowerCase();
if (!extension) throw new Error('Поддерживаются только файлы TTF и OTF.');
if (file.size > MAX_IMPORTED_FONT_BYTES) throw new Error('Файл шрифта превышает лимит 20 МБ.');
const format = extension;
const buffer = await file.arrayBuffer();
const parsed = parseLibraryFontBytes(buffer, format);
const name = parsed.names?.fontFamily?.en || file.name.replace(/\.(ttf|otf)$/i, '');
const record = {id:makeLibraryId(),name:String(name).slice(0,64),format,fileName:file.name,blob:file.slice(0,file.size),size:file.size,savedAt:Date.now(),projectSnapshot:null};
await saveFontRecord(record);
libraryStatus.textContent = 'Импортирован: ' + record.name;
} catch (err) {
console.warn('Ошибка импорта шрифта:', err);
libraryStatus.textContent = 'Не удалось импортировать «' + file.name + '»: ' + describeStorageError(err, 'файл повреждён или формат не поддерживается.');
}
}
importFontInput.value = '';
await renderFontLibrary();
});
librarySearch.addEventListener('input', renderFontLibrary);
document.getElementById('exportFontLibraryBtn').addEventListener('click', async () => {
try {
const records = await getFontLibraryRecords();
const MAX_BACKUP_BYTES = 40 * 1024 * 1024;
if (records.length > 500) throw new Error('В библиотеке слишком много записей для одной резервной копии.');
let estimatedBackupBytes = new TextEncoder().encode(JSON.stringify({
  format:'GlyphFlowFontLibrary',version:1,exportedAt:new Date().toISOString(),fonts:[]
})).byteLength + 2;
for (const [index, record] of records.entries()) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.name !== 'string' || !record.name.trim() ||
      !(record.blob instanceof Blob)) {
    throw new Error('Запись библиотеки №' + (index + 1) + ' повреждена. Данные сохранены; исправьте запись или восстановите шрифт отдельно.');
  }
  if (record.projectSnapshot !== null && record.projectSnapshot !== undefined &&
      typeof record.projectSnapshot !== 'string') {
    throw new Error('Снимок проекта «' + record.name + '» повреждён. Данные сохранены.');
  }
  if (record.projectSnapshot && record.projectSnapshot.length > MAX_PROJECT_SNAPSHOT_CHARS) {
    throw new Error('Снимок проекта «' + record.name + '» превышает безопасный лимит.');
  }
  const fontBytes = Number(record.blob.size);
  if (!Number.isSafeInteger(fontBytes) || fontBytes < 12 || fontBytes > MAX_IMPORTED_FONT_BYTES) {
    throw new Error('Файл шрифта «' + record.name + '» имеет недопустимый размер.');
  }
  const metadata = {...record, blob:undefined, fontBase64:''};
  estimatedBackupBytes += new TextEncoder().encode(JSON.stringify(metadata)).byteLength +
    Math.ceil(fontBytes / 3) * 4 + 2;
  if (estimatedBackupBytes > MAX_BACKUP_BYTES) {
    throw new Error('Резервная копия превысит лимит 40 МБ. Разделите библиотеку на несколько частей.');
  }
}
const payload = [];
for (const record of records) {
const bytes = new Uint8Array(await record.blob.arrayBuffer());
try {
parseLibraryFontBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), record.format || 'ttf');
} catch (err) {
throw new Error('Шрифт «' + record.name + '» повреждён и не может попасть в резервную копию. Запись сохранена в библиотеке.');
}
let binary = '';
for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
payload.push({...record, blob:undefined, fontBase64:btoa(binary)});
}
const backup = new Blob([JSON.stringify({format:'GlyphFlowFontLibrary',version:1,exportedAt:new Date().toISOString(),fonts:payload})],{type:'application/json'});
if (backup.size > MAX_BACKUP_BYTES) throw new Error('Резервная копия превысила лимит 40 МБ.');
triggerFontDownload(backup,'GlyphFlow-font-library-backup.json');
libraryStatus.textContent = 'Резервная копия библиотеки подготовлена.';
} catch (err) {
libraryStatus.textContent = 'Не удалось создать резервную копию: ' + (err.message || 'ошибка');
}
});
document.getElementById('importLibraryBackupInput').addEventListener('change', async event => {
const file = event.target.files?.[0];
if (!file) return;
try {
if (file.size > 40 * 1024 * 1024) throw new Error('Резервная копия превышает лимит 40 МБ.');
const backup = JSON.parse(await file.text());
if (backup.format !== 'GlyphFlowFontLibrary' || backup.version !== 1 ||
!Array.isArray(backup.fonts) || backup.fonts.length > 500) {
throw new Error('Это не поддерживаемая резервная копия GlyphFlow.');
}
const preparedRecords = [];
for (const item of backup.fonts) {
if (!item || typeof item.fontBase64 !== 'string' || typeof item.name !== 'string' || !item.name.trim()) {
throw new Error('В резервной копии найден некорректный файл шрифта.');
}
if (item.projectSnapshot !== null && item.projectSnapshot !== undefined) {
if (typeof item.projectSnapshot !== 'string') throw new Error('Снимок проекта в резервной копии повреждён.');
if (item.projectSnapshot.length > MAX_PROJECT_SNAPSHOT_CHARS) {
  throw new Error('Снимок проекта в резервной копии превышает безопасный лимит.');
}
const parsedSnapshot = JSON.parse(item.projectSnapshot);
sanitizeProjectModel(parsedSnapshot);
}
if (!['ttf', 'otf'].includes(item.format)) throw new Error('В резервной копии указан неподдерживаемый формат шрифта.');
if (item.fontBase64.length > Math.ceil(MAX_IMPORTED_FONT_BYTES / 3) * 4) throw new Error('Размер файла шрифта вне допустимых пределов.');
const binary = atob(item.fontBase64);
const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
if (!bytes.length || bytes.byteLength > MAX_IMPORTED_FONT_BYTES) throw new Error('Размер файла шрифта вне допустимых пределов.');
const fontBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
parseLibraryFontBytes(fontBuffer, item.format);
const blob = new Blob([bytes],{type:item.format === 'otf' ? 'font/otf' : 'font/ttf'});
preparedRecords.push({...item,blob,fontBase64:undefined,size:blob.size,id:makeLibraryId()});
}
await saveFontRecords(preparedRecords);
libraryStatus.textContent = 'Резервная копия восстановлена.';
} catch (err) {
libraryStatus.textContent = 'Не удалось восстановить библиотеку: ' + describeStorageError(err, 'ошибка формата');
}
event.target.value = '';
await renderFontLibrary();
});
await renderFontLibrary();

// Инициализация
await restoreDraft();
renderGrid();
renderCanvas();
updateLiveFont();
updateContourTools();

// Load official Unicode 18.0.0 metadata in the background. The editor remains
// usable with its bundled fallback if the catalog is unavailable or offline.
loadUnicodeCatalog().then(() => {
  renderGrid();
}).catch(error => {
  console.warn('Official Unicode catalog is unavailable; using the local metadata subset.', error);
});
