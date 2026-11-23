// Add a raw OpenType table to an SFNT font without relying on writer support
// for newer tables. All offsets, per-table checksums and head adjustment are rebuilt.
function readU16(view, offset) { return view.getUint16(offset, false); }
function readU32(view, offset) { return view.getUint32(offset, false); }
function writeU16(view, offset, value) { view.setUint16(offset, value, false); }
function writeU32(view, offset, value) { view.setUint32(offset, value >>> 0, false); }
function checksum(bytes) {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const word = ((bytes[offset] || 0) << 24) |
      ((bytes[offset + 1] || 0) << 16) |
      ((bytes[offset + 2] || 0) << 8) |
      (bytes[offset + 3] || 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum >>> 0;
}
function align4(value) { return (value + 3) & ~3; }

export function addSfntTable(source, tableTag, tableBytes) {
  if (!(source instanceof ArrayBuffer) || source.byteLength < 12) throw new Error('Invalid SFNT source.');
  if (typeof tableTag !== 'string' || !/^[\x20-\x7E]{4}$/.test(tableTag)) throw new Error('Invalid SFNT table tag.');
  if (!(tableBytes instanceof Uint8Array) || tableBytes.length === 0) throw new Error('SFNT table data is empty.');
  const input = new DataView(source);
  const signature = readU32(input, 0);
  if (signature !== 0x00010000 && signature !== 0x4F54544F) throw new Error('Unsupported SFNT signature.');
  const count = readU16(input, 4);
  if (count < 1 || count > 4095 || 12 + count * 16 > source.byteLength) throw new Error('Invalid SFNT table directory.');
  const records = [];
  let headBytes = null;
  for (let index = 0; index < count; index++) {
    const at = 12 + index * 16;
    const tag = String.fromCharCode(input.getUint8(at), input.getUint8(at + 1), input.getUint8(at + 2), input.getUint8(at + 3));
    const checksumValue = readU32(input, at + 4);
    const offset = readU32(input, at + 8);
    const length = readU32(input, at + 12);
    if (offset > source.byteLength || length > source.byteLength - offset) throw new Error('SFNT table is out of bounds: ' + tag);
    if (tag === 'head') {
      if (length < 12) throw new Error('Invalid SFNT head table.');
      headBytes = new Uint8Array(source.slice(offset, offset + length));
      new DataView(headBytes.buffer).setUint32(8, 0, false);
    }
    if (tag !== tableTag) records.push({tag, checksum:checksumValue, bytes:new Uint8Array(source.slice(offset, offset + length))});
  }
  if (!headBytes) throw new Error('SFNT head table is missing.');
  records.push({tag:tableTag, checksum:checksum(tableBytes), bytes:tableBytes.slice()});
  records.sort((a,b)=>a.tag.localeCompare(b.tag));
  const outputDirectoryLength = 12 + records.length * 16;
  let cursor = align4(outputDirectoryLength);
  const placements = records.map(record => {
    const placement = {record, offset:cursor};
    cursor = align4(cursor + record.bytes.length);
    return placement;
  });
  const output = new Uint8Array(cursor);
  const view = new DataView(output.buffer);
  output.set(new Uint8Array(source, 0, 4), 0);
  writeU16(view, 4, records.length);
  let power = 1, selector = 0;
  while (power * 2 <= records.length) { power *= 2; selector++; }
  writeU16(view, 6, power * 16);
  writeU16(view, 8, selector);
  writeU16(view, 10, records.length * 16 - power * 16);
  let headOffset = -1;
  placements.forEach(({record,offset}, index) => {
    const at = 12 + index * 16;
    for (let j=0;j<4;j++) output[at+j] = record.tag.charCodeAt(j);
    output.set(record.bytes, offset);
    const sum = checksum(record.bytes);
    writeU32(view, at + 4, record.tag === 'head' ? checksum(headBytes) : sum);
    writeU32(view, at + 8, offset);
    writeU32(view, at + 12, record.bytes.length);
    if (record.tag === 'head') headOffset = offset;
  });
  if (headOffset < 0) throw new Error('SFNT head table was lost.');
  writeU32(view, headOffset + 8, (0xB1B0AFBA - checksum(output)) >>> 0);
  return output.buffer;
}
