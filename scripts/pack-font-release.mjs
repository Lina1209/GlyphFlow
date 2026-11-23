import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { validateGlyphCatalogAgainstFont } from './font-catalog-validator.mjs';
import { validateGlyphMetadata } from './glyph-metadata-validator.mjs';

const require = createRequire(import.meta.url);
const opentype = require('opentype.js');

const MAGIC = new Set(['00010000', '4F54544F', '74727565', '74797031']);
const encoder = new TextEncoder();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function releaseCreatedAt() {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  if (sourceDateEpoch === undefined || sourceDateEpoch === '') return new Date().toISOString();
  if (!/^\\d+$/.test(sourceDateEpoch)) {
    throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer number of seconds.');
  }
  const seconds = Number(sourceDateEpoch);
  const date = new Date(seconds * 1000);
  if (!Number.isSafeInteger(seconds) || !Number.isFinite(date.getTime())) {
    throw new Error('SOURCE_DATE_EPOCH is outside the supported timestamp range.');
  }
  return date.toISOString();
}

function safeFileStem(value) {
  const stem = String(value || 'GlyphFlow')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[_ .-]+|[_ .-]+$/g, '')
    .slice(0, 80);
  return stem || 'GlyphFlow';
}

function zipStored(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = 0x21; // 1980-01-01; deterministic archive timestamp.

  for (const [name, data] of entries) {
    const nameBytes = encoder.encode(name);
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const compressed = deflateRawSync(raw, { level: 9 });
    const checksum = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // DEFLATE
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014B50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export async function buildReleasePackage({ fontPath, catalogPath, outDir }) {
  if (!fontPath || !catalogPath || !outDir) {
    throw new Error('Usage: node scripts/pack-font-release.mjs --font input.ttf --catalog glyph-catalog.json --out output-directory');
  }
  const [fontBytes, catalogBytes] = await Promise.all([
    readFile(fontPath),
    readFile(catalogPath)
  ]);
  if (fontBytes.length < 12 || !MAGIC.has(fontBytes.subarray(0, 4).toString('hex').toUpperCase())) {
    throw new Error('Font file has no recognized sfnt signature; expected a valid TTF/OTF file.');
  }

  let catalog;
  try {
    catalog = JSON.parse(catalogBytes.toString('utf8'));
  } catch {
    throw new Error('Glyph catalog is not valid UTF-8 JSON.');
  }
  if (catalog?.schema !== 'glyphflow-glyph-catalog/v1' || !Array.isArray(catalog.glyphs) || catalog.glyphs.length === 0) {
    throw new Error('Unsupported or empty GlyphFlow glyph catalog.');
  }
  let parsedFont;
  try {
    const arrayBuffer = fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength);
    parsedFont = opentype.parse(arrayBuffer);
  } catch (error) {
    throw new Error('Font binary could not be parsed as a valid OpenType/TrueType font: ' + (error.message || String(error)));
  }
  const passport = catalog.glyphs.map(glyph => ({
    character: glyph.character,
    codePoint: Array.isArray(glyph.codePoints) && glyph.codePoints.length === 1 ? glyph.codePoints[0] : null
  }));
  const cmapReport = validateGlyphCatalogAgainstFont(parsedFont, passport);
  if (!cmapReport.valid) {
    throw new Error('Font cmap and glyph catalog do not match: ' + cmapReport.errors.join('; '));
  }

  const metadataReport = validateGlyphMetadata(catalog.glyphs, catalog.metadataCatalog);
  if (!metadataReport.valid) {
    throw new Error('Glyph metadata validation failed: ' + metadataReport.errors.join('; '));
  }

  const family = String(catalog.fontFamily || 'GlyphFlow').trim();
  if (!family || family.length > 128) throw new Error('Font family name is empty or too long.');

  const seen = new Set();
  for (const glyph of catalog.glyphs) {
    if (!glyph || typeof glyph.character !== 'string' || !glyph.character.length) {
      throw new Error('Glyph catalog contains an entry without a character.');
    }
    const codePoints = [...glyph.character].map(char => char.codePointAt(0));
    const key = codePoints.join('-');
    if (seen.has(key)) throw new Error('Duplicate glyph sequence in catalog: ' + glyph.character);
    seen.add(key);
    if (!Array.isArray(glyph.codePoints) || glyph.codePoints.length !== codePoints.length) {
      throw new Error('Glyph codePoints do not match character: ' + glyph.character);
    }
    for (let i = 0; i < codePoints.length; i += 1) {
      const expected = 'U+' + codePoints[i].toString(16).toUpperCase().padStart(4, '0');
      if (glyph.codePoints[i] !== expected) {
        throw new Error('Glyph code point mismatch for character: ' + glyph.character);
      }
    }
    if (!glyph.glyphName || !glyph.description || !glyph.metadataStatus) {
      throw new Error('Glyph is missing its technical name, description, or metadata status: ' + glyph.character);
    }
  }

  const stem = safeFileStem(family);
  const fontExtension = fontBytes.subarray(0, 4).toString('hex').toUpperCase() === '4F54544F' ? 'otf' : 'ttf';
  const fontName = stem + '-Regular.' + fontExtension;
  const catalogName = stem + '-glyph-catalog.json';
  const fontHash = createHash('sha256').update(fontBytes).digest('hex');
  const catalogHash = createHash('sha256').update(catalogBytes).digest('hex');
  const manifest = {
    schema: 'glyphflow-font-release/v1',
    family,
    style: 'Regular',
    createdAt: releaseCreatedAt(),
    files: {
      font: { name: fontName, sha256: fontHash, bytes: fontBytes.length },
      glyphCatalog: { name: catalogName, sha256: catalogHash, bytes: catalogBytes.length }
    },
    glyphCount: catalog.glyphs.length,
    unicodeDataVersion: catalog.metadataCatalog?.unicodeDataVersion ?? null,
    metadataCompleteness: catalog.metadataCatalog?.completeness ?? 'unspecified',
    glyphMetadataAudit: {
      ...metadataReport.counts,
      reviewedGlyphs: metadataReport.reviewedGlyphs,
      warningCount: metadataReport.warnings.length,
      validationScope: 'syntax-and-status-consistency; official Unicode names are not re-fetched during packaging'
    },
    licenseStatus: 'not-assigned',
    publicationStatus: 'preflight-only',
    warnings: [
      'No license is granted by this package.',
      'Confirm ownership and permissions for every glyph before distribution.',
      'Run Fontspector and visual QA before any Google Fonts submission.',
      'Sequences requiring explicit ligature or shaping rules must be reviewed separately.',
      ...(metadataReport.warnings.length ? [metadataReport.warnings.length + ' glyph metadata item(s) require manual review; see glyphMetadataAudit.'] : [])
    ]
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const readme = [
    family + ' — GlyphFlow release preflight',
    '',
    'Contents:',
    '- ' + fontName,
    '- ' + catalogName,
    '- release-manifest.json',
    '- SHA256SUMS',
    '',
    'This is a technical preflight package, not a publication approval.',
    'No license is included or granted. Do not distribute until ownership, permissions,',
    'license choice, font quality, and platform-specific requirements are confirmed.',
    'Google Fonts submission requires a separate review and its then-current requirements.',
    ''
  ].join('\n');
  const files = [
    [fontName, fontBytes],
    [catalogName, catalogBytes],
    ['release-manifest.json', manifestBytes],
    ['README-RELEASE.txt', Buffer.from(readme)]
  ];
  const sums = files.map(([name, bytes]) =>
    createHash('sha256').update(bytes).digest('hex') + '  ' + name
  ).join('\n') + '\n';
  files.push(['SHA256SUMS', Buffer.from(sums)]);

  await mkdir(outDir, { recursive: true });
  for (const [name, bytes] of files) await writeFile(path.join(outDir, name), bytes);
  const zipPath = path.resolve(outDir) + '.zip';
  await writeFile(zipPath, zipStored(files.map(([name, bytes]) => [name, bytes])));
  return { outDir: path.resolve(outDir), zipPath, family, glyphCount: catalog.glyphs.length, metadataReport, files: files.map(([name]) => name) };
}

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--font' || argv[i] === '--catalog' || argv[i] === '--out') {
      args[argv[i].slice(2)] = argv[++i];
    }
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await buildReleasePackage(readArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write((error.message || String(error)) + '\n');
    process.exitCode = 1;
  }
}
