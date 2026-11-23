export function getSingleCodePoint(character) {
  if (typeof character !== 'string') return null;
  const scalars = [...character];
  if (scalars.length !== 1) return null;
  const value = scalars[0].codePointAt(0);
  // Unicode scalar values exclude the UTF-16 surrogate range.
  return value >= 0xD800 && value <= 0xDFFF ? null : value;
}

const CYRILLIC_UPPER = [...'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'];
const CYRILLIC_UPPER_NAMES = [
  'A', 'BE', 'VE', 'GHE', 'DE', 'IE', 'IO', 'ZHE', 'ZE', 'I', 'SHORT I',
  'KA', 'EL', 'EM', 'EN', 'O', 'PE', 'ER', 'ES', 'TE', 'U', 'EF',
  'HA', 'TSE', 'CHE', 'SHA', 'SHCHA', 'HARD SIGN', 'YERU',
  'SOFT SIGN', 'E', 'YU', 'YA'
];
const CYRILLIC_LOWER = [...'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'];
const LATIN_UPPER = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
const LATIN_LOWER = [...'abcdefghijklmnopqrstuvwxyz'];
const DIGITS = [...'0123456789'];
const DIGIT_NAMES = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
const PUNCTUATION = {
  '!': ['EXCLAMATION MARK', 'exclam', 'Знак восклицания', 'Po'],
  '?': ['QUESTION MARK', 'question', 'Вопросительный знак', 'Po'],
  '.': ['FULL STOP', 'period', 'Точка', 'Po'],
  ',': ['COMMA', 'comma', 'Запятая', 'Po'],
  '-': ['HYPHEN-MINUS', 'hyphen', 'Дефис / знак минус', 'Pd']
};
const LATIN_DIGIT_GLYPHS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const CYRILLIC_NAME_BY_CHAR = new Map();
CYRILLIC_UPPER.forEach((char, index) => CYRILLIC_NAME_BY_CHAR.set(char, 'CYRILLIC CAPITAL LETTER ' + CYRILLIC_UPPER_NAMES[index]));
CYRILLIC_LOWER.forEach((char, index) => CYRILLIC_NAME_BY_CHAR.set(char, 'CYRILLIC SMALL LETTER ' + CYRILLIC_UPPER_NAMES[index]));

const metadata = new Map();
function add(char, unicodeName, glyphName, category, generalCategory, description, script) {
  metadata.set(char, Object.freeze({
    character: char,
    codePoint: 'U+' + char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'),
    codePointValue: char.codePointAt(0),
    unicodeName,
    glyphName,
    category,
    generalCategory,
    description,
    script
  }));
}

for (const char of CYRILLIC_UPPER) {
  add(char, CYRILLIC_NAME_BY_CHAR.get(char), 'uni' + char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'),
    'Заглавная буква', 'Lu', 'Заглавная буква кириллицы «' + char + '»', 'Cyrillic');
}
for (const char of CYRILLIC_LOWER) {
  add(char, CYRILLIC_NAME_BY_CHAR.get(char), 'uni' + char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'),
    'Строчная буква', 'Ll', 'Строчная буква кириллицы «' + char + '»', 'Cyrillic');
}
for (const char of LATIN_UPPER) {
  add(char, 'LATIN CAPITAL LETTER ' + char, char, 'Заглавная буква', 'Lu',
    'Заглавная буква латиницы «' + char + '»', 'Latin');
}
for (const char of LATIN_LOWER) {
  add(char, 'LATIN SMALL LETTER ' + char.toUpperCase(), char, 'Строчная буква', 'Ll',
    'Строчная буква латиницы «' + char + '»', 'Latin');
}
for (const [index, char] of DIGITS.entries()) {
  add(char, 'DIGIT ' + DIGIT_NAMES[index], LATIN_DIGIT_GLYPHS[index], 'Цифра', 'Nd',
    'Арабская цифра ' + char, 'Common');
}
for (const [char, [unicodeName, glyphName, description, generalCategory]] of Object.entries(PUNCTUATION)) {
  add(char, unicodeName, glyphName, 'Пунктуация', generalCategory, description, 'Common');
}
add(' ', 'SPACE', 'space', 'Пробел', 'Zs', 'Межсловный пробел', 'Common');

export function getGlyphMetadata(char) {
  const codePoint = getSingleCodePoint(char);
  if (codePoint === null) return null;
  const known = metadata.get(char);
  if (known) return known;
  return Object.freeze({
    character: char,
    codePoint: 'U+' + codePoint.toString(16).toUpperCase().padStart(4, '0'),
    codePointValue: codePoint,
    unicodeName: null,
    glyphName: codePoint <= 0xFFFF
      ? 'uni' + codePoint.toString(16).toUpperCase().padStart(4, '0')
      : 'u' + codePoint.toString(16).toUpperCase().padStart(5, '0'),
    category: 'Пользовательский символ',
    generalCategory: 'Unknown',
    description: 'Официальное имя Unicode не включено в локальный каталог. Проверьте символ по актуальной Unicode Character Database.',
    script: 'Не определена'
  });
}
