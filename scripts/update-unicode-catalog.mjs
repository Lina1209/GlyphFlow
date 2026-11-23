#!/usr/bin/env node
/**
 * Reproducible Unicode metadata importer for GlyphFlow.
 * Usage: node scripts/update-unicode-catalog.mjs [version] [output]
 * Downloads official UnicodeData.txt and Scripts.txt, never "latest".
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseScripts, parseUnicodeData } from './unicode-catalog-parser.mjs';

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
const scriptRanges = parseScripts(scriptsData);
const records = parseUnicodeData(unicodeData, scriptRanges);
const catalog = {
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
