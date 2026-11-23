import assert from 'node:assert/strict';
import { parseScripts, parseUnicodeData } from './unicode-catalog-parser.mjs';

const scripts = parseScripts(`
# Minimal Scripts.txt fixture
0041..005A ; Latin # uppercase Latin
0061..007A ; Latin
0400..04FF ; Cyrillic
`);
assert.deepEqual(scripts, [
  {start:0x41,end:0x5A,script:'Latin'},
  {start:0x61,end:0x7A,script:'Latin'},
  {start:0x400,end:0x4FF,script:'Cyrillic'}
]);

const unicodeLine = (cp, name, category='Lu', combining=0) =>
  [cp.toString(16).toUpperCase().padStart(4,'0'),name,category,String(combining),'L','0','0','N','','','','','','',''].join(';');
const unicode = [
  unicodeLine(0x41,'LATIN CAPITAL LETTER A'),
  unicodeLine(0x300,'COMBINING GRAVE ACCENT','Mn',230),
  unicodeLine(0x3400,'CJK UNIFIED IDEOGRAPH-3400, First>','Lo'),
  unicodeLine(0x4DBF,'CJK UNIFIED IDEOGRAPH-3400, Last>','Lo')
].join('\n');
const records = parseUnicodeData(unicode, scripts);
assert.equal(records.length,3);
assert.deepEqual(records[0],{cp:0x41,name:'LATIN CAPITAL LETTER A',category:'Lu',combiningClass:0,script:'Latin'});
assert.equal(records[1].combiningClass,230);
assert.deepEqual(records[2],{range:[0x3400,0x4DBF],nameTemplate:'CJK UNIFIED IDEOGRAPH-3400',category:'Lo',combiningClass:0,script:'Unknown'});

assert.throws(() => parseScripts('0041..005A ; Latin\n0050..0060 ; Greek'),/overlapping/);
assert.throws(() => parseScripts('110000 ; Invalid'),/Out-of-range/);
assert.throws(() => parseUnicodeData(unicodeLine(0x42,'BROKEN')+'\n'+unicodeLine(0x41,'OUT OF ORDER'),scripts),/unsorted/);
assert.throws(() => parseUnicodeData(unicodeLine(0x3400,'RANGE, First>','Lo'),scripts),/unmatched First/);
assert.throws(() => parseUnicodeData(unicodeLine(0x3400,'RANGE, Last>','Lo'),scripts),/Last without First/);
assert.throws(() => parseUnicodeData([
  unicodeLine(0x3400,'RANGE, First>','Lo'),
  unicodeLine(0x3401,'OTHER, Last>','Lo')
].join('\n'),scripts),/Mismatched/);

// Strict malformed-input and boundary regression cases.
assert.throws(() => parseScripts('0041..110000 ; Latin'), /Out-of-range/);
assert.throws(() => parseScripts('0041..0040 ; Latin'), /Out-of-range/);
assert.throws(() => parseScripts('0041 ;'), /Malformed/);
assert.throws(() => parseScripts('0041..0042..0043 ; Latin'), /Invalid Script/);
assert.throws(() => parseUnicodeData('0041;TOO FEW FIELDS', scripts), /Malformed/);
assert.throws(() => parseUnicodeData(unicodeLine(0x41, 'BAD CATEGORY', 'Invalid'), scripts), /Invalid Unicode properties/);
assert.throws(() => parseUnicodeData(unicodeLine(0x41, 'BAD COMBINING CLASS', 'Lu', 256), scripts), /Invalid Unicode properties/);
assert.throws(() => parseUnicodeData([
  unicodeLine(0x3400, 'RANGE, First>', 'Lo'),
  unicodeLine(0x3401, 'INTERRUPTING RECORD', 'Lo')
].join('\n'), scripts), /not closed/);
assert.throws(() => parseUnicodeData([
  unicodeLine(0x3400, 'RANGE, First>', 'Lo'),
  unicodeLine(0x3401, 'RANGE, First>', 'Lo')
].join('\\n'), scripts), /Nested/);
assert.throws(() => parseUnicodeData(unicodeLine(0x110000, 'OUT OF RANGE'), scripts), /Invalid or unsorted/);
assert.throws(() => parseUnicodeData('', scripts), /empty catalog/);
assert.deepEqual(parseScripts(''), [], 'Empty Scripts.txt should parse to an empty range list');
assert.equal(parseUnicodeData(unicodeLine(0x41, 'LATIN CAPITAL LETTER A'), [] )[0].script, 'Unknown');

console.log('Unicode catalog parser tests passed: Scripts ranges, Unicode records, combining classes, First/Last ranges and malformed input.');
