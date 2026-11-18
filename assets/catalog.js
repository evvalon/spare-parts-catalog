/* Shared Excel reader for the public catalogue and the owner's local checker. */
export const COLUMNS = [
  ['id', 'Номер записи'], ['category', 'Категория'], ['a_brand', 'Бренд исходный'],
  ['a', 'Исходная модель / наименование'], ['kind', 'Тип записи'], ['b_brand', 'Бренд результата'],
  ['b', 'Аналог / комплектующая / артикул'], ['a_specs', 'Характеристики исходной модели'],
  ['b_specs', 'Характеристики результата'], ['note', 'Условия и сведения источника'],
  ['source', 'Источник: файл, лист, строка'], ['status', 'Статус записи']
];
export const NO_ANALOG_KIND = 'Модель без соответствия';
export const KINDS = [NO_ANALOG_KIND,'Сопоставление по таблице', 'Аналог по источнику',
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
  // The archive decoder preserves a UTF-8 BOM as U+FEFF. Remove the
  // encoding signature before passing the already decoded string to XML parsers.
  value = value.replace(/^\uFEFF/, '');
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

// Explicit dependency readiness also covers delayed/failed vendor loading.
let zipReady;
async function ensureZip() {
  if (globalThis.JSZip) return globalThis.JSZip;
  if (!zipReady) zipReady = new Promise((resolve,reject) => {
    const script=document.createElement('script');
    const timer=setTimeout(()=>finish(Error('Не загрузился модуль чтения Excel. Проверьте соединение и нажмите «Повторить».')),15000);
    function finish(error){clearTimeout(timer);script.onload=script.onerror=null;if(error){zipReady=null;reject(error);}else resolve(globalThis.JSZip);}
    script.src=new URL('./assets/vendor/jszip.min.js?v=20261118-owner1',document.baseURI).href;
    script.onload=()=>finish(globalThis.JSZip?null:Error('Модуль чтения Excel недоступен. Нажмите «Повторить».'));
    script.onerror=()=>finish(Error('Не удалось скачать модуль чтения Excel. Проверьте соединение и нажмите «Повторить».'));
    document.head.append(script);
  });
  return zipReady;
}

// Reads text, shared strings and cached scalar values, never runs Excel formulas.
export async function readCatalog(buffer) {
  if (buffer.byteLength > 25 * 1024 * 1024) throw Error('Файл больше 25 МБ. Разделите каталог или удалите лишние изображения.');
  const zipLibrary=await ensureZip();
  let zip;
  try { zip = await zipLibrary.loadAsync(buffer); }
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
  const rows = [], physicalRows=new Set();
  for (const row of allRows) {
    const rowAddress=row.getAttribute('r')||'', number=Number(rowAddress);
    if(!/^[1-9]\d*$/.test(rowAddress)||!Number.isSafeInteger(number)||number>1048576)throw Error('В Excel обнаружен некорректный номер строки. Пересохраните файл в Excel.');
    if(physicalRows.has(number))throw Error('В Excel повторяется строка '+number+'. Пересохраните файл в Excel.');
    physicalRows.add(number);
    const values=[],cellAddresses=new Set();
    for (const cell of nodes(row, 'c')) {
      const address=cell.getAttribute('r')||'',index=columnNumber(address);
      if(Number(address.replace(/^[A-Z]+/,''))!==number)throw Error('Адрес ячейки '+address+' не соответствует строке '+number+'. Пересохраните файл в Excel.');
      if(cellAddresses.has(address))throw Error('В Excel повторяется ячейка '+address+'. Пересохраните файл в Excel.');
      cellAddresses.add(address);
      const type = cell.getAttribute('t');
      const raw = nodes(cell, 'v')[0]?.textContent ?? '';
      if(type==='s'&&(!/^\d+$/.test(raw.trim())||!Number.isSafeInteger(Number(raw))||Number(raw)>=strings.length))throw Error('Повреждён текст ячейки '+address+'. Пересохраните файл в Excel.');
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
  const records = [], rowNumbers=[],ids = new Map(), pairs = new Map();
  for (const {number, values} of rows) {
    const record = Object.fromEntries(COLUMNS.map(([key], i) => [key, text(values[i])]));
    for (const key of ['id','category','a','kind',...(tidy(record.kind)===NO_ANALOG_KIND?[]:['b'])]) {
      if (!tidy(record[key])) errors.push({row:number, message:`Не заполнено поле «${COLUMNS.find(c => c[0] === key)[1]}».`});
    }
    const recordId = tidy(record.id);
    if (recordId && ids.has(recordId)) errors.push({row:number, message:`Номер записи «${recordId}» повторяется (строка ${ids.get(recordId)}).`});
    ids.set(recordId, number);
    if (!KINDS.includes(tidy(record.kind))) errors.push({row:number, message:'Неизвестный тип записи. Используйте тип из существующих строк.'});
    if(tidy(record.kind)===NO_ANALOG_KIND&&tidy(record.b))errors.push({row:number,message:'У записи «Модель без соответствия» заполнен аналог. Укажите подходящий тип связи.'});
    const pair = JSON.stringify(['category','a_brand','a','kind','b_brand','b'].map(k => tidy(record[k])));
    if (pairs.has(pair)) warnings.push({row:number, pair, firstRow:pairs.get(pair), message:`Пара «${tidy(record.a)} → ${tidy(record.b)||'аналог не указан'}» также есть в строке ${pairs.get(pair)}. Разные источники или условия можно сохранить отдельными строками.`});
    else pairs.set(pair, number);
    records.push(record);
    rowNumbers.push(number);
  }
  if (!records.length) errors.push({row:1, message:'В каталоге нет данных.'});
  return {records, errors, warnings,rowNumbers};
}

export function compareCatalogs(oldRecords, newRecords, options={}) {
  // Invalid data fields can still be compared. Ambiguous identities cannot:
  // exclude their ID on BOTH sides rather than silently overwriting a Map entry.
  const index=(records,rows)=>{
    const map=new Map();records.forEach((record,i)=>{const id=tidy(record.id);if(!map.has(id))map.set(id,[]);map.get(id).push({record,row:rows?.[i]??i+2});});return map;
  };
  const oldIndex=index(oldRecords,options.oldRowNumbers),newIndex=index(newRecords,options.newRowNumbers);
  const blocked=new Set([...oldIndex,...newIndex].filter(([id,items])=>!id||items.length>1).map(([id])=>id));
  const unmatched=[];
  for(const [side,entries] of [['old',oldIndex],['new',newIndex]])for(const [id,items] of entries)if(blocked.has(id))for(const item of items)unmatched.push({...item,id,side,reason:id?'Номер повторяется в одной из версий. Нельзя однозначно выбрать соответствующую строку.':'Не заполнен номер записи. Нельзя сопоставить строку между версиями.'});
  const oldMap=new Map([...oldIndex].filter(([id])=>!blocked.has(id)).map(([id,items])=>[id,items[0]]));
  const newMap=new Map([...newIndex].filter(([id])=>!blocked.has(id)).map(([id,items])=>[id,items[0]]));
  const added = [], removed = [], changed = [];
  let unchanged=0;
  for (const [id, nextItem] of newMap) {
    const next=nextItem.record,prevItem = oldMap.get(id),prev=prevItem?.record;
    if (!prev) {
      if(oldIndex.has(''))unmatched.push({...nextItem,id,side:'new',reason:'В прежнем файле есть строки без номера. Нельзя надёжно определить, добавлена ли эта запись или ей присвоили номер.'});
      else added.push({...next,_row:nextItem.row});
    }
    else {
      const fields = COLUMNS.filter(([key]) => tidy(prev[key]) !== tidy(next[key])).map(([key, title]) => ({key, title, before:prev[key], after:next[key]}));
      if (fields.length) changed.push({id, before:prev, after:next, fields,beforeRow:prevItem.row,afterRow:nextItem.row});
      else unchanged++;
    }
  }
  for (const [id, prev] of oldMap) if (!newMap.has(id)) {
    if(newIndex.has(''))unmatched.push({...prev,id,side:'old',reason:'В новом файле есть строки без номера. Нельзя надёжно определить, удалена ли эта запись или у неё стёрли номер.'});
    else removed.push({...prev.record,_row:prev.row});
  }
  return {added, removed, changed, unchanged,unmatched,complete:unmatched.length===0};
}
