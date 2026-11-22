import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

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
  A: [{ points: rectangle(10, 20, 40, 60), size: 12, thinning: 0.5 }],
  Ё: [
    { points: rectangle(10, 20, 40, 60), size: 12, thinning: 0.5 },
    { points: rectangle(15, 5, 22, 12), size: 8, thinning: 0.4 }
  ],
  '😀': [{ points: rectangle(5, 15, 45, 55), size: 10, thinning: 0.5 }]
};
const context = {
  opentype,
  glyphData,
  getStroke: points => points,
  document: { getElementById: id => ({ value: id === 'fontName' ? 'GlyphFlow CI Fixture' : '' }) }
};
vm.runInNewContext(builderSource + '\nthis.buildOpenTypeFont = buildOpenTypeFont;', context);
const generated = context.buildOpenTypeFont();
const bytes = generated.toArrayBuffer();
assert.ok(bytes instanceof ArrayBuffer && bytes.byteLength > 100, 'Font serialization returned an empty buffer');

const parsed = opentype.parse(bytes);
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

console.log('GlyphFlow TTF smoke test passed: serialize + parse + metrics + .notdef + space + BMP/supplementary Unicode + multi-contour glyph.');
