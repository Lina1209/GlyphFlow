const VALID_METADATA_STATUSES = new Set(['verified-ucd', 'verified-local-catalog', 'needs-review']);
const PLACEHOLDER_DESCRIPTION = /(?:требуется проверка|проверьте символ|описани[ея] отсутству|placeholder|\bTODO\b|to be reviewed|needs review)/i;
const UCD_SOURCE = /^Unicode Character Database (\d+\.\d+\.\d+)$/;
const GLYPH_NAME = /^[A-Za-z0-9_.-]{1,63}$/;
const UNICODE_NAME = /^[A-Z0-9 -]+$/;

function codePointLabel(character) {
  return [...character].map(value => 'U+' + value.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
}

/** Validate metadata separately from cmap coverage. needs-review remains packageable but visible. */
export function validateGlyphMetadata(catalog, metadataCatalog = {}) {
  const errors = [];
  const warnings = [];
  const counts = { verifiedUcd: 0, verifiedLocalCatalog: 0, needsReview: 0, descriptionReview: 0 };
  const seenNames = new Map();
  if (!Array.isArray(catalog)) {
    return { valid: false, errors: ['Glyph metadata catalog must be an array.'], warnings, counts, reviewedGlyphs: 0 };
  }
  for (const glyph of catalog) {
    if (!glyph || typeof glyph.character !== 'string' || !glyph.character.length) {
      errors.push('Glyph metadata entry has no character.');
      continue;
    }
    const points = [...glyph.character];
    const label = codePointLabel(glyph.character);
    if (points.length !== 1) {
      errors.push('Metadata validation requires one Unicode scalar per exported glyph: ' + label);
      continue;
    }
    const cp = points[0].codePointAt(0);
    if (cp >= 0xD800 && cp <= 0xDFFF) {
      errors.push('Invalid Unicode surrogate in glyph metadata: ' + label);
      continue;
    }
    const name = glyph.glyphName;
    if (typeof name !== 'string' || !GLYPH_NAME.test(name)) {
      errors.push('Invalid OpenType glyph name for ' + label + ': expected 1–63 ASCII letters, digits, period, underscore, or hyphen.');
    } else if (seenNames.has(name)) {
      errors.push('Duplicate OpenType glyph name "' + name + '" for ' + label + ' and ' + seenNames.get(name));
    } else {
      seenNames.set(name, label);
    }
    const status = glyph.metadataStatus;
    if (!VALID_METADATA_STATUSES.has(status)) {
      errors.push('Unknown metadata status for ' + label + ': ' + String(status));
    } else if (status === 'verified-ucd') {
      counts.verifiedUcd += 1;
    } else if (status === 'verified-local-catalog') {
      counts.verifiedLocalCatalog += 1;
    } else {
      counts.needsReview += 1;
      warnings.push(label + ' is marked needs-review.');
    }
    const description = typeof glyph.description === 'string' ? glyph.description.trim() : '';
    if (!description) {
      errors.push('Empty human-readable glyph description for ' + label + '.');
    } else if (PLACEHOLDER_DESCRIPTION.test(description)) {
      counts.descriptionReview += 1;
      if (status === 'needs-review') warnings.push(label + ' has a provisional or placeholder description.');
      else errors.push('A glyph marked as verified has a provisional or placeholder description: ' + label);
    }
    if (glyph.unicodeName != null &&
        (typeof glyph.unicodeName !== 'string' || !UNICODE_NAME.test(glyph.unicodeName) ||
         glyph.unicodeName.trim() !== glyph.unicodeName || !glyph.unicodeName.length)) {
      errors.push('Invalid Unicode Character Name syntax for ' + label + '.');
    }
    if (status === 'verified-ucd') {
      if (typeof glyph.unicodeName !== 'string' || !glyph.unicodeName.length) {
        errors.push('verified-ucd requires an official Unicode Character Name for ' + label + '.');
      }
      const sourceMatch = typeof glyph.metadataSource === 'string' ? glyph.metadataSource.match(UCD_SOURCE) : null;
      if (!sourceMatch) errors.push('verified-ucd requires a versioned Unicode Character Database source for ' + label + '.');
      else if (metadataCatalog?.unicodeDataVersion !== sourceMatch[1]) {
        errors.push('Unicode data version does not match metadataSource for ' + label + '.');
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings: [...new Set(warnings)], counts, reviewedGlyphs: catalog.length };
}
