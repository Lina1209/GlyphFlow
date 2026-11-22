import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const openTag = '<script type="module">';
const start = html.indexOf(openTag);
const end = html.indexOf('</script>', start + openTag.length);
assert.ok(start >= 0 && end > start, 'Expected one inline ES module');
assert.equal(html.indexOf(openTag, start + openTag.length), -1, 'Expected exactly one inline ES module');
const moduleSource = html.slice(start + openTag.length, end);

const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], {
  input: moduleSource,
  encoding: 'utf8'
});
assert.equal(syntax.status, 0, `Inline module syntax check failed:\n${syntax.stderr || syntax.stdout}`);

const requiredContracts = [
  ['primary pointer guard', 'if (!e.isPrimary || isDrawing) return;'],
  ['active pointer filtering', 'e.pointerId !== activePointerId'],
  ['pointer cancellation', "addEventListener('pointercancel'"],
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
  ['TrueType contour winding normalization', 'if (signedArea > 0) mapped.reverse();'],
  ['OpenType preview MIME type', "type: 'font/otf'"],
  ['TrueType export MIME type', "type: 'font/ttf'"],
  ['OTF-to-TTF conversion import', "import { createFont } from 'https://esm.sh/fonteditor-core@2.6.3';"],
  ['OTF parsing before conversion', "createFont(otfBuffer, {type: 'otf'})"],
  ['TrueType output conversion', "converter.write({type: 'ttf', hinting: false, kerning: false})"],
  ['TrueType sfnt signature validation', 'signature[1] !== 1'],
  ['honest TrueType download extension', "link.download = familyName + '-Regular.ttf';"],
  ['download uses a user-triggered anchor', 'link.click();'],
  ['vertical ascender metric covers canvas top', 'const ascender = 900;'],
  ['vertical descender metric covers canvas bottom', 'const descender = -300;'],
  ['full Unicode code point mapping', 'char.codePointAt(0)'],
  ['supplementary-plane glyph naming', "'u' + codePoint.toString(16).toUpperCase().padStart(5, '0')"]
];

for (const [label, token] of requiredContracts) {
  assert.ok(html.includes(token), `Missing required contract: ${label}`);
}

assert.ok(!html.includes('font.download()'), 'Deprecated library download helper must not be used');
assert.ok(!html.includes('Скачать .OTF'), 'The UI must provide the requested TrueType TTF export');

console.log(`GlyphFlow checks passed: module syntax + ${requiredContracts.length} structural contracts.`);
console.log('Note: these checks do not replace browser, touch-device, or independent TTF validation.');
