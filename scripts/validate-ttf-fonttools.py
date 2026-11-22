from pathlib import Path
from fontTools.ttLib import TTFont

font_path = Path("/tmp/glyphflow-fixture.ttf")
assert font_path.is_file(), "Fixture TTF was not written by the Node smoke test"

font = TTFont(str(font_path), recalcBBoxes=True, recalcTimestamp=False)
required_tables = {"head", "hhea", "maxp", "cmap", "glyf", "hmtx", "name"}
assert required_tables.issubset(font.keys()), f"Missing tables: {required_tables - set(font.keys())}"

assert font["head"].unitsPerEm == 1000
assert font["hhea"].ascent == 900
assert font["hhea"].descent == -300

cmap = font.getBestCmap()
for char in ("A", "Ё", "😀", " "):
    assert ord(char) in cmap, f"Missing cmap entry for U+{ord(char):04X}"

assert font["hmtx"].metrics[cmap[ord(" ")]][0] == 350
assert font["glyf"][cmap[ord("A")]].numberOfContours == 1
assert font["glyf"][cmap[ord("Ё")]].numberOfContours == 2

# Verify all fixture outline coordinates and the clockwise winding of each
# independently generated stroke contour after parsing with FontTools.
for char in ("A", "Ё", "😀"):
    glyph_name = cmap[ord(char)]
    glyph = font["glyf"][glyph_name]
    coordinates, end_points, _ = glyph.getCoordinates(font["glyf"])
    assert len(coordinates) >= 3, f"Empty outline for {char}"
    start = 0
    for end in end_points:
        contour = coordinates[start:end + 1]
        assert len(contour) >= 3
        area2 = 0
        for index, point in enumerate(contour):
            next_point = contour[(index + 1) % len(contour)]
            area2 += point[0] * next_point[1] - next_point[0] * point[1]
        assert area2 < 0, f"Contour winding is not clockwise for {char}"
        start = end + 1
    for x, y in coordinates:
        assert isinstance(x, int) and isinstance(y, int)

print("FontTools validation passed: independent TTF parse + required tables + metrics + cmap + hmtx + contour counts + clockwise winding.")
