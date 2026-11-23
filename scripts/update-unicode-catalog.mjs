#!/usr/bin/env node
/**
 * Reproducible Unicode metadata importer for GlyphFlow.
 * Usage: node scripts/update-unicode-catalog.mjs [version] [output]
 * Downloads official UnicodeData.txt and Scripts.txt, never "latest".
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const version = process.argv[2] || '18.0.0';
const output = process.argv[3] || `data/unicode/${version}/unicode-catalog.json`;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Version must be pinned as X.Y.Z');
const base = `https://www.unicode.org/Public/${version}/ucd`;

async function download(path) {
  const response = await fetch(`${base}/${path}`);
  if (!response.ok) throw new Error(`Download failed: ${path} (${response.status})`);
  return response.text();
}
const [unicodeData, scriptsData] = await Promise.all([
  download('UnicodeData.txt'), download('Scripts.txt')
]);

const scriptRanges = [];
for (const [index, line] of scriptsData.split(/\r?\n/).entries()) {
  const clean = line.split('#')[0].trim();
  if (!clean) continue;
  const fields = clean.split(';').map(s => s.trim());
  if (fields.length !== 2 || !fields[1]) throw new Error(`Malformed Scripts.txt line ${index + 1}`);
  const bounds = fields[0].split('..');
  if (bounds.length > 2 || bounds.some(value => !/^[0-9A-F]{1,6}$/i.test(value))) {
    throw new Error(`Invalid Script code point range on line ${index + 1}`);
  }
  const [start, end = start] = bounds.map(value => parseInt(value, 16));
  if (start > end || end > 0x10FFFF) throw new Error(`Out-of-range Script range on line ${index + 1}`);
  scriptRanges.push({ start, end, script: fields[1] });
}
scriptRanges.sort((a,b) => a.start-b.start);
for (let index = 1; index < scriptRanges.length; index++) {
  if (scriptRanges[index].start <= scriptRanges[index - 1].end) {
    throw new Error('Scripts.txt contains overlapping or duplicate ranges');
  }
}
function scriptOf(cp) {
  let lo=0, hi=scriptRanges.length-1;
  while(lo<=hi) {
    const mid=(lo+hi)>>1, r=scriptRanges[mid];
    if(cp<r.start) hi=mid-1;
    else if(cp>r.end) lo=mid+1;
    else return r.script;
  }
  return 'Unknown';
}

const records=[];
let pendingRange=null;
let previousCodePoint=-1;
for (const [index, line] of unicodeData.split(/\r?\n/).entries()) {
  if(!line) continue;
  const f=line.split(';');
  if (f.length !== 15 || !/^[0-9A-F]{4,6}$/i.test(f[0])) {
    throw new Error(`Malformed UnicodeData.txt line ${index + 1}`);
  }
  const cp=parseInt(f[0],16), name=f[1], category=f[2], combining=parseInt(f[3],10);
  if (!Number.isInteger(cp) || cp > 0x10FFFF || cp <= previousCodePoint) {
    throw new Error(`Invalid or unsorted Unicode code point on line ${index + 1}`);
  }
  previousCodePoint=cp;
  if (!/^[A-Z][a-z]$/.test(category) || !Number.isInteger(combining) || combining < 0 || combining > 255) {
    throw new Error(`Invalid Unicode properties on line ${index + 1}`);
  }
  if(name.endsWith(', First>')) {
    if (pendingRange) throw new Error('Nested UnicodeData First/Last range encountered');
    pendingRange={start:cp,name:name.replace(/, First>$/,''),category,combining};
    continue;
  }
  if(name.endsWith(', Last>')) {
    if (!pendingRange) throw new Error(`UnicodeData Last without First on line ${index + 1}`);
    if (cp <= pendingRange.start || name.replace(/, Last>$/,'') !== pendingRange.name ||
        category !== pendingRange.category || combining !== pendingRange.combining) {
      throw new Error(`Mismatched UnicodeData First/Last range on line ${index + 1}`);
    }
    records.push({range:[pendingRange.start,cp],nameTemplate:pendingRange.name,category:pendingRange.category,combiningClass:pendingRange.combining,script:scriptOf(pendingRange.start)});
    pendingRange=null;
    continue;
  }
  if (pendingRange) throw new Error(`UnicodeData First range was not closed before line ${index + 1}`);
  records.push({cp,name,category,combiningClass:combining,script:scriptOf(cp)});
}
if (pendingRange) throw new Error('UnicodeData ends with an unmatched First range');
if (!records.length || !scriptRanges.length) throw new Error('Unicode data files produced an empty catalog');

const catalog={
  schema:'glyphflow-unicode-catalog/v1',
  unicodeVersion:version,
  sources:{
    unicodeData:`${base}/UnicodeData.txt`,
    scripts:`${base}/Scripts.txt`,
    license:'Unicode License: https://www.unicode.org/license.txt'
  },
  generatedAt:new Date().toISOString(),
  recordCount:records.length,
  scriptRangeCount:scriptRanges.length,
  records,
  scriptRanges
};
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify(catalog));
console.log(`Unicode ${version}: ${records.length} records, ${scriptRanges.length} script ranges -> ${output}`);
