import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createFont } from 'fonteditor-core';
import { getStroke } from 'perfect-freehand';

const require = createRequire(import.meta.url);
const opentype = require('opentype.js');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const startMarker = 'function buildOpenTypeFont() {';
const endMarker = '// Обновление живого предпросмотра';
const start = html.indexOf(startMarker);
const end = html.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start, 'Could not locate buildOpenTypeFont() in index.html');
const builderSource = html.slice(start, end);

const rectangle = (x1, y1, x2, y2) => [
  [x1, y1], [x2, y1], [x2, y2], [x1, y2]
];
const glyphData = {
  // Curved multi-sample strokes exercise the actual perfect-freehand outline generator.
  A: [{
    points: [[18, 320, 0.5], [22, 270, 0.6], [35, 220, 0.7], [52, 170, 0.8], [72, 120, 0.7], [90, 80, 0.5]],
    size: 18, thinning: 0.5
  }],
  Ё: [
    { points: [[100, 120, 0.4], [120, 90, 0.6], [145, 75, 0.5], [170, 90, 0.4]], size: 16, thinning: 0.4 },
    { points: [[115, 45, 0.5], [120, 35, 0.5], [125, 45, 0.5]], size: 8, thinning: 0.4 }
  ],
  '😀': [{
    points: [[210, 180, 0.5], [230, 145, 0.6], [265, 130, 0.7], [300, 145, 0.6], [320, 180, 0.5], [300, 215, 0.6], [265, 230, 0.7], [230, 215, 0.6], [210, 180, 0.5]],
    size: 14, thinning: 0.5
  }]
};
const context = {
  opentype,
  glyphData,
  getStroke,
  document: { getElementById: id => ({ value: id === 'fontName' ? 'GlyphFlow CI Fixture' : '' }) }
};
vm.runInNewContext(builderSource + '\nthis.buildOpenTypeFont = buildOpenTypeFont;', context);
const generated = context.buildOpenTypeFont();
const bytes = generated.toArrayBuffer();
assert.ok(bytes instanceof ArrayBuffer && bytes.byteLength > 100, 'Font serialization returned an empty buffer');
writeFileSync('/tmp/glyphflow-fixture.otf', Buffer.from(bytes));

assert.equal(Buffer.from(bytes).toString('ascii', 0, 4), 'OTTO', 'Expected OpenType/CFF signature');
const parsed = opentype.parse(bytes);
assert.equal(parsed.outlinesFormat, 'cff', 'opentype.js should identify CFF outlines');
assert.equal(parsed.unitsPerEm, 1000);
assert.equal(parsed.ascender, 900);
assert.equal(parsed.descender, -300);

const notdef = parsed.glyphs.get(0);
assert.equal(notdef.name, '.notdef', 'Glyph zero must be .notdef');
assert.equal(parsed.charToGlyph(' ').advanceWidth, 350, 'Space advance width must be preserved');

for (const char of ['A', 'Ё', '😀']) {
  const glyph = parsed.charToGlyph(char);
  assert.ok(glyph && glyph.index > 0, `Missing cmap entry for ${char}`);
  assert.equal(glyph.unicode, char.codePointAt(0), `Incorrect Unicode mapping for ${char}`);
  assert.ok(glyph.advanceWidth > 0, `Invalid advance width for ${char}`);
  assert.ok(glyph.path.commands.length >= 5, `Missing outline commands for ${char}`);
  for (const command of glyph.path.commands) {
    for (const value of Object.values(command)) {
      if (typeof value === 'number') assert.ok(Number.isFinite(value), `Non-finite path value in ${char}`);
    }
  }
}
assert.equal(parsed.charToGlyph('Ё').path.commands.filter(command => command.type === 'M').length, 2,
  'Multi-stroke glyph should retain both contours');

// opentype.js emits CFF/OTF. Convert it to a genuine TrueType font for the
// product's promised .ttf export, then parse that binary independently again.
const converted = createFont(bytes, {type: 'otf'});
const ttfBytes = Buffer.from(converted.write({type: 'ttf', hinting: false, kerning: false}));
assert.ok(ttfBytes.length > 100, 'OTF-to-TTF conversion returned an empty buffer');
assert.equal(ttfBytes.toString('hex', 0, 4), '00010000', 'Expected TrueType sfnt signature');
writeFileSync('/tmp/glyphflow-fixture.ttf', ttfBytes);
const ttfArrayBuffer = ttfBytes.buffer.slice(ttfBytes.byteOffset, ttfBytes.byteOffset + ttfBytes.byteLength);
const reparsedTtf = opentype.parse(ttfArrayBuffer);
assert.equal(reparsedTtf.outlinesFormat, 'truetype', 'Converted font must use TrueType outlines');
assert.equal(reparsedTtf.charToGlyph('A').unicode, 65);
assert.equal(reparsedTtf.charToGlyph('Ё').unicode, 0x401);
assert.equal(reparsedTtf.charToGlyph('😀').unicode, 0x1F600);
assert.equal(reparsedTtf.charToGlyph('Ё').path.commands.filter(command => command.type === 'M').length, 2,
  'TTF conversion must preserve multi-contour glyphs');

console.log('GlyphFlow font pipeline passed: opentype.js OTF generation + fonteditor-core OTF-to-TTF conversion + TrueType reparse + Unicode + multi-contour glyph.');
