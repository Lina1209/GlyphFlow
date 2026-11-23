import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createFont } from 'fonteditor-core';
import { getStroke } from 'perfect-freehand';
import polygonClipping from 'polygon-clipping';
import { getGlyphMetadata, getSingleCodePoint } from '../src/glyph-metadata.js';
import { validateGlyphCatalogAgainstFont } from './font-catalog-validator.mjs';

const require = createRequire(import.meta.url);
const opentype = require('opentype.js');
const moduleSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const helperStartMarker = 'const glyphGeometryCache = new WeakMap();';
const builderStartMarker = 'function buildOpenTypeFont() {';
const endMarker = '// Обновление живого предпросмотра';
const helperStart = moduleSource.indexOf(helperStartMarker);
const builderStart = moduleSource.indexOf(builderStartMarker);
const helperEnd = moduleSource.indexOf('function updateContourTools()', helperStart);
const builderEnd = moduleSource.indexOf(endMarker, builderStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Could not locate glyph geometry helpers in src/main.js');
assert.ok(builderStart >= 0 && builderEnd > builderStart, 'Could not locate buildOpenTypeFont() in src/main.js');
const geometrySource = moduleSource.slice(helperStart, helperEnd);
const builderSource = geometrySource + '\n' + moduleSource.slice(builderStart, builderEnd);

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
  }],
  // Closed loop: exercises a real brush outline around an O-shaped trajectory.
  'О': [{
    points: [[190, 180, 0.5], [180, 135, 0.6], [195, 90, 0.7], [235, 65, 0.7], [280, 75, 0.6], [310, 115, 0.5], [315, 165, 0.6], [290, 210, 0.7], [245, 230, 0.6], [205, 210, 0.5], [190, 180, 0.5]],
    size: 16, thinning: 0.45
  }],
  // Three intersecting brush strokes approximate a handwritten Ж skeleton.
  'Ж': [
    { points: [[250, 45, 0.5], [250, 130, 0.6], [250, 220, 0.5]], size: 16, thinning: 0.45 },
    { points: [[165, 65, 0.5], [205, 125, 0.6], [250, 175, 0.5], [295, 125, 0.6], [335, 65, 0.5]], size: 16, thinning: 0.45 },
    { points: [[165, 235, 0.5], [205, 185, 0.6], [250, 140, 0.5], [295, 185, 0.6], [335, 235, 0.5]], size: 16, thinning: 0.45 }
  ],
  // An explicitly assigned inner contour must keep opposite winding after TTF conversion.
  'Р': [
    // A solid outer capsule and a smaller inner capsule provide a true subtraction fixture.
    { points: [[80, 180, 0.5], [280, 180, 0.5]], size: 36, thinning: 0.35, role: 'outer' },
    { points: [[150, 180, 0.5], [210, 180, 0.5]], size: 8, thinning: 0.3, role: 'hole' }
  ],
  // Two separate counters must remain independent after subtraction.
  'Ф': [
    { points: [[80, 180, 0.5], [280, 180, 0.5]], size: 36, thinning: 0.35, role: 'outer' },
    { points: [[120, 180, 0.5], [140, 180, 0.5]], size: 8, thinning: 0.3, role: 'hole' },
    { points: [[220, 180, 0.5], [240, 180, 0.5]], size: 8, thinning: 0.3, role: 'hole' }
  ],
  // Four explicit depth levels must survive the real perfect-freehand -> OTF -> TTF pipeline.
  'Ы': [
    { points: [[90, 180, 0.5], [270, 180, 0.5]], size: 40, thinning: 0.35, depth: 0 },
    { points: [[110, 180, 0.5], [250, 180, 0.5]], size: 26, thinning: 0.35, depth: 1 },
    { points: [[130, 180, 0.5], [230, 180, 0.5]], size: 14, thinning: 0.35, depth: 2 },
    { points: [[145, 180, 0.5], [215, 180, 0.5]], size: 6, thinning: 0.35, depth: 3 }
  ],
  // A self-crossing figure-eight trajectory probes outline stability at crossings.
  '∞': [{
    points: [[150, 150, 0.5], [180, 105, 0.6], [225, 105, 0.6], [255, 150, 0.5], [285, 195, 0.6], [330, 195, 0.6], [360, 150, 0.5], [330, 105, 0.6], [285, 105, 0.6], [255, 150, 0.5], [225, 195, 0.6], [180, 195, 0.6], [150, 150, 0.5]],
    size: 14, thinning: 0.45
  }]
};
const context = {
  opentype,
  glyphData,
  compoundOverrides: {},
  getStroke,
  polygonClipping,
  getGlyphMetadata,
  getSingleCodePoint,
  getFontMetadata: () => ({
    designer: 'GlyphFlow Test Designer',
    manufacturer: 'GlyphFlow Test Foundry',
    version: 'Version 2.125',
    description: 'Metadata regression fixture',
    copyright: 'Copyright 2026 GlyphFlow Test',
    trademark: 'GlyphFlow Test Mark',
    license: 'Test license text, not a real grant',
    licenseURL: 'https://example.com/license',
    designerURL: 'https://example.com/designer',
    manufacturerURL: 'https://example.com/foundry'
  }),
  document: { getElementById: id => ({ value: ({
    fontName: 'GlyphFlow CI Fixture',
    fontDesigner: 'GlyphFlow Test Designer',
    fontManufacturer: 'GlyphFlow Test Foundry',
    fontVersion: 'Version 2.125',
    fontDescription: 'Metadata regression fixture',
    fontCopyright: 'Copyright 2026 GlyphFlow Test',
    fontTrademark: 'GlyphFlow Test Mark',
    fontLicense: 'Test license text, not a real grant',
    fontLicenseURL: 'https://example.com/license',
    fontDesignerURL: 'https://example.com/designer',
    fontManufacturerURL: 'https://example.com/foundry'
  })[id] || '' }) }
};
vm.runInNewContext(builderSource + '\nthis.buildOpenTypeFont = buildOpenTypeFont;', context);
const generated = context.buildOpenTypeFont();

// The real font builder must fail closed for a multi-code-point glyph key,
// rather than silently mapping only the first scalar into cmap.
glyphData['A\\u0301'] = [{
  points: [[18, 320, 0.5], [22, 270, 0.6], [35, 220, 0.7], [52, 170, 0.8]],
  size: 18, thinning: 0.5
}];
assert.throws(
  () => context.buildOpenTypeFont(),
  /нескольких кодовых точек/,
  'Multi-code-point sequences must require an explicit ligature/mapping rule'
);
delete glyphData['A\\u0301'];
const bytes = generated.toArrayBuffer();
assert.ok(bytes instanceof ArrayBuffer && bytes.byteLength > 100, 'Font serialization returned an empty buffer');
writeFileSync('/tmp/glyphflow-fixture.otf', Buffer.from(bytes));

assert.equal(Buffer.from(bytes).toString('ascii', 0, 4), 'OTTO', 'Expected OpenType/CFF signature');
const parsed = opentype.parse(bytes);
assert.equal(parsed.outlinesFormat, 'cff', 'opentype.js should identify CFF outlines');
assert.equal(parsed.unitsPerEm, 1000);
assert.equal(parsed.ascender, 950);
assert.equal(parsed.descender, -370);
assert.equal(parsed.names.designer.en, 'GlyphFlow Test Designer');
assert.equal(parsed.names.manufacturer.en, 'GlyphFlow Test Foundry');
assert.equal(parsed.names.version.en, 'Version 2.125');
assert.equal(parsed.names.description.en, 'Metadata regression fixture');
assert.equal(parsed.names.copyright.en, 'Copyright 2026 GlyphFlow Test');
assert.equal(parsed.names.trademark.en, 'GlyphFlow Test Mark');
assert.equal(parsed.names.license.en, 'Test license text, not a real grant');
assert.equal(parsed.names.licenseURL.en, 'https://example.com/license');
assert.equal(parsed.names.designerURL.en, 'https://example.com/designer');
assert.equal(parsed.names.manufacturerURL.en, 'https://example.com/foundry');

const notdef = parsed.glyphs.get(0);
assert.equal(notdef.name, '.notdef', 'Glyph zero must be .notdef');
assert.equal(parsed.charToGlyph(' ').advanceWidth, 350, 'Space advance width must be preserved');
assert.equal(parsed.charToGlyph('A').name, 'A', 'Latin glyph should use its standard AGLFN glyph name');
assert.equal(parsed.charToGlyph('Ё').name, 'uni0401', 'Cyrillic glyph should use its stable Unicode glyph name');
assert.equal(parsed.charToGlyph('😀').name, 'u1F600', 'Supplementary-plane glyph should use a full code-point glyph name');

for (const char of ['A', 'Ё', '😀', 'О', 'Ж', 'Р', 'Ф', 'Ы', '∞']) {
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
const convertedFontData = converted.get();
assert.ok(convertedFontData['OS/2'], 'OTF-to-TTF conversion must expose the OS/2 table');
assert.ok(convertedFontData.head, 'OTF-to-TTF conversion must expose the head table');
const versionMatch = context.getFontMetadata().version.match(/(\d+(?:\.\d{1,3})?)/);
convertedFontData.head.fontRevision = versionMatch ? Number(versionMatch[1]) : 1;
convertedFontData['OS/2'].usWeightClass = 400;
convertedFontData['OS/2'].usWidthClass = 5;
convertedFontData['OS/2'].fsSelection = (convertedFontData['OS/2'].fsSelection || 0) | 0x0100;
assert.ok(convertedFontData['OS/2'].fsSelection & 0x0100, 'Regular static export must declare WWS conformance');
const ttfBytes = Buffer.from(converted.write({type: 'ttf', hinting: false, kerning: false}));
assert.ok(ttfBytes.length > 100, 'OTF-to-TTF conversion returned an empty buffer');
assert.equal(ttfBytes.toString('hex', 0, 4), '00010000', 'Expected TrueType sfnt signature');
writeFileSync('/tmp/glyphflow-fixture.ttf', ttfBytes);
const ttfArrayBuffer = ttfBytes.buffer.slice(ttfBytes.byteOffset, ttfBytes.byteOffset + ttfBytes.byteLength);
const reparsedTtf = opentype.parse(ttfArrayBuffer);
// The TrueType cmap is the authoritative character-to-glyph mapping. A TTF post table may use format 3.0 and omit glyph names; human-readable descriptions therefore belong in the publication sidecar/catalog, not in a claim that every TTF reader exposes glyph names.
assert.equal(reparsedTtf.outlinesFormat, 'truetype', 'Converted font must use TrueType outlines');
assert.equal(reparsedTtf.names.designer.en, 'GlyphFlow Test Designer', 'TTF conversion must preserve designer metadata');
assert.equal(reparsedTtf.names.manufacturer.en, 'GlyphFlow Test Foundry', 'TTF conversion must preserve manufacturer metadata');
assert.equal(reparsedTtf.names.version.en, 'Version 2.125', 'TTF conversion must preserve version metadata');
assert.equal(reparsedTtf.names.description.en, 'Metadata regression fixture', 'TTF conversion must preserve description metadata');
assert.equal(reparsedTtf.names.license.en, 'Test license text, not a real grant', 'TTF conversion must preserve license metadata');
assert.equal(reparsedTtf.names.licenseURL.en, 'https://example.com/license', 'TTF conversion must preserve license URL metadata');
assert.equal(reparsedTtf.charToGlyph('A').unicode, 65);
assert.equal(reparsedTtf.charToGlyph('Ё').unicode, 0x401);
assert.equal(reparsedTtf.charToGlyph('😀').unicode, 0x1F600);
assert.equal(reparsedTtf.charToGlyph('О').unicode, 0x41E);
assert.equal(reparsedTtf.charToGlyph('Ж').unicode, 0x416);
assert.equal(reparsedTtf.charToGlyph('Р').unicode, 0x420);
assert.equal(reparsedTtf.charToGlyph('Ф').unicode, 0x424);

assert.equal(reparsedTtf.charToGlyph('∞').unicode, 0x221E);

// Reconcile the glyph passport against the actual converted TTF cmap, not
// merely against the editor's in-memory glyph data.
const exportedCatalog = Object.keys(glyphData).map(character => ({
  character,
  codePoint: 'U+' + character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
}));
const passportCheck = validateGlyphCatalogAgainstFont(reparsedTtf, exportedCatalog);
assert.equal(passportCheck.valid, true, passportCheck.errors.join('\\n'));
assert.equal(passportCheck.mappedGlyphs, exportedCatalog.length);
const incompletePassport = exportedCatalog.filter(entry => entry.character !== 'Ж');
const incompleteCheck = validateGlyphCatalogAgainstFont(reparsedTtf, incompletePassport);
assert.equal(incompleteCheck.valid, false, 'Passport validation must detect exported glyphs missing from the catalog');
assert.ok(incompleteCheck.errors.some(error => error.includes('absent from the glyph catalog')));
const sequenceCheck = validateGlyphCatalogAgainstFont(reparsedTtf, [
  ...exportedCatalog,
  {character: 'A\\u0301', codePoint: null}
]);
assert.equal(sequenceCheck.valid, false, 'Unmapped multi-code-point sequences must fail passport validation');
assert.ok(sequenceCheck.errors.some(error => error.includes('multi-code-point')));

assert.equal(reparsedTtf.charToGlyph('Ё').path.commands.filter(command => command.type === 'M').length, 2,
  'TTF conversion must preserve multi-contour glyphs');
for (const char of ['О', '∞']) {
  const glyph = reparsedTtf.charToGlyph(char);
  assert.ok(glyph.path.commands.filter(command => command.type === 'M').length >= 1,
    `Closed/self-crossing glyph ${char} must retain an outline`);
  assert.ok(glyph.path.commands.filter(command => command.type === 'Z').length >= 1,
    `Closed/self-crossing glyph ${char} must retain closed contours`);
}
assert.equal(reparsedTtf.charToGlyph('Р').path.commands.filter(command => command.type === 'M').length, 2,
  'Outer contour and explicit hole must survive TTF conversion');
assert.equal(reparsedTtf.charToGlyph('Ж').path.commands.filter(command => command.type === 'M').length, 1,
  'Three intersecting brush strokes must be Boolean-unioned into one outline contour');
assert.equal(reparsedTtf.charToGlyph('∞').path.commands.filter(command => command.type === 'M').length, 2,
  'The self-crossing figure-eight must resolve into two non-overlapping filled lobes');
assert.equal(reparsedTtf.charToGlyph('Ф').path.commands.filter(command => command.type === 'M').length, 3,
  'Two independent holes must survive Boolean subtraction as two inner contours');
assert.equal(reparsedTtf.charToGlyph('Ы').path.commands.filter(command => command.type === 'M').length, 4,
  'Four nested depth levels must survive TTF conversion as outer, hole, island and nested hole');

// Unicode metadata regression checks: official names, glyph naming conventions and scalar safety.
const cyrillicUpper = [...'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'];
const cyrillicLower = [...'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'];
assert.equal(cyrillicUpper.length, 33, 'Cyrillic uppercase catalog must contain 33 letters');
assert.equal(cyrillicLower.length, 33, 'Cyrillic lowercase catalog must contain 33 letters');
for (const [upper, lower] of cyrillicUpper.map((char, index) => [char, cyrillicLower[index]])) {
  const upperMetadata = getGlyphMetadata(upper);
  const lowerMetadata = getGlyphMetadata(lower);
  assert.ok(upperMetadata && lowerMetadata, `Missing Cyrillic metadata for ${upper}/${lower}`);
  assert.equal(upperMetadata.codePoint, 'U+' + upper.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
  assert.equal(lowerMetadata.codePoint, 'U+' + lower.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
  assert.equal(upperMetadata.generalCategory, 'Lu');
  assert.equal(lowerMetadata.generalCategory, 'Ll');
  assert.equal(upperMetadata.script, 'Cyrillic');
  assert.equal(lowerMetadata.script, 'Cyrillic');
  assert.equal(upperMetadata.glyphName, 'uni' + upperMetadata.codePoint.slice(2));
  assert.equal(lowerMetadata.glyphName, 'uni' + lowerMetadata.codePoint.slice(2));
}
assert.equal(getGlyphMetadata('Ё').unicodeName, 'CYRILLIC CAPITAL LETTER IO');
assert.equal(getGlyphMetadata('ё').unicodeName, 'CYRILLIC SMALL LETTER IO');
assert.equal(getGlyphMetadata('Й').unicodeName, 'CYRILLIC CAPITAL LETTER SHORT I');
assert.equal(getGlyphMetadata('й').unicodeName, 'CYRILLIC SMALL LETTER SHORT I');
assert.equal(getGlyphMetadata('A').glyphName, 'A');
assert.equal(getGlyphMetadata('a').glyphName, 'a');
assert.equal(getGlyphMetadata('0').unicodeName, 'DIGIT ZERO');
assert.equal(getGlyphMetadata(' ').unicodeName, 'SPACE');
assert.equal(getSingleCodePoint('A'), 0x41);
assert.equal(getSingleCodePoint('😀'), 0x1F600, 'Supplementary-plane Unicode scalar must be accepted');
assert.equal(getSingleCodePoint('A\\u0301'), null, 'Combining sequences must not be silently reduced to one scalar');
assert.equal(getSingleCodePoint(''), null);
assert.equal(getSingleCodePoint('AB'), null);
assert.equal(getSingleCodePoint('\\uD800'), null, 'Unpaired surrogate must not be accepted as a Unicode scalar');
assert.equal(getSingleCodePoint(null), null);
assert.equal(getGlyphMetadata('😀').glyphName, 'u1F600');
assert.equal(getGlyphMetadata('🜁').unicodeName, null, 'Unknown official Unicode names must not be invented');
assert.equal(getGlyphMetadata('🜁').generalCategory, 'Unknown');

console.log('GlyphFlow font pipeline passed: real perfect-freehand curves, closed loop, explicit hole subtraction, Boolean union of intersecting brush strokes, self-crossing trajectory, OTF-to-TTF conversion, Unicode and multi-contour preservation.');
