/* Shared Excel reader for the public catalogue and the owner's local checker. */
export const COLUMNS = [
  ['id', 'Номер записи'], ['category', 'Категория'], ['a_brand', 'Бренд исходный'],
  ['a', 'Исходная модель / наименование'], ['kind', 'Тип записи'], ['b_brand', 'Бренд результата'],
  ['b', 'Аналог / комплектующая / артикул'], ['a_specs', 'Характеристики исходной модели'],
  ['b_specs', 'Характеристики результата'], ['note', 'Условия и сведения источника'],
  ['source', 'Источник: файл, лист, строка'], ['status', 'Статус записи']
];
export const KINDS = ['Сопоставление по таблице', 'Аналог по источнику',
  'Текстовое сопоставление по источнику', 'Примерный аналог по источнику',
  'Артикул аналога', 'Подходящая комплектующая'];
export const CATALOG_FILE = 'Каталог аналогов.xlsx';
export const text = v => String(v ?? '');
export const tidy = v => text(v).trim().replace(/\s+/g, ' ');
export const escape = v => text(v).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const lookalikes = {'А':'A','В':'B','С':'C','Е':'E','Н':'H','К':'K','М':'M','О':'O','Р':'P','Т':'T','Х':'X','У':'Y'};
export function normalize(v) {
  return text(v).normalize('NFKC').toUpperCase().replace(/[АВСЕНКМОРТХУ]/g, c => lookalikes[c])
    .replace(/[‐‑‒–—−]/g, '-').replace(/[\s\u200b\uFEFF]/g, '');
}
function xml(value, label) {
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw Error(`Неподдерживаемое содержимое: ${label}.`);
  const doc = new DOMParser().parseFromString(value, 'application/xml');
  if (doc.querySelector('parsererror')) throw Error(`Не удалось прочитать ${label}. Пересохраните файл в формате .xlsx.`);
  return doc;
}
const nodes = (doc, name) => [...doc.getElementsByTagNameNS('*', name)];
const stringValue = node => nodes(node, 't').map(t => t.textContent).join('');
function columnNumber(address) {
  const m = /^([A-Z]+)[1-9]\d*$/.exec(address);
  if (!m) throw Error('В Excel обнаружен неверный адрес ячейки.');
  return [...m[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}

// Reads text, shared strings and cached scalar values, never runs Excel formulas.
export async function readCatalog(buffer) {
  if (buffer.byteLength > 25 * 1024 * 1024) throw Error('Файл больше 25 МБ. Разделите каталог или удалите лишние изображения.');
  let zip;
  try { zip = await globalThis.JSZip.loadAsync(buffer); }
  catch { throw Error('Не удалось открыть Excel. Нужен обычный файл .xlsx без пароля.'); }
  let expandedBytes = 0;
  async function entry(path, required = true) {
    const file = zip.file(path);
    if (!file) { if (!required) return null; throw Error('Не найдена структура Excel. Нужен файл .xlsx, а не .xls или CSV.'); }
    const value = await file.async('string');
    expandedBytes += value.length;
    if (expandedBytes > 80 * 1024 * 1024) throw Error('Слишком большой объём данных внутри Excel.');
    return xml(value, path);
  }
  const workbook = await entry('xl/workbook.xml');
  const sheet = nodes(workbook, 'sheet').find(s => s.getAttribute('name') === 'Каталог');
  if (!sheet) throw Error('В файле нужен лист «Каталог». Сохраните его название.');
  const relations = await entry('xl/_rels/workbook.xml.rels');
  const id = sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  const rel = nodes(relations, 'Relationship').find(r => r.getAttribute('Id') === id);
  if (!rel || rel.getAttribute('TargetMode') === 'External') throw Error('Лист «Каталог» недоступен.');
  const target = rel.getAttribute('Target');
  const sheetPath = new URL(target, 'https://xlsx.invalid/xl/workbook.xml').pathname.slice(1);
  if (!sheetPath.startsWith('xl/')) throw Error('Некорректный путь к листу «Каталог».');
  const stringsDoc = await entry('xl/sharedStrings.xml', false);
  const strings = stringsDoc ? nodes(stringsDoc, 'si').map(stringValue) : [];
  const sheetDoc = await entry(sheetPath);
  const allRows = nodes(sheetDoc, 'row');
  if (allRows.length > 50001) throw Error('В каталоге больше 50 000 строк. Для этого объёма требуется отдельная настройка.');
  const errors = [], warnings = [];
  const rows = [];
  for (const row of allRows) {
    const values = [], number = Number(row.getAttribute('r'));
    for (const cell of nodes(row, 'c')) {
      const index = columnNumber(cell.getAttribute('r') || '');
      const type = cell.getAttribute('t');
      const raw = nodes(cell, 'v')[0]?.textContent ?? '';
      let value = type === 's' ? strings[Number(raw)] : type === 'inlineStr' ? stringValue(cell) : raw;
      value = text(value);
      if (nodes(cell, 'f').length) errors.push({row:number, message:`${cell.getAttribute('r')}: замените формулу её значением.`});
      if (type === 'e') errors.push({row:number, message:`${cell.getAttribute('r')}: ошибка Excel ${value}.`});
      if (index < COLUMNS.length) values[index] = value;
      else if (tidy(value)) errors.push({row:number, message:`Лишний заполненный столбец ${cell.getAttribute('r')}. Ожидается 12 столбцов.`});
    }
    if (values.some(v => tidy(v))) rows.push({number, values});
  }
  const header = rows.shift();
  if (!header || header.number !== 1 || COLUMNS.some(([, title], i) => tidy(header.values[i]) !== title)) {
    throw Error('Изменены заголовки таблицы. В первой строке должны быть 12 столбцов согласованного каталога в прежнем порядке.');
  }
  const records = [], ids = new Map(), pairs = new Map();
  for (const {number, values} of rows) {
    const record = Object.fromEntries(COLUMNS.map(([key], i) => [key, text(values[i])]));
    for (const key of ['id','category','a','kind','b']) {
      if (!tidy(record[key])) errors.push({row:number, message:`Не заполнено поле «${COLUMNS.find(c => c[0] === key)[1]}».`});
    }
    const recordId = tidy(record.id);
    if (recordId && ids.has(recordId)) errors.push({row:number, message:`Номер записи «${recordId}» повторяется (строка ${ids.get(recordId)}).`});
    ids.set(recordId, number);
    if (!KINDS.includes(tidy(record.kind))) errors.push({row:number, message:'Неизвестный тип записи. Используйте тип из существующих строк.'});
    const pair = JSON.stringify(['category','a_brand','a','kind','b_brand','b'].map(k => tidy(record[k])));
    if (pairs.has(pair)) warnings.push({row:number, message:`Соответствие также есть в строке ${pairs.get(pair)}. Если источники или условия разные, обе строки можно сохранить.`});
    else pairs.set(pair, number);
    records.push(record);
  }
  if (!records.length) errors.push({row:1, message:'В каталоге нет данных.'});
  return {records, errors, warnings};
}

export function compareCatalogs(oldRecords, newRecords) {
  const oldMap = new Map(oldRecords.map(r => [tidy(r.id), r]));
  const newMap = new Map(newRecords.map(r => [tidy(r.id), r]));
  const added = [], removed = [], changed = [];
  for (const [id, next] of newMap) {
    const prev = oldMap.get(id);
    if (!prev) added.push(next);
    else {
      const fields = COLUMNS.filter(([key]) => text(prev[key]) !== text(next[key])).map(([key, title]) => ({key, title, before:prev[key], after:next[key]}));
      if (fields.length) changed.push({id, before:prev, after:next, fields});
    }
  }
  for (const [id, prev] of oldMap) if (!newMap.has(id)) removed.push(prev);
  return {added, removed, changed, unchanged:newRecords.length - added.length - changed.length};
}
