import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const modules = [...html.matchAll(/<script\\s+type=["']module["']\\s*>([\\s\\S]*?)<\\/script>/gi)];
assert.equal(modules.length, 1, 'Expected exactly one inline ES module');

const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], {
  input: modules[0][1],
  encoding: 'utf8'
});
assert.equal(syntax.status, 0, `Inline module syntax check failed:\\n${syntax.stderr || syntax.stdout}`);

const requiredContracts = [
  ['primary pointer guard', 'if (!e.isPrimary || isDrawing) return;'],
  ['active pointer filtering', 'e.pointerId !== activePointerId'],
  ['pointer cancellation', "addEventListener('pointercancel'"],
  ['lost pointer capture handling', "addEventListener('lostpointercapture'"],
  ['local draft persistence', 'indexedDB.open(DRAFT_DB, 1)'],
  ['draft restoration on startup', 'await restoreDraft();'],
  ['visible .notdef glyph', "name: '.notdef'"],
  ['normalized left side bearing', 'const xOffset = sideBearing - minX * scale;'],
  ['advance width from glyph bounds', '(maxX - minX) * scale']
];

for (const [label, token] of requiredContracts) {
  assert.ok(html.includes(token), `Missing required contract: ${label}`);
}

console.log(`GlyphFlow checks passed: module syntax + ${requiredContracts.length} structural contracts.`);
console.log('Note: these checks do not replace browser, touch-device, or independent TTF validation.');
