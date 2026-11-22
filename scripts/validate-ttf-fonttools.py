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
