import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const opentype = require('opentype.js');
import { buildReleasePackage } from './pack-font-release.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'glyphflow-release-'));
try {
  const fontPath = path.join(root, 'fixture.otf');
  const catalogPath = path.join(root, 'catalog.json');
  const outDir = path.join(root, 'release');
  const pathData = new opentype.Path();
  pathData.moveTo(80, 0);
  pathData.lineTo(80, 700);
  pathData.lineTo(520, 700);
  pathData.lineTo(520, 0);
  pathData.close();
  const fixtureFont = new opentype.Font({
    familyName: 'GlyphFlow QA Fixture',
    styleName: 'Regular',
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs: [
      new opentype.Glyph({ name: '.notdef', advanceWidth: 500, path: new opentype.Path() }),
      new opentype.Glyph({ name: 'space', unicode: 32, advanceWidth: 350, path: new opentype.Path() }),
      new opentype.Glyph({ name: 'A', unicode: 65, advanceWidth: 600, path: pathData })
    ]
  });
  const font = Buffer.from(fixtureFont.toArrayBuffer());
  await (await import('node:fs/promises')).writeFile(fontPath, font);
  const catalog = {
    schema: 'glyphflow-glyph-catalog/v1',
    fontFamily: 'GlyphFlow QA Fixture',
    metadataCatalog: { unicodeDataVersion: '18.0.0', completeness: 'complete-for-exported-properties' },
    glyphs: [{
      character: 'A',
      codePoints: ['U+0041'],
      glyphName: 'A',
      description: 'Latin capital letter A',
      metadataStatus: 'verified-local-catalog'
    }]
  };
  await (await import('node:fs/promises')).writeFile(catalogPath, JSON.stringify(catalog));
  const result = await buildReleasePackage({ fontPath, catalogPath, outDir });
  assert.equal(result.glyphCount, 1);
  assert.ok(result.files.includes('SHA256SUMS'));
  const archive = await readFile(result.zipPath);
  assert.equal(archive.readUInt32LE(0), 0x04034B50, 'ZIP must begin with a local file header');
  const eocd = archive.readUInt32LE(archive.length - 22);
  assert.equal(eocd, 0x06054B50, 'ZIP must contain a valid end-of-central-directory record');

  // Decode the first ZIP member to ensure the archive uses a valid DEFLATE stream.
  const nameLength = archive.readUInt16LE(26);
  const extraLength = archive.readUInt16LE(28);
  const compressedSize = archive.readUInt32LE(18);
  const dataStart = 30 + nameLength + extraLength;
  const decoded = inflateRawSync(archive.subarray(dataStart, dataStart + compressedSize));
  assert.deepEqual(decoded, font);

  const mismatchedCatalogPath = path.join(root, 'mismatched-catalog.json');
  const mismatchedCatalog = structuredClone(catalog);
  mismatchedCatalog.glyphs[0].codePoints = ['U+0042'];
  await (await import('node:fs/promises')).writeFile(mismatchedCatalogPath, JSON.stringify(mismatchedCatalog));
  await assert.rejects(
    buildReleasePackage({ fontPath, catalogPath: mismatchedCatalogPath, outDir: path.join(root, 'invalid-release') }),
    /Font cmap and glyph catalog do not match/,
    'Release packaging must reject a passport that disagrees with the actual font cmap'
  );

  const manifest = JSON.parse(await readFile(path.join(outDir, 'release-manifest.json'), 'utf8'));
  assert.equal(manifest.licenseStatus, 'not-assigned');
  assert.equal(manifest.publicationStatus, 'preflight-only');
  const sums = await readFile(path.join(outDir, 'SHA256SUMS'), 'utf8');
  assert.match(sums, /[a-f0-9]{64}  GlyphFlow_QA_Fixture-Regular\.otf/);
  console.log('Font release packager tests passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
