import assert from 'node:assert/strict';
import {buildGposPairPosTable} from '../src/gpos.js';
const bytes = buildGposPairPosTable([
  {leftIndex: 4, rightIndex: 9, value: -80},
  {leftIndex: 4, rightIndex: 7, value: -25},
  {leftIndex: 2, rightIndex: 3, value: 12}
]);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u16 = offset => view.getUint16(offset);
assert.equal(u16(0), 1, 'GPOS major version');
assert.equal(u16(2), 0, 'GPOS minor version');
const scriptOffset = u16(4), featureOffset = u16(6), lookupOffset = u16(8);
assert.equal(String.fromCharCode(...bytes.slice(scriptOffset + 2, scriptOffset + 6)), 'DFLT');
assert.equal(String.fromCharCode(...bytes.slice(featureOffset + 2, featureOffset + 6)), 'kern');
assert.equal(u16(lookupOffset), 1, 'one lookup');
const lookup = lookupOffset + u16(lookupOffset + 2);
assert.equal(u16(lookup), 2, 'Pair Adjustment lookup type');
const pairPos = lookup + u16(lookup + 6);
assert.equal(u16(pairPos), 1, 'PairPos format 1');
assert.equal(u16(pairPos + 4), 4, 'XAdvance value format');
assert.equal(u16(pairPos + 6), 0, 'second glyph value format omitted');
assert.equal(u16(pairPos + 8), 2, 'two first-glyph PairSets');
const firstSet = pairPos + u16(pairPos + 10);
assert.equal(u16(firstSet), 1);
assert.equal(u16(firstSet + 2), 3);
assert.equal(view.getInt16(firstSet + 4), 12);
const secondSet = pairPos + u16(pairPos + 12);
assert.equal(u16(secondSet), 2);
assert.deepEqual([u16(secondSet + 2), view.getInt16(secondSet + 4), u16(secondSet + 6), view.getInt16(secondSet + 8)], [7, -25, 9, -80]);
const coverage = pairPos + u16(pairPos + 2);
assert.equal(u16(coverage), 1);
assert.deepEqual([u16(coverage + 4), u16(coverage + 6)], [2, 4]);
assert.equal(buildGposPairPosTable([]), null);
assert.equal(buildGposPairPosTable([{leftIndex:1,rightIndex:2,value:0}]), null);
assert.throws(() => buildGposPairPosTable([{leftIndex:-1,rightIndex:2,value:1}]), /glyph ID/);
assert.throws(() => buildGposPairPosTable([{leftIndex:1,rightIndex:2,value:32768}]), /signed 16-bit/);
assert.throws(() => buildGposPairPosTable([{leftIndex:1,rightIndex:2,value:1},{leftIndex:1,rightIndex:2,value:2}]), /Duplicate/);
console.log('GPOS PairPos format 1 tests passed.');
