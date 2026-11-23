#!/usr/bin/env node
// Validate the complete downloaded UCD catalog before it can be used for font metadata.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const version = process.argv[2] || '18.0.0';
const path = process.argv[3] || `data/unicode/${version}/unicode-catalog.json`;
const catalog = JSON.parse(await readFile(path, 'utf8'));
assert.equal(catalog.schema, 'glyphflow-unicode-catalog/v1');
assert.equal(catalog.unicodeVersion, version, 'Catalog version must match the requested pinned version');
assert.ok(catalog.sources?.unicodeData?.includes(`/Public/${version}/ucd/UnicodeData.txt`));
assert.ok(catalog.sources?.scripts?.includes(`/Public/${version}/ucd/Scripts.txt`));
assert.ok(catalog.sources?.license?.includes('unicode.org/license.txt'));
assert.ok(Array.isArray(catalog.records) && catalog.records.length > 10000, 'Full UCD record set is unexpectedly small');
assert.equal(catalog.recordCount, catalog.records.length);
assert.ok(Array.isArray(catalog.scriptRanges) && catalog.scriptRanges.length > 100, 'Full Scripts.txt range set is unexpectedly small');
assert.equal(catalog.scriptRangeCount, catalog.scriptRanges.length);

const byCodePoint = new Map(catalog.records.filter(record => Number.isInteger(record.cp)).map(record => [record.cp, record]));
const expectRecord = (cp, name, category, script) => {
  const record = byCodePoint.get(cp);
  assert.ok(record, `Missing UCD code point U+${cp.toString(16).toUpperCase()}`);
  assert.equal(record.name, name);
  assert.equal(record.category, category);
  assert.equal(record.script, script);
};
expectRecord(0x41, 'LATIN CAPITAL LETTER A', 'Lu', 'Latin');
expectRecord(0x61, 'LATIN SMALL LETTER A', 'Ll', 'Latin');
expectRecord(0x401, 'CYRILLIC CAPITAL LETTER IO', 'Lu', 'Cyrillic');
expectRecord(0x419, 'CYRILLIC CAPITAL LETTER SHORT I', 'Lu', 'Cyrillic');
expectRecord(0x410, 'CYRILLIC CAPITAL LETTER A', 'Lu', 'Cyrillic');
expectRecord(0x430, 'CYRILLIC SMALL LETTER A', 'Ll', 'Cyrillic');
const combining = byCodePoint.get(0x300);
assert.equal(combining?.name, 'COMBINING GRAVE ACCENT');
assert.equal(combining?.category, 'Mn');
assert.equal(combining?.combiningClass, 230);

let previousEnd = -1;
for (const range of catalog.scriptRanges) {
  assert.ok(Number.isInteger(range.start) && Number.isInteger(range.end));
  assert.ok(range.start > previousEnd, 'Script ranges must be sorted and non-overlapping');
  assert.ok(range.start <= range.end && range.end <= 0x10FFFF);
  assert.ok(typeof range.script === 'string' && range.script.length > 0);
  previousEnd = range.end;
}
for (const record of catalog.records) {
  if (record.range) {
    assert.equal(record.range.length, 2);
    assert.ok(record.range[0] < record.range[1]);
    assert.ok(typeof record.nameTemplate === 'string' && record.nameTemplate.length > 0);
  } else {
    assert.ok(Number.isInteger(record.cp) && record.cp >= 0 && record.cp <= 0x10FFFF);
    assert.ok(typeof record.name === 'string' && record.name.length > 0);
  }
  assert.ok(/^[A-Z][a-z]$/.test(record.category));
  assert.ok(Number.isInteger(record.combiningClass) && record.combiningClass >= 0 && record.combiningClass <= 255);
  assert.ok(typeof record.script === 'string' && record.script.length > 0);
}
console.log(`Validated complete Unicode ${version} catalog: ${catalog.recordCount} records, ${catalog.scriptRangeCount} script ranges, representative Latin/Cyrillic/combining metadata.`);
