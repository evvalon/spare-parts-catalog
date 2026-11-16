import {readCatalog, compareCatalogs, escape as e, tidy} from './catalog.js';
const $ = s => document.querySelector(s);
const inputOld=$('#oldFile'), inputNew=$('#newFile'), output=$('#checkResults');
let report = null, busy=false, generation=0;
function changedFiles() {
  generation++;
  report=null;
  $('#downloadBtn').hidden=true;
  output.replaceChildren();
  $('#progress').textContent='';
  $('#oldState').textContent=inputOld.files[0]?.name || 'Файл не выбран';
  $('#newState').textContent=inputNew.files[0]?.name || 'Файл не выбран';
  $('#checkBtn').disabled=busy || !inputNew.files.length;
  $('#checkBtn').textContent=inputOld.files.length?'Проверить и сравнить':'Проверить файл';
}
inputOld.addEventListener('change',changedFiles);inputNew.addEventListener('change',changedFiles);
async function read(file) {
  if (!/\.xlsx$/i.test(file.name)) throw Error('Нужен файл .xlsx. Старые .xls сначала пересохраните в Excel.');
  if (file.size>25*1024*1024) throw Error('Файл больше 25 МБ.');
  return readCatalog(await file.arrayBuffer());
}
const rowName = r => tidy(r.b)?`${tidy(r.a)} → ${tidy(r.b)}`:`${tidy(r.a)} — аналог не указан`;
function itemHTML(item, type) {
  if (type==='changed') return `<div class="review-row"><strong>${e(rowName(item.after))}</strong><span class="small-note">Номер записи: ${e(item.id)}</span>${item.fields.map(f=>`<div class="change-field"><b>${e(f.title)}</b><div class="before">Было: ${e(f.before)||'—'}</div><div class="after">Стало: ${e(f.after)||'—'}</div></div>`).join('')}</div>`;
  return `<div class="review-row"><strong>${e(rowName(item))}</strong><span>${e(item.category)} · ${e(item.kind)}</span><div class="small-note">Номер записи: ${e(item.id)}</div></div>`;
}
function issueHTML(issue) { return `<li>Строка ${e(issue.row)}: ${e(issue.message)}</li>`; }
function listGroup(title, items, type, issue=false) {
  if (!items.length) return '';
  const render = issue?issueHTML:i=>itemHTML(i,type);
  return `<details class="review-group"><summary>${title}: ${items.length}</summary><div class="group-items">${issue?'<ul class="issue-list">':''}${items.slice(0,50).map(render).join('')}${issue?'</ul>':''}</div>${items.length>50?`<button type="button" class="secondary" data-group="${type}" data-shown="50">Показать ещё 50</button><p class="small-note">В скачиваемом отчёте доступны все записи.</p>`:''}</details>`;
}
function validMessage(next, prev, hasOld) {
  if (next.errors.length) return `<div class="check-message bad"><h2>Нужно исправить ошибки: ${next.errors.length}</h2><p>Не заменяйте файл на сайте, пока ошибки нового каталога не исправлены.</p></div>`;
  if (hasOld && (!prev || prev.errors.length)) return '<div class="check-message bad"><h2>Новый файл прочитан, сравнение не выполнено</h2><p>Исправьте ошибки прежнего файла или выберите правильную версию.</p></div>';
  return `<div class="check-message ok"><h2>${hasOld?'Проверка и сравнение завершены':'Структура файла проверена'}</h2><p>В новом каталоге ${next.records.length.toLocaleString('ru-RU')} записей. Ошибок структуры нет.${next.warnings.length?' Ниже есть замечания о повторяющихся соответствиях.':''}</p><p>${hasOld?'Посмотрите изменения ниже. Удаления особенно важно проверить перед заменой файла.':'Прежний файл не выбран: добавления, изменения и удаления не сравнивались.'}</p></div>`;
}
$('#checkBtn').addEventListener('click',async()=>{
  if (busy || !inputNew.files.length) return;
  busy=true;inputOld.disabled=inputNew.disabled=true;$('#checkBtn').disabled=true;$('#downloadBtn').hidden=true;
  const run=++generation;
  $('#progress').textContent='Читаем Excel…';output.replaceChildren();
  try {
    const newFile=inputNew.files[0], oldFile=inputOld.files[0];
    const next=await read(newFile);let prev=null,oldError='';
    if (oldFile) { try { prev=await read(oldFile); } catch(error) { oldError=error.message; } }
    if (run!==generation) return;
    const comparison=oldFile && prev && !prev.errors.length && !next.errors.length ? compareCatalogs(prev.records,next.records):null;
    report={next,prev,comparison,newName:newFile.name,oldName:oldFile?.name||'',oldError};
    output.innerHTML=validMessage(next,prev,!!oldFile)
      +(oldError?`<div class="check-message bad"><p>Прежний файл: ${e(oldError)}</p></div>`:'')
      +listGroup('Ошибки нового файла',next.errors,'newErrors',true)
      +listGroup('Ошибки прежнего файла',prev?.errors||[],'oldErrors',true)
      +listGroup('Повторяющиеся соответствия нового файла',next.warnings,'warnings',true)
      +(comparison?`<div class="metrics"><div class="metric"><b>${comparison.added.length}</b>Добавлено</div><div class="metric"><b>${comparison.changed.length}</b>Изменено</div><div class="metric"><b>${comparison.removed.length}</b>Удалено</div><div class="metric"><b>${comparison.unchanged}</b>Без изменений</div></div>${listGroup('Добавлено',comparison.added,'added')}${listGroup('Изменено',comparison.changed,'changed')}${listGroup('Удалено',comparison.removed,'removed')}`:'');
    $('#downloadBtn').hidden=false;
    $('#progress').textContent='Готово';
  } catch(error) {
    report=null;
    output.innerHTML=`<div class="check-message bad"><h2>Новый файл не удалось проверить</h2><p>${e(error.message)}</p></div>`;
    $('#progress').textContent='Проверка не завершена';
  } finally { busy=false;inputOld.disabled=inputNew.disabled=false;$('#checkBtn').disabled=!inputNew.files.length; }
});
function groupItems(type) {
  return type==='newErrors'?report.next.errors:type==='oldErrors'?report.prev?.errors||[]:type==='warnings'?report.next.warnings:report.comparison?.[type]||[];
}
output.addEventListener('click',event=>{
  const button=event.target.closest('[data-group]');
  if (!button||!report) return;
  const type=button.dataset.group, items=groupItems(type), shown=Number(button.dataset.shown), issue=['newErrors','oldErrors','warnings'].includes(type);
  const target=button.parentElement.querySelector(issue?'ul':'.group-items');
  target.insertAdjacentHTML('beforeend',items.slice(shown,shown+50).map(i=>issue?issueHTML(i):itemHTML(i,type)).join(''));
  button.dataset.shown=String(shown+50);button.hidden=shown+50>=items.length;
});
$('#downloadBtn').addEventListener('click',()=>{
  if (!report) return;
  const r=report,c=r.comparison;
  const groups=[['Ошибки нового файла',r.next.errors,'newErrors',true],['Ошибки прежнего файла',r.prev?.errors||[],'oldErrors',true],['Повторяющиеся соответствия',r.next.warnings,'warnings',true],['Добавлено',c?.added||[],'added'],['Изменено',c?.changed||[],'changed'],['Удалено',c?.removed||[],'removed']];
  const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Отчёт проверки каталога</title><style>body{font:15px/1.5 system-ui;max-width:960px;margin:35px auto;padding:0 20px;color:#172f3c}.review-row{border-top:1px solid #ddd;padding:15px 0;overflow-wrap:anywhere}.review-row strong{display:block}.change-field{margin:10px 0;padding-left:15px;border-left:2px solid #ddd}.before{color:#98443b}.after{color:#066467}.before,.after{white-space:pre-wrap}.small-note{color:#647782}h2{margin-top:32px}@media print{.review-row{break-inside:avoid}}</style><body><h1>Отчёт проверки каталога</h1><p>Новый файл: ${e(r.newName)}<br>Прежний файл: ${e(r.oldName)||'не выбран'}</p>${validMessage(r.next,r.prev,!!r.oldName)}${r.oldError?`<p>${e(r.oldError)}</p>`:''}${c?`<p>Добавлено: ${c.added.length}; изменено: ${c.changed.length}; удалено: ${c.removed.length}; без изменений: ${c.unchanged}.</p>`:''}${groups.filter(([,items])=>items.length).map(([title,items,type,issue])=>`<h2>${title}: ${items.length}</h2>${issue?'<ul>':''}${items.map(i=>issue?issueHTML(i):itemHTML(i,type)).join('')}${issue?'</ul>':''}`).join('')}<p>Проверка структуры не подтверждает техническую совместимость оборудования. Изменения не опубликованы.</p></body></html>`;
  const url=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'})),link=document.createElement('a');
  link.href=url;link.download='Отчёт проверки каталога.html';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
