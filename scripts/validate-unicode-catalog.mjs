#!/usr/bin/env node
// Validate the complete downloaded UCD catalog before it can be used for font metadata.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const version = process.argv[2] || '18.0.0';
const path = process.argv[3] || `data/unicode/${version}/unicode-catalog.json`;
const catalog = JSON.parse(await readFile(path, 'utf8'));
const runtimePath = process.argv[4] || `public/data/unicode/${version}/runtime-catalog.json`;
const runtimeCatalog = JSON.parse(await readFile(runtimePath, 'utf8'));
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
assert.equal(runtimeCatalog.schema, 'glyphflow-unicode-runtime/v1');
assert.equal(runtimeCatalog.unicodeVersion, version);
assert.equal(runtimeCatalog.source, catalog.sources.unicodeData);
assert.ok(Array.isArray(runtimeCatalog.records) && runtimeCatalog.records.length > 10000);
assert.ok(Array.isArray(runtimeCatalog.ranges));
assert.equal(runtimeCatalog.records.length + runtimeCatalog.ranges.length, catalog.records.length);
let runtimePrevious = -1;
const runtimeByCodePoint = new Map();
for (const record of runtimeCatalog.records) {
  assert.equal(record.length, 5);
  const [cp, name, category, combiningClass, script] = record;
  assert.ok(Number.isInteger(cp) && cp > runtimePrevious && cp <= 0x10FFFF);
  assert.ok(typeof name === 'string' && name.length > 0);
  assert.ok(/^[A-Z][a-z]$/.test(category));
  assert.ok(Number.isInteger(combiningClass) && combiningClass >= 0 && combiningClass <= 255);
  assert.ok(typeof script === 'string' && script.length > 0);
  runtimeByCodePoint.set(cp, record);
  runtimePrevious = cp;
}
assert.equal(runtimeByCodePoint.get(0x41)?.[1], 'LATIN CAPITAL LETTER A');
assert.equal(runtimeByCodePoint.get(0x401)?.[1], 'CYRILLIC CAPITAL LETTER IO');
assert.equal(runtimeByCodePoint.get(0x300)?.[3], 230);
let runtimePreviousEnd = -1;
for (const range of runtimeCatalog.ranges) {
  assert.equal(range.length, 6);
  const [start, end, nameTemplate, category, combiningClass, script] = range;
  assert.ok(Number.isInteger(start) && start > runtimePreviousEnd && Number.isInteger(end) && end > start && end <= 0x10FFFF);
  assert.ok(typeof nameTemplate === 'string' && nameTemplate.length > 0);
  assert.ok(/^[A-Z][a-z]$/.test(category));
  assert.ok(Number.isInteger(combiningClass) && combiningClass >= 0 && combiningClass <= 255);
  assert.ok(typeof script === 'string' && script.length > 0);
  runtimePreviousEnd = end;
}
console.log(`Validated complete Unicode ${version} catalog: ${catalog.recordCount} records, ${catalog.scriptRangeCount} script ranges, ${runtimeCatalog.records.length} runtime records and ${runtimeCatalog.ranges.length} algorithmic ranges.`);
