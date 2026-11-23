/**
 * Reconcile a GlyphFlow glyph passport with the actual parsed font cmap.
 * The parsed font must be an opentype.js Font (or compatible object).
 */
export function validateGlyphCatalogAgainstFont(font, catalog) {
  const errors = [];
  if (!font || typeof font.charToGlyph !== 'function' || !font.glyphs) {
    return { valid: false, errors: ['A parsed OpenType/TrueType font is required.'] };
  }
  if (!Array.isArray(catalog)) {
    return { valid: false, errors: ['Glyph catalog must be an array.'] };
  }

  const seen = new Set();
  const coveredGlyphIndices = new Set();
  for (const entry of catalog) {
    const character = entry?.character;
    if (typeof character !== 'string' || [...character].length !== 1) {
      errors.push(`Unsupported multi-code-point or invalid catalog entry: ${String(character)}`);
      continue;
    }
    const codePoint = character.codePointAt(0);
    const key = codePoint.toString(16).toUpperCase();
    if (seen.has(key)) {
      errors.push(`Duplicate catalog code point U+${key}`);
      continue;
    }
    seen.add(key);

    const declared = entry.codePointValue ?? entry.codePoint;
    if (typeof declared === 'number' && declared !== codePoint) {
      errors.push(`Catalog code point mismatch for U+${key}`);
      continue;
    }
    if (typeof declared === 'string') {
      const normalized = declared.replace(/^U\\+/i, '').toUpperCase();
      if (!/^[0-9A-F]+$/.test(normalized) || Number.parseInt(normalized, 16) !== codePoint) {
        errors.push(`Catalog code point mismatch for U+${key}`);
        continue;
      }
    }

    const glyph = font.charToGlyph(character);
    if (!glyph || glyph.index === 0 || glyph.unicode !== codePoint) {
      errors.push(`Missing or incorrect cmap mapping for U+${key}`);
      continue;
    }
    coveredGlyphIndices.add(glyph.index);
  }

  const glyphCount = font.glyphs.length;
  const spaceGlyphIndex = font.charToGlyph(' ').index;
  for (let index = 1; index < glyphCount; index += 1) {
    const glyph = font.glyphs.get(index);
    if (!glyph || index === spaceGlyphIndex || glyph.name === 'space') continue;
    if (!coveredGlyphIndices.has(index)) {
      errors.push(`Exported glyph at index ${index} is absent from the glyph catalog`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    catalogEntries: catalog.length,
    mappedGlyphs: coveredGlyphIndices.size,
    exportedGlyphs: Math.max(0, glyphCount - 2)
  };
}
