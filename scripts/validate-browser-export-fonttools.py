from pathlib import Path
from fontTools.ttLib import TTFont

font_path = Path("test-results/glyphflow-browser-export.ttf")
assert font_path.is_file(), "Browser test did not save the TTF exported by the editor"

font = TTFont(str(font_path), recalcBBoxes=True, recalcTimestamp=False)
required = {"head", "hhea", "maxp", "cmap", "glyf", "loca", "hmtx", "name", "OS/2", "post", "kern"}
missing = required - set(font.keys())
assert not missing, f"Browser-exported TTF is missing tables: {sorted(missing)}"
assert font.sfntVersion == "\x00\x01\x00\x00", "Browser export is not a TrueType sfnt"
assert font["head"].unitsPerEm == 1000, "Unexpected unitsPerEm in browser export"

cmap = font.getBestCmap()
for character in ("А", "Б"):
    assert ord(character) in cmap, f"Browser export is missing cmap entry for {character}"

kern_tables = font["kern"].kernTables
horizontal_format0 = [table for table in kern_tables if table.format == 0 and table.coverage & 0x01]
assert horizontal_format0, "Browser export has no horizontal format-0 kern subtable"
left_name, right_name = cmap[ord("А")], cmap[ord("Б")]
values = [table.kernTable.get((left_name, right_name)) for table in horizontal_format0]
assert -80 in values, f"Independent parser did not find А/Б = -80; found {values!r}"

for character in ("А", "Б"):
    glyph_name = cmap[ord(character)]
    glyph = font["glyf"][glyph_name]
    assert glyph.numberOfContours > 0, f"Exported glyph {character} has no outline"
    advance, lsb = font["hmtx"].metrics[glyph_name]
    assert advance > 0, f"Exported glyph {character} has no advance width"
    assert lsb >= 0, f"Exported glyph {character} has a negative left side bearing"
    assert glyph.yMax <= font["hhea"].ascent, f"Glyph {character} exceeds hhea ascent"
    assert glyph.yMin >= font["hhea"].descent, f"Glyph {character} exceeds hhea descent"

gpos_path = Path("test-results/glyphflow-browser-export-gpos.ttf")
assert gpos_path.is_file(), "Browser test did not save the GPOS-only TTF export"
gpos_font = TTFont(str(gpos_path), recalcBBoxes=True, recalcTimestamp=False)
assert gpos_font.sfntVersion == "\x00\x01\x00\x00", "GPOS browser export is not a TrueType sfnt"
assert "GPOS" in gpos_font, "GPOS browser export is missing GPOS"
assert "kern" not in gpos_font, "GPOS browser export must not also contain legacy kern"
gpos_cmap = gpos_font.getBestCmap()
left_name, right_name = gpos_cmap[ord("А")], gpos_cmap[ord("Б")]
gpos_table = gpos_font["GPOS"].table
feature_records = gpos_table.FeatureList.FeatureRecord
kern_features = [record.Feature for record in feature_records if record.FeatureTag == "kern"]
assert kern_features, "GPOS export has no 'kern' feature"
lookup_indices = {index for feature in kern_features for index in feature.LookupListIndex}
found_pair = []
for index in lookup_indices:
    lookup = gpos_table.LookupList.Lookup[index]
    if lookup.LookupType != 2:
        continue
    for subtable in lookup.SubTable:
        if subtable.Format != 1:
            continue
        coverage = subtable.Coverage.glyphs
        if left_name not in coverage:
            continue
        pair_set = subtable.PairSet[coverage.index(left_name)]
        for record in pair_set.PairValueRecord:
            if record.SecondGlyph == right_name:
                found_pair.append(record.Value1.XAdvance if record.Value1 else None)
assert -80 in found_pair, f"FontTools did not find GPOS А/Б = -80; found {found_pair!r}"
for character in ("А", "Б"):
    glyph_name = gpos_cmap[ord(character)]
    assert gpos_font["glyf"][glyph_name].numberOfContours > 0, f"GPOS export glyph {character} has no outline"

print("Independent FontTools validation passed for both real browser exports: legacy kern-only and modern GPOS-only, with А/Б = -80.")
