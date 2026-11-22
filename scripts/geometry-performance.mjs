import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { getStroke } from 'perfect-freehand';
import polygonClipping from 'polygon-clipping';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const startMarker = 'const glyphGeometryCache = new WeakMap();';
const endMarker = 'function updateContourTools()';
const start = html.indexOf(startMarker);
const end = html.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start, 'Could not extract the live geometry pipeline');

const context = { getStroke, polygonClipping };
vm.runInNewContext(
  html.slice(start, end) +
  '\nthis.getCompoundGlyphGeometry = getCompoundGlyphGeometry;' +
  '\nthis.getCompoundPathRecords = getCompoundPathRecords;' +
  '\nthis.multiPolygonArea = multiPolygonArea;',
  context
);

const makeStroke = (strokeIndex, count, depth = 0) => {
  const points = [];
  const centerX = 90 + (strokeIndex % 8) * 27;
  const centerY = 90 + Math.floor(strokeIndex / 8) * 27;
  for (let index = 0; index < count; index++) {
    const t = index / (count - 1);
    points.push([
      centerX + t * 36,
      centerY + Math.sin(t * Math.PI * 4 + strokeIndex * 0.37) * 7 + Math.cos(t * Math.PI * 9) * 1.5,
      0.35 + 0.3 * ((index % 7) / 6)
    ]);
  }
  return {points, size: 12 + strokeIndex % 5, thinning: 0.35, depth};
};
const validate = (geometry, label) => {
  assert.ok(Array.isArray(geometry), label + ': expected MultiPolygon output');
  for (const polygon of geometry) for (const ring of polygon) {
    assert.ok(ring.length >= 4, label + ': degenerate ring');
    for (const point of ring) {
      assert.ok(Number.isFinite(point[0]) && Number.isFinite(point[1]), label + ': non-finite geometry');
    }
  }
  assert.ok(context.multiPolygonArea(geometry) > 0, label + ': geometry unexpectedly empty');
};
const timed = (label, strokes) => {
  const before = process.memoryUsage().heapUsed;
  const startTime = performance.now();
  const geometry = context.getCompoundGlyphGeometry(strokes);
  const elapsed = performance.now() - startTime;
  validate(geometry, label);
  const records = context.getCompoundPathRecords(geometry);
  assert.ok(records.length > 0, label + ': no exportable contours');
  const after = process.memoryUsage().heapUsed;
  const cachedStart = performance.now();
  assert.strictEqual(context.getCompoundGlyphGeometry(strokes), geometry, label + ': cache did not reuse geometry');
  const cachedMs = performance.now() - cachedStart;
  console.log(JSON.stringify({
    fixture: label,
    strokes: strokes.length,
    inputPoints: strokes.reduce((sum, stroke) => sum + stroke.points.length, 0),
    outputContours: records.length,
    computeMs: Number(elapsed.toFixed(2)),
    cacheHitMs: Number(cachedMs.toFixed(3)),
    heapDeltaMiB: Number(((after - before) / 1048576).toFixed(2))
  }));
  return elapsed;
};

const dense = timed('single-dense-trajectory-512', [makeStroke(0, 512)]);
const multi = timed('32-overlapping-strokes', Array.from({length: 32}, (_, index) => makeStroke(index, 32)));
const nestedStrokes = Array.from({length: 32}, (_, index) => {
  const depth = Math.floor(index / 8);
  const stroke = makeStroke(index % 8, 28, depth);
  stroke.size = 18 - depth * 4;
  stroke.depth = depth;
  return stroke;
});
const nested = timed('four-depth-32-contours', nestedStrokes);


// Larger trajectories: measure actual input-size scaling before choosing product limits.
const large2k = timed('single-dense-trajectory-2000', [makeStroke(0, 2000)]);
const large5k = timed('single-dense-trajectory-5000', [makeStroke(0, 5000)]);
const large10k = timed('single-dense-trajectory-10000', [makeStroke(0, 10000)]);

// Many short, overlapping strokes exercise the union path with higher object counts.
const strokes64 = timed('64-overlapping-strokes', Array.from(
  {length: 64}, (_, index) => makeStroke(index, 16)
));
const strokes128 = timed('128-overlapping-strokes', Array.from(
  {length: 128}, (_, index) => makeStroke(index, 16)
));

const totalMs = dense + multi + nested + large2k + large5k + large10k + strokes64 + strokes128;
console.log(JSON.stringify({summary: 'GlyphFlow geometry performance smoke passed', totalComputeMs: Number(totalMs.toFixed(2))}));
assert.ok(totalMs < 90000, 'Geometry stress exceeded the generous 90-second CI budget');
