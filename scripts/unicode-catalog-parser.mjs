// Pure parsers for the pinned Unicode Character Database text files.
export function parseScripts(text) {
  const ranges = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const clean = line.split('#')[0].trim();
    if (!clean) continue;
    const fields = clean.split(';').map(value => value.trim());
    if (fields.length !== 2 || !fields[1]) throw new Error(`Malformed Scripts.txt line ${index + 1}`);
    const bounds = fields[0].split('..');
    if (bounds.length > 2 || bounds.some(value => !/^[0-9A-F]{1,6}$/i.test(value))) {
      throw new Error(`Invalid Script code point range on line ${index + 1}`);
    }
    const [start, end = start] = bounds.map(value => parseInt(value, 16));
    if (start > end || end > 0x10FFFF) throw new Error(`Out-of-range Script range on line ${index + 1}`);
    ranges.push({ start, end, script: fields[1] });
  }
  ranges.sort((a,b) => a.start-b.start);
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index].start <= ranges[index - 1].end) throw new Error('Scripts.txt contains overlapping or duplicate ranges');
  }
  return ranges;
}

export function parseUnicodeData(text, scriptRanges) {
  const scriptOf = cp => {
    let lo=0, hi=scriptRanges.length-1;
    while(lo<=hi) {
      const mid=(lo+hi)>>1, range=scriptRanges[mid];
      if(cp<range.start) hi=mid-1;
      else if(cp>range.end) lo=mid+1;
      else return range.script;
    }
    return 'Unknown';
  };
  const records=[];
  let pendingRange=null, previousCodePoint=-1;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if(!line) continue;
    const fields=line.split(';');
    if (fields.length !== 15 || !/^[0-9A-F]{4,6}$/i.test(fields[0])) {
      throw new Error(`Malformed UnicodeData.txt line ${index + 1}`);
    }
    const cp=parseInt(fields[0],16), name=fields[1], category=fields[2], combining=parseInt(fields[3],10);
    if (!Number.isInteger(cp) || cp > 0x10FFFF || cp <= previousCodePoint) throw new Error(`Invalid or unsorted Unicode code point on line ${index + 1}`);
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
  if (!records.length) throw new Error('UnicodeData produced an empty catalog');
  return records;
}
