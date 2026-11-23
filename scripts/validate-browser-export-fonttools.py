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

print("Independent FontTools validation passed for the actual browser-exported TTF: cmap А/Б, outlines, horizontal kern format-0 pair -80, hmtx and vertical bounds.")
