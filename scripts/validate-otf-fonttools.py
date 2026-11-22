from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import RecordingPen

font_path = Path("/tmp/glyphflow-fixture.otf")
assert font_path.is_file(), "Fixture OpenType font was not written by the Node smoke test"

font = TTFont(str(font_path), recalcBBoxes=True, recalcTimestamp=False)
required_tables = {"head", "hhea", "maxp", "cmap", "CFF ", "hmtx", "name", "post"}
assert required_tables.issubset(font.keys()), f"Missing tables: {required_tables - set(font.keys())}"
assert "glyf" not in font.keys() and "loca" not in font.keys(), "Expected CFF outlines, not TrueType glyf outlines"
assert font.sfntVersion == "OTTO", "CFF OpenType output must use the OTTO signature"

assert font["head"].unitsPerEm == 1000
assert font["hhea"].ascent == 900
assert font["hhea"].descent == -300

cmap = font.getBestCmap()
for char in ("A", "Ё", "😀", " "):
    assert ord(char) in cmap, f"Missing cmap entry for U+{ord(char):04X}"

assert font["hmtx"].metrics[cmap[ord(" ")]][0] == 350

glyph_set = font.getGlyphSet()
for char, expected_contours in (("A", 1), ("Ё", 2), ("😀", 1)):
    glyph_name = cmap[ord(char)]
    pen = RecordingPen()
    glyph_set[glyph_name].draw(pen)
    contours = []
    current = []
    for operation, points in pen.value:
        if operation == "moveTo":
            if current:
                contours.append(current)
            current = [tuple(points[0])]
        elif operation == "lineTo":
            current.append(tuple(points[0]))
        elif operation == "closePath":
            if current:
                contours.append(current)
                current = []
        elif operation not in ("endPath",):
            raise AssertionError(f"Unexpected curve operation {operation!r} in line-only fixture")
    if current:
        contours.append(current)
    assert len(contours) == expected_contours, f"Unexpected contour count for {char}: {len(contours)}"
    for contour in contours:
        assert len(contour) >= 3
        area2 = 0
        for index, point in enumerate(contour):
            next_point = contour[(index + 1) % len(contour)]
            area2 += point[0] * next_point[1] - next_point[0] * point[1]
        assert area2 < 0, f"Contour winding is not clockwise for {char}"
        for x, y in contour:
            assert x == x and y == y, f"Non-finite coordinate in {char}"

print("FontTools validation passed: independent CFF/OTF parse + required tables + OTTO signature + metrics + cmap + hmtx + contour counts + clockwise winding.")
