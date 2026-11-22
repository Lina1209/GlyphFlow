import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { getStroke } from 'perfect-freehand';
import polygonClipping from 'polygon-clipping';

const require = createRequire(import.meta.url);
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const startMarker = 'const glyphGeometryCache = new WeakMap();';
const endMarker = 'function updateContourTools()';
const start = html.indexOf(startMarker);
const end = html.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start, 'Could not extract the live geometry pipeline');

const context = { getStroke, polygonClipping };
vm.runInNewContext(
  html.slice(start, end) +
  '\nthis.getCompoundGlyphGeometry = getCompoundGlyphGeometry;
this.buildNestedContourGeometry = buildNestedContourGeometry;' +
  '\nthis.getCompoundPathRecords = getCompoundPathRecords;' +
  '\nthis.getStrokeOutline = getStrokeOutline;' +
  '\nthis.multiPolygonArea = multiPolygonArea;' +
  '\nthis.cleanPolygonRing = cleanPolygonRing;' +
  '\nthis.segmentsIntersect = segmentsIntersect;' +
  '\nthis.isHoleWithinOuterBounds = isHoleWithinOuterBounds;',
  context
);

const stroke = (points, size, role = 'outer') => ({
  points: points.map(([x, y]) => [x, y, 0.5]),
  size,
  thinning: 0,
  role
});
const area = geometry => context.multiPolygonArea(geometry);
const assertFiniteGeometry = (geometry, label) => {
  assert.ok(Array.isArray(geometry), label + ': expected a multipolygon array');
  for (const polygon of geometry) {
    for (const ring of polygon) {
      assert.ok(ring.length >= 4, label + ': every output ring must be closed and non-degenerate');
      for (const point of ring) {
        assert.ok(Number.isFinite(point[0]) && Number.isFinite(point[1]), label + ': non-finite coordinate');
      }
    }
  }
};

// A narrow connecting stroke must preserve a single connected glyph component.
const narrowBridge = [
  stroke([[110, 95], [110, 265]], 22),
  stroke([[250, 95], [250, 265]], 22),
  stroke([[120, 180], [240, 180]], 3)
];
const bridged = context.getCompoundGlyphGeometry(narrowBridge);
assertFiniteGeometry(bridged, 'narrow bridge');
assert.equal(bridged.length, 1, 'A deliberately connected narrow bridge must remain one component');
assert.ok(area(bridged) > 1000, 'Narrow bridge must retain a positive filled area');

// A sub-pixel gap must not be silently closed by the Boolean union.
const nearTouching = [
  stroke([[90, 140], [270, 140]], 18),
  stroke([[90, 158.5], [270, 158.5]], 18)
];
const separated = context.getCompoundGlyphGeometry(nearTouching);
assertFiniteGeometry(separated, 'near-touching strokes');
assert.equal(separated.length, 2, 'A real gap between strokes must remain two components');

// Repeated and almost coincident input samples must not produce NaN/Infinity or crash.
const repeatedSamples = [
  stroke([[100, 100], [100, 100], [100.000001, 100.000001], [180, 160], [180, 160]], 12)
];
const repeatedOutline = context.getStrokeOutline(repeatedSamples[0]);
assert.ok(repeatedOutline.length >= 3, 'Repeated samples should still produce a usable brush outline');
for (const point of repeatedOutline) {
  assert.ok(Number.isFinite(point[0]) && Number.isFinite(point[1]), 'Repeated samples produced non-finite outline coordinates');
}
const repeatedGeometry = context.getCompoundGlyphGeometry(repeatedSamples);
assertFiniteGeometry(repeatedGeometry, 'repeated samples');
assert.ok(area(repeatedGeometry) > 0, 'Repeated samples must retain a non-zero glyph area');

// A microscopic stroke is below the meaningful geometric tolerance and must be discarded safely.
const microscopic = [stroke([[100, 100], [100.0000001, 100.0000001]], 0.000001)];
const microscopicGeometry = context.getCompoundGlyphGeometry(microscopic);
assertFiniteGeometry(microscopicGeometry, 'microscopic stroke');
assert.equal(area(microscopicGeometry), 0, 'Microscopic geometry must not create a phantom glyph');

// A hole touching the outer boundary is not a valid counter.
const touchingHole = [
  stroke([[100, 100], [260, 100]], 40, 'outer'),
  stroke([[84, 100], [130, 100]], 8, 'hole')
];
const touchingHoleOutline = context.getStrokeOutline(touchingHole[1]);
const cleanedHole = context.cleanPolygonRing(touchingHoleOutline);
const outerUnion = polygonClipping.union([context.cleanPolygonRing(context.getStrokeOutline(touchingHole[0]))]);
const outside = polygonClipping.difference([[cleanedHole]], outerUnion);
assert.ok(area(outside) <= 1e-4, 'Boundary-touching sample should be within the outer filled region before edge test');
let boundaryCrossing = false;
for (const polygon of outerUnion) {
  for (const boundary of polygon) {
    for (let i = 0; i < cleanedHole.length; i++) {
      for (let j = 0; j < boundary.length; j++) {
        if (context.segmentsIntersect(cleanedHole[i], cleanedHole[(i + 1) % cleanedHole.length],
          boundary[j], boundary[(j + 1) % boundary.length])) boundaryCrossing = true;
      }
    }
  }
}
assert.ok(boundaryCrossing, 'Boundary-touching counter fixture must actually intersect the outer boundary');
assert.equal(context.isHoleWithinOuterBounds(touchingHole[1], touchingHole, 1), false,
  'The live hole validator must reject a counter that touches the outer boundary');


// Explicit nested topology: outer -> counter -> island -> nested counter.
const rect = (x1, y1, x2, y2) => [[x1,y1],[x2,y1],[x2,y2],[x1,y2],[x1,y1]];
const nested = context.buildNestedContourGeometry([
  { depth: 0, ring: rect(0, 0, 100, 100) },
  { depth: 1, ring: rect(20, 20, 80, 80) },
  { depth: 2, ring: rect(35, 35, 65, 65) },
  { depth: 3, ring: rect(43, 43, 57, 57) }
]);
assertFiniteGeometry(nested, 'four-level nested topology');
assert.equal(nested.length, 2, 'An island inside a counter is represented as a separate filled component');
assert.ok(Math.abs(area(nested) - 7104) < 1e-5,
  'Nested fill must alternate add/subtract at every depth');
const nestedRecords = context.getCompoundPathRecords(nested);
assert.equal(nestedRecords.length, 4, 'Nested topology must preserve four boundary rings');
assert.deepEqual(nestedRecords.map(record => record.role), ['outer', 'hole', 'outer', 'hole'],
  'Nested rings must alternate outer/hole winding for TrueType non-zero fill');

console.log('GlyphFlow geometry edge cases passed: narrow bridges, near-touching gaps, repeated samples, microscopic rejection, boundary-touching counters, and four-level nested topology.');
