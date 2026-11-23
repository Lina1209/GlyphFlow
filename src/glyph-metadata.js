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

const unicodeRecords = new Map();
let unicodeRanges = [];
let unicodeCatalogPromise = null;
let loadedUnicodeVersion = null;

const CATEGORY_LABELS = {
  Lu:'Заглавная буква', Ll:'Строчная буква', Lt:'Буква верхнего регистра',
  Lm:'Модификатор-буква', Lo:'Другая буква',
  Mn:'Некомбинируемый диакритический знак', Mc:'Комбинируемый знак с пробелом', Me:'Обрамляющий знак',
  Nd:'Десятичная цифра', Nl:'Буквенное число', No:'Другая цифра или число',
  Pc:'Соединительная пунктуация', Pd:'Тире и дефисы', Ps:'Открывающая пунктуация',
  Pe:'Закрывающая пунктуация', Pi:'Начальная кавычка', Pf:'Конечная кавычка', Po:'Другая пунктуация',
  Sm:'Математический символ', Sc:'Денежный символ', Sk:'Модифицирующий символ', So:'Другой символ',
  Zs:'Пробельный разделитель', Zl:'Разделитель строк', Zp:'Разделитель абзацев',
  Cc:'Управляющий символ', Cf:'Форматирующий символ', Cs:'Суррогат', Co:'Область частного использования',
  Cn:'Неназначенная кодовая точка'
};

function isOfficialCharacterName(name) {
  return typeof name === 'string' && name.length > 0 && !/^<.*>$/.test(name);
}

function getUnicodeRecord(codePoint) {
  const direct = unicodeRecords.get(codePoint);
  if (direct) return direct;
  let low = 0, high = unicodeRanges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = unicodeRanges[middle];
    if (codePoint < range.start) high = middle - 1;
    else if (codePoint > range.end) low = middle + 1;
    else {
      const suffix = codePoint.toString(16).toUpperCase().padStart(range.hexWidth, '0');
      return {name:range.namePrefix + suffix, category:range.category, combiningClass:range.combiningClass, script:range.script};
    }
  }
  return null;
}

/**
 * Load the pinned, compact Unicode runtime catalog once per page session.
 * The service worker caches this same-origin request for subsequent offline use.
 */
export async function loadUnicodeCatalog(options = {}) {
  if (loadedUnicodeVersion) return loadedUnicodeVersion;
  if (unicodeCatalogPromise) return unicodeCatalogPromise;
  const fetcher = options.fetcher || globalThis.fetch;
  const baseUrl = import.meta.env?.BASE_URL || './';
  const url = options.url || baseUrl + 'data/unicode/18.0.0/runtime-catalog.json';
  unicodeCatalogPromise = (async () => {
    if (typeof fetcher !== 'function') throw new Error('Fetch API is unavailable.');
    const response = await fetcher(url, {headers:{Accept:'application/json'}});
    if (!response || !response.ok) throw new Error('Unicode catalog request failed: ' + (response?.status || 'network error'));
    const catalog = await response.json();
    if (!catalog || catalog.schema !== 'glyphflow-unicode-runtime/v1' ||
        catalog.unicodeVersion !== '18.0.0' || !Array.isArray(catalog.records) ||
        !Array.isArray(catalog.ranges) || catalog.records.length < 10000) {
      throw new Error('Unicode runtime catalog has an unsupported schema or incomplete data.');
    }
    const nextRecords = new Map();
    let previousCodePoint = -1;
    for (const item of catalog.records) {
      if (!Array.isArray(item) || item.length !== 5) throw new Error('Malformed Unicode runtime record.');
      const [cp, name, category, combiningClass, script] = item;
      if (!Number.isInteger(cp) || cp <= previousCodePoint || cp < 0 || cp > 0x10FFFF ||
          typeof name !== 'string' || !/^[A-Z][a-z]$/.test(category) ||
          !Number.isInteger(combiningClass) || combiningClass < 0 || combiningClass > 255 ||
          typeof script !== 'string' || !script) throw new Error('Invalid Unicode runtime record.');
      nextRecords.set(cp, {name, category, combiningClass, script});
      previousCodePoint = cp;
    }
    const nextRanges = [];
    let previousEnd = -1;
    for (const item of catalog.ranges) {
      if (!Array.isArray(item) || item.length !== 6) throw new Error('Malformed Unicode algorithmic range.');
      const [start, end, nameTemplate, category, combiningClass, script] = item;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start <= previousEnd ||
          start >= end || end > 0x10FFFF || typeof nameTemplate !== 'string' ||
          !/^[A-Z][a-z]$/.test(category) || !Number.isInteger(combiningClass) ||
          combiningClass < 0 || combiningClass > 255 || typeof script !== 'string' || !script) {
        throw new Error('Invalid Unicode algorithmic range.');
      }
      const match = /^(.*?)([0-9A-F]+)$/i.exec(nameTemplate);
      if (!match) throw new Error('Unicode algorithmic range has no hexadecimal name template.');
      nextRanges.push({start,end,namePrefix:match[1],hexWidth:match[2].length,category,combiningClass,script});
      previousEnd = end;
    }
    unicodeRecords.clear();
    for (const [cp, record] of nextRecords) unicodeRecords.set(cp, record);
    unicodeRanges = nextRanges;
    loadedUnicodeVersion = catalog.unicodeVersion;
    return loadedUnicodeVersion;
  })().catch(error => {
    unicodeCatalogPromise = null;
    throw error;
  });
  return unicodeCatalogPromise;
}

export function getLoadedUnicodeVersion() {
  return loadedUnicodeVersion;
}

export function getGlyphMetadata(char) {
  const codePoint = getSingleCodePoint(char);
  if (codePoint === null) return null;
  const local = metadata.get(char);
  const official = getUnicodeRecord(codePoint);
  if (official) {
    const unicodeName = isOfficialCharacterName(official.name) ? official.name : null;
    const glyphName = local?.glyphName || (codePoint <= 0xFFFF
      ? 'uni' + codePoint.toString(16).toUpperCase().padStart(4, '0')
      : 'u' + codePoint.toString(16).toUpperCase().padStart(5, '0'));
    const category = CATEGORY_LABELS[official.category] || 'Символ Unicode';
    const script = official.script;
    const description = local?.description ||
      (unicodeName ? 'Официальное имя Unicode: ' + unicodeName + '. ' : '') +
      category + (script && script !== 'Common' && script !== 'Inherited' && script !== 'Unknown'
        ? ' письменности ' + script + '.' : ' из набора Unicode.');
    return Object.freeze({
      character:char,
      codePoint:'U+' + codePoint.toString(16).toUpperCase().padStart(4,'0'),
      codePointValue:codePoint,
      unicodeName,
      glyphName,
      category,
      generalCategory:official.category,
      combiningClass:official.combiningClass,
      description,
      script,
      metadataSource:'Unicode Character Database 18.0.0',
      metadataStatus:unicodeName ? 'verified-ucd' : 'needs-review'
    });
  }
  if (local) return local;
  return Object.freeze({
    character:char,
    codePoint:'U+' + codePoint.toString(16).toUpperCase().padStart(4,'0'),
    codePointValue:codePoint,
    unicodeName:null,
    glyphName:codePoint <= 0xFFFF
      ? 'uni' + codePoint.toString(16).toUpperCase().padStart(4,'0')
      : 'u' + codePoint.toString(16).toUpperCase().padStart(5,'0'),
    category:'Пользовательский символ',
    generalCategory:'Unknown',
    combiningClass:null,
    description:'Официальное имя Unicode не включено в загруженный каталог. Проверьте символ по Unicode Character Database.',
    script:'Не определена',
    metadataSource:'Fallback',
    metadataStatus:'needs-review'
  });
}
