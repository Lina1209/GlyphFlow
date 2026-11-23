// Deterministic TrueType format-0 kerning support for GlyphFlow.
const MAX_KERN_PAIRS = 10000;
const MAX_FORMAT0_PAIRS = Math.floor((0xFFFF - 14) / 6);

function isUnicodeScalarCharacter(value) {
  if (typeof value !== 'string' || [...value].length !== 1) return false;
  const codePoint = value.codePointAt(0);
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF &&
    !(codePoint >= 0xD800 && codePoint <= 0xDFFF);
}

export function normalizeKerningPairs(source) {
  if (source === undefined || source === null) return [];
  if (!Array.isArray(source) || source.length > MAX_KERN_PAIRS) {
    throw new Error('Список кернинга имеет неверную структуру или превышает лимит пар.');
  }
  const seen = new Set();
  return source.map((pair, index) => {
    if (!pair || typeof pair !== 'object' || Array.isArray(pair) ||
        !isUnicodeScalarCharacter(pair.left) || !isUnicodeScalarCharacter(pair.right)) {
      throw new Error('Пара кернинга №' + (index + 1) + ' содержит некорректные символы.');
    }
    if (!Number.isInteger(pair.value) || pair.value < -32768 || pair.value > 32767) {
      throw new Error('Значение кернинга должно быть целым числом от -32768 до 32767.');
    }
    const key = pair.left.codePointAt(0) + ':' + pair.right.codePointAt(0);
    if (seen.has(key)) throw new Error('Пара кернинга «' + pair.left + pair.right + '» повторяется.');
    seen.add(key);
    return {left: pair.left, right: pair.right, value: pair.value};
  });
}

export function getKerningValue(pairs, left, right) {
  const pair = pairs.find(item => item.left === left && item.right === right);
  return pair ? pair.value : 0;
}

// Raw OpenType 'kern' version-0 table with one horizontal format-0 subtable.
export function buildKernTable(sourcePairs, cmap) {
  const pairs = normalizeKerningPairs(sourcePairs);
  if (!pairs.length) return null;
  if (!cmap || typeof cmap !== 'object' || Array.isArray(cmap)) {
    throw new Error('Не удалось получить cmap для построения кернинга.');
  }
  if (pairs.length > MAX_FORMAT0_PAIRS) {
    throw new Error('Слишком много пар для одной таблицы TrueType kern format 0.');
  }
  const records = pairs.map(pair => {
    const leftIndex = cmap[pair.left.codePointAt(0)];
    const rightIndex = cmap[pair.right.codePointAt(0)];
    if (!Number.isInteger(leftIndex) || leftIndex < 0 || leftIndex > 0xFFFF ||
        !Number.isInteger(rightIndex) || rightIndex < 0 || rightIndex > 0xFFFF) {
      throw new Error('Для пары «' + pair.left + pair.right + '» сначала нарисуйте и экспортируйте оба глифа.');
    }
    return {leftIndex, rightIndex, value: pair.value};
  }).sort((a, b) => a.leftIndex - b.leftIndex || a.rightIndex - b.rightIndex);

  for (let index = 1; index < records.length; index++) {
    if (records[index - 1].leftIndex === records[index].leftIndex &&
        records[index - 1].rightIndex === records[index].rightIndex) {
      throw new Error('Несколько символов соответствуют одной и той же паре глифов кернинга.');
    }
  }

  const pairCount = records.length;
  const pairBytes = pairCount * 6;
  const power = 2 ** Math.floor(Math.log2(pairCount));
  const searchRange = power * 6;
  const entrySelector = Math.floor(Math.log2(pairCount));
  const rangeShift = pairBytes - searchRange;
  const subtableLength = 14 + pairBytes;
  const buffer = new ArrayBuffer(18 + pairBytes);
  const view = new DataView(buffer);
  let offset = 0;
  view.setUint16(offset, 0); offset += 2;
  view.setUint16(offset, 1); offset += 2;
  view.setUint16(offset, 0); offset += 2;
  view.setUint16(offset, subtableLength); offset += 2;
  view.setUint16(offset, 1); offset += 2;
  view.setUint16(offset, pairCount); offset += 2;
  view.setUint16(offset, searchRange); offset += 2;
  view.setUint16(offset, entrySelector); offset += 2;
  view.setUint16(offset, rangeShift); offset += 2;
  for (const record of records) {
    view.setUint16(offset, record.leftIndex); offset += 2;
    view.setUint16(offset, record.rightIndex); offset += 2;
    view.setInt16(offset, record.value); offset += 2;
  }
  return Array.from(new Uint8Array(buffer));
}
