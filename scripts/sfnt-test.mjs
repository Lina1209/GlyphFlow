import assert from 'node:assert/strict';
import { addSfntTable } from '../src/sfnt.js';
// Minimal synthetic SFNT with a valid directory and 54-byte head table.
const sourceBytes = new Uint8Array(12 + 16 + 56);
const sourceView = new DataView(sourceBytes.buffer);
sourceView.setUint32(0, 0x00010000, false);
sourceView.setUint16(4, 1, false);
sourceView.setUint16(6, 16, false);
sourceView.setUint16(8, 0, false);
sourceView.setUint16(10, 0, false);
sourceBytes.set([104,101,97,100], 12);
sourceView.setUint32(16, 0, false);
sourceView.setUint32(20, 28, false);
sourceView.setUint32(24, 54, false);
sourceView.setUint32(28 + 8, 0, false);
const source = sourceBytes.buffer;
const payload = Uint8Array.from([0,1,2,3,4,5,6,7]);
const result = addSfntTable(source,'GPOS',payload);
const view = new DataView(result);
const count = view.getUint16(4);
const tags = [];
let headOffset = -1;
for (let i=0;i<count;i++) {
  const at=12+i*16;
  const tag=String.fromCharCode(...new Uint8Array(result,at,4));
  tags.push(tag);
  if(tag==='head') headOffset=view.getUint32(at+8);
}
assert.ok(tags.includes('GPOS'));
assert.ok(tags.includes('head'));
assert.equal(new Uint8Array(result, view.getUint32(12 + tags.indexOf('GPOS')*16 + 8), 8).join(','), payload.join(','));
assert.equal(new DataView(result).getUint32(headOffset+8), (0xB1B0AFBA - (() => {
  const bytes=new Uint8Array(result); let sum=0;
  for(let i=0;i<bytes.length;i+=4) sum=(sum+((((bytes[i]||0)<<24)|((bytes[i+1]||0)<<16)|((bytes[i+2]||0)<<8)|(bytes[i+3]||0))>>>0))>>>0;
  return sum;
})())>>>0);
console.log('SFNT raw table injection tests passed.');
