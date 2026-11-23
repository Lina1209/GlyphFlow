import assert from 'node:assert/strict';
import { getGlyphMetadata, getLoadedUnicodeVersion, loadUnicodeCatalog } from '../src/glyph-metadata.js';

assert.equal(getLoadedUnicodeVersion(), null);
assert.equal(getGlyphMetadata('A').unicodeName, 'LATIN CAPITAL LETTER A');
assert.equal(getGlyphMetadata('A').metadataStatus, 'verified-local-catalog');

let failedFetchCount = 0;
await assert.rejects(loadUnicodeCatalog({
  url:'/bad-runtime-catalog.json',
  fetcher:async () => {
    failedFetchCount++;
    return {ok:true,json:async () => ({schema:'wrong',unicodeVersion:'18.0.0',records:[],ranges:[]})};
  }
}), /unsupported schema or incomplete data/);
assert.equal(getLoadedUnicodeVersion(), null);

const records = [
  [0x41,'LATIN CAPITAL LETTER A','Lu',0,'Latin'],
  [0x300,'COMBINING GRAVE ACCENT','Mn',230,'Inherited'],
  [0x401,'CYRILLIC CAPITAL LETTER IO','Lu',0,'Cyrillic'],
  [0x410,'CYRILLIC CAPITAL LETTER A','Lu',0,'Cyrillic']
];
for (let cp = 0x10000; cp < 0x10000 + 10000; cp++) {
  records.push([cp,'TEST CHARACTER '+cp.toString(16).toUpperCase(),'Lo',0,'Unknown']);
}
records.sort((a,b) => a[0]-b[0]);
const runtimeCatalog = {
  schema:'glyphflow-unicode-runtime/v1',
  unicodeVersion:'18.0.0',
  source:'https://www.unicode.org/Public/18.0.0/ucd/UnicodeData.txt',
  records,
  ranges:[[0x3400,0x4DBF,'<CJK Ideograph Extension A','Lo',0,'Han'],[0xAC00,0xD7A3,'<Hangul Syllable','Lo',0,'Hangul']]
};
let fetchCount = 0;
const fetcher = async url => {
  fetchCount++;
  assert.equal(url,'/data/unicode/18.0.0/runtime-catalog.json');
  return {ok:true,json:async () => runtimeCatalog};
};
assert.equal(await loadUnicodeCatalog({url:'/data/unicode/18.0.0/runtime-catalog.json',fetcher}),'18.0.0');
assert.equal(await loadUnicodeCatalog({url:'/ignored.json',fetcher}), '18.0.0');
assert.equal(fetchCount,1);
assert.equal(getLoadedUnicodeVersion(),'18.0.0');

const latin = getGlyphMetadata('A');
assert.equal(latin.unicodeName,'LATIN CAPITAL LETTER A');
assert.equal(latin.glyphName,'A');
assert.equal(latin.generalCategory,'Lu');
assert.equal(latin.script,'Latin');
assert.equal(latin.metadataStatus,'verified-ucd');
assert.equal(latin.metadataSource,'Unicode Character Database 18.0.0');

const yo = getGlyphMetadata('Ё');
assert.equal(yo.unicodeName,'CYRILLIC CAPITAL LETTER IO');
assert.equal(yo.glyphName,'uni0401');
assert.equal(yo.script,'Cyrillic');

const combining = getGlyphMetadata('\u0300');
assert.equal(combining.unicodeName,'COMBINING GRAVE ACCENT');
assert.equal(combining.generalCategory,'Mn');
assert.equal(combining.combiningClass,230);

const algorithmic = getGlyphMetadata(String.fromCodePoint(0x3401));
assert.equal(algorithmic.unicodeName,'CJK UNIFIED IDEOGRAPH-3401');
assert.equal(algorithmic.generalCategory,'Lo');
assert.equal(algorithmic.script,'Han');

const hangul = getGlyphMetadata(String.fromCodePoint(0xAC00));
assert.equal(hangul.unicodeName,'HANGUL SYLLABLE GA');
assert.equal(hangul.script,'Hangul');

assert.equal(getGlyphMetadata('AB'),null);
console.log('Glyph metadata tests passed: local fallback, pinned UCD loading, fetch reuse, official names, categories, scripts, combining classes and algorithmic ranges.');
