import { normalizeKerningPairs } from './kerning.js';

// Minimal OpenType GPOS 1.0 PairPos format 1 serializer (XAdvance only).
// Input records use final TrueType glyph IDs, never Unicode code points.
function assertGlyphId(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xFFFF) {
    throw new Error(label + ' must be an unsigned 16-bit glyph ID.');
  }
}
function assertValue(value) {
  if (!Number.isInteger(value) || value < -32768 || value > 32767) {
    throw new Error('GPOS XAdvance must be a signed 16-bit integer.');
  }
}
function u16(value) { return [(value >>> 8) & 255, value & 255]; }
function i16(value) { return u16(value & 0xFFFF); }
function tag(value) { return [...value].map(char => char.charCodeAt(0)); }
function concat(parts) { return parts.flat(); }
function writeOffset(bytes, at, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xFFFF) {
    throw new Error('GPOS subtable exceeds the 16-bit offset limit.');
  }
  bytes[at] = value >>> 8;
  bytes[at + 1] = value & 255;
}
export function buildGposPairPosTable(source) {
  if (!Array.isArray(source) || source.length > 10000) {
    throw new Error('GPOS pair list is invalid or exceeds 10,000 records.');
  }
  if (!source.length) return null;
  const pairs = new Map();
  const seen = new Set();
  for (const item of source) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid GPOS pair record.');
    assertGlyphId(item.leftIndex, 'Left glyph ID');
    assertGlyphId(item.rightIndex, 'Right glyph ID');
    assertValue(item.value);
    if (item.value === 0) continue;
    const key = item.leftIndex + ':' + item.rightIndex;
    if (seen.has(key)) throw new Error('Duplicate GPOS glyph pair: ' + key);
    seen.add(key);
    if (!pairs.has(item.leftIndex)) pairs.set(item.leftIndex, []);
    pairs.get(item.leftIndex).push({rightIndex: item.rightIndex, value: item.value});
  }
  if (!pairs.size) return null;
  const leftGlyphs = [...pairs.keys()].sort((a, b) => a - b);
  for (const list of pairs.values()) list.sort((a, b) => a.rightIndex - b.rightIndex);
  const pairSetParts = leftGlyphs.map(left => {
    const records = pairs.get(left);
    return concat([u16(records.length), ...records.map(record =>
      concat([u16(record.rightIndex), i16(record.value)]))]);
  });
  const pairPosHeaderLength = 10 + leftGlyphs.length * 2;
  let pairSetOffset = pairPosHeaderLength;
  const pairSetOffsets = pairSetParts.map(part => {
    const current = pairSetOffset;
    pairSetOffset += part.length;
    return current;
  });
  const coverageOffset = pairSetOffset;
  const coverage = concat([u16(1), u16(leftGlyphs.length), ...leftGlyphs.map(u16)]);
  const pairPos = concat([
    u16(1), u16(coverageOffset), u16(4), u16(0), u16(leftGlyphs.length),
    ...pairSetOffsets.map(u16), ...pairSetParts, coverage
  ]);
  // Lookup type 2, flags 0, one PairPos subtable at offset 8.
  const lookup = concat([u16(2), u16(0), u16(1), u16(8), pairPos]);
  const lookupList = concat([u16(1), u16(4), lookup]);
  // FeatureList: one 'kern' feature, lookup index 0.
  const featureList = concat([u16(1), tag('kern'), u16(8), u16(0), u16(1), u16(0)]);
  // ScriptList: DFLT default LangSys references feature 0.
  const scriptList = concat([u16(1), tag('DFLT'), u16(8), u16(4), u16(0),
    u16(0), u16(0xFFFF), u16(1), u16(0)]);
  const headerLength = 10;
  const scriptOffset = headerLength;
  const featureOffset = scriptOffset + scriptList.length;
  const lookupOffset = featureOffset + featureList.length;
  const table = concat([u16(1), u16(0), u16(scriptOffset), u16(featureOffset),
    u16(lookupOffset), scriptList, featureList, lookupList]);
  if (table.length > 0xFFFF) throw new Error('GPOS table exceeds the 16-bit PairPos offset space.');
  return Uint8Array.from(table);
}

 
// Translate the editor's Unicode-character pairs through the final TTF cmap.
// This deliberately keeps Unicode handling outside the binary PairPos writer.
export function buildGposTable(sourcePairs, cmap) {
  const pairs = normalizeKerningPairs(sourcePairs);
  if (!pairs.length) return null;
  if (!cmap || typeof cmap !== 'object' || Array.isArray(cmap)) {
    throw new Error('Не удалось получить cmap для построения GPOS.');
  }
  const records = pairs.map(pair => {
    const leftIndex = cmap[pair.left.codePointAt(0)];
    const rightIndex = cmap[pair.right.codePointAt(0)];
    if (!Number.isInteger(leftIndex) || leftIndex < 0 || leftIndex > 0xFFFF ||
        !Number.isInteger(rightIndex) || rightIndex < 0 || rightIndex > 0xFFFF) {
      throw new Error('Для пары «' + pair.left + pair.right + '» сначала нарисуйте и экспортируйте оба глифа.');
    }
    return {leftIndex, rightIndex, value: pair.value};
  });
  return buildGposPairPosTable(records);
}
