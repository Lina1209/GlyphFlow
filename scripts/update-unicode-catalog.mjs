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
for (const line of scriptsData.split(/\r?\n/)) {
  const clean = line.split('#')[0].trim();
  if (!clean) continue;
  const [range, scriptName] = clean.split(';').map(s => s.trim());
  const [start, end = start] = range.split('..').map(s => parseInt(s, 16));
  scriptRanges.push({ start, end, script: scriptName });
}
scriptRanges.sort((a,b) => a.start-b.start);
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
for (const line of unicodeData.split(/\r?\n/)) {
  if(!line) continue;
  const f=line.split(';');
  const cp=parseInt(f[0],16), name=f[1], category=f[2], combining=parseInt(f[3],10)||0;
  if(name.endsWith(', First>')) {
    pendingRange={start:cp,name:name.replace(/, First>$/,''),category,combining};
    continue;
  }
  if(name.endsWith(', Last>') && pendingRange) {
    records.push({range:[pendingRange.start,cp],nameTemplate:pendingRange.name,category:pendingRange.category,combiningClass:pendingRange.combining,script:scriptOf(pendingRange.start)});
    pendingRange=null;
    continue;
  }
  records.push({cp,name,category,combiningClass:combining,script:scriptOf(cp)});
}
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
