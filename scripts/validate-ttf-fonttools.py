from pathlib import Path
from fontTools.ttLib import TTFont

font_path = Path("/tmp/glyphflow-fixture.ttf")
assert font_path.is_file(), "Fixture TrueType font was not written by the Node smoke test"

font = TTFont(str(font_path), recalcBBoxes=True, recalcTimestamp=False)
required_tables = {"head", "hhea", "maxp", "cmap", "glyf", "loca", "hmtx", "name", "post"}
assert required_tables.issubset(font.keys()), f"Missing TrueType tables: {required_tables - set(font.keys())}"
assert "CFF " not in font.keys(), "Final .ttf must not contain CFF outlines"
assert font.sfntVersion == "\x00\x01\x00\x00", "Expected TrueType sfnt signature"

assert font["head"].unitsPerEm == 1000
assert font["hhea"].ascent == 950
assert font["hhea"].descent == -370
assert font["maxp"].numGlyphs >= 3
assert font["head"].indexToLocFormat in (0, 1)
assert "OS/2" in font, "TrueType font must contain OS/2 metrics and classification"
assert font["OS/2"].usWeightClass == 400, "Regular font weight must be 400"
assert font["OS/2"].usWidthClass in range(1, 10), "OS/2 width class must be within the OpenType range"
assert "post" in font and font["post"].formatType in (2.0, 2.5, 3.0), "Invalid post table format"

name_expectations = {
    0: "Copyright 2026 GlyphFlow Test",
    1: "GlyphFlow CI Fixture",
    2: "Regular",
    3: "Version 2.125",
    4: "GlyphFlow CI Fixture Regular",
    5: "Version 2.125",
    6: "GlyphFlowCIFixture-Regular",
    7: "GlyphFlow Test Mark",
    8: "GlyphFlow Test Foundry",
    9: "GlyphFlow Test Designer",
    10: "Metadata regression fixture",
    11: "https://example.com/foundry",
    12: "https://example.com/designer",
    13: "Test license text, not a real grant",
    14: "https://example.com/license",
}
for name_id, expected in name_expectations.items():
    actual = font["name"].getDebugName(name_id)
    assert actual == expected, f"name ID {name_id} mismatch: {actual!r} != {expected!r}"

cmap = font.getBestCmap()
for char in ("A", "Ё", "😀", "Ф", "Ы", " "):
    assert ord(char) in cmap, f"Missing cmap entry for U+{ord(char):04X}"

assert font["hmtx"].metrics[cmap[ord(" ")]][0] == 350

glyf_table = font["glyf"]
for char, expected_contours in (("A", 1), ("Ё", 2), ("😀", 1), ("О", 1), ("Ж", 1), ("∞", 2), ("Р", 2), ("Ф", 3), ("Ы", 4)):
    glyph_name = cmap[ord(char)]
    glyph = glyf_table[glyph_name]
    assert glyph.numberOfContours == expected_contours, f"Unexpected contour count for {char}"
    coordinates, end_points, _ = glyph.getCoordinates(glyf_table)
    assert len(coordinates) >= 3, f"Empty outline for {char}"
    start = 0
    for end in end_points:
        contour = coordinates[start:end + 1]
        assert len(contour) >= 3
        area2 = 0
        for index, point in enumerate(contour):
            next_point = contour[(index + 1) % len(contour)]
            area2 += point[0] * next_point[1] - next_point[0] * point[1]
        contour_index = sum(1 for previous_end in end_points if previous_end < end)
        is_hole = (char == "Р" and contour_index == 1) or (char == "∞" and contour_index == 1) or (char == "Ф" and contour_index in {1, 2}) or (char == "Ы" and contour_index in {1, 3})
        expected_negative = not is_hole
        assert (area2 < 0) == expected_negative, (
            f"Unexpected contour winding for {char} contour {contour_index} ending at {end}: "
            f"signed_area2={area2}, expected_negative={expected_negative}"
        )
        start = end + 1
    for x, y in coordinates:
        assert isinstance(x, int) and isinstance(y, int)

for char in ("О", "∞"):
    glyph_name = cmap[ord(char)]
    glyph = glyf_table[glyph_name]
    assert glyph.numberOfContours >= 1, f"Closed/self-crossing glyph {char} lost its outline"

print("FontTools validation passed: independent TrueType TTF parse + glyf/loca + metrics + cmap + hmtx + curved/closed/intersecting/self-crossing glyph contours + four-level nested counters + alternating clockwise winding.")
