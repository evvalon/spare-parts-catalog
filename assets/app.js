import {readCatalog, CATALOG_FILE, tidy, normalize, escape as e} from './catalog.js';
import {settings} from './settings.js';
import {enrichBrands,buildArticleContexts} from './catalog-search.js';
const $ = s => document.querySelector(s);
const query = $('#query'), cards = $('#cards');
const state = {records:[], searchRows:[], articleContexts:new Map(),category:'', found:[], visible:12, loaded:false};
const initial = new URLSearchParams(location.search);
query.value = (initial.get('q') || '').slice(0, 180);
state.category = initial.get('category') || '';
const copyIcon = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="6" y="6" width="10" height="11" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M12 6V3H3v10h3" stroke="currentColor" stroke-width="1.5"/></svg>';
const copyValues = new Map();
const orders = new Map();
let timer, toastTimer;
function showToast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, 3500); }
function modelKey(brand, model) { return JSON.stringify([tidy(brand),tidy(model)]); }
function score(model, brand, q) {
  const v = normalize(model);
  if (v === q) return 0;
  if (v.startsWith(q)) return 1;
  if (v.includes(q)) return 2;
  if (normalize(brand).includes(q)) return 3;
  return 9;
}
function label(kind, reverse) {
  if (kind === 'Подходящая комплектующая') return reverse ? 'Подходит к оборудованию' : 'Подходящая комплектующая';
  if (kind === 'Артикул аналога') return reverse ? 'Исходная модель подбора' : 'Артикул аналога';
  return kind === 'Примерный аналог по источнику' ? 'Примерный аналог' : 'Аналог по каталогу';
}
function cleanNote(note) {
  if (/^Краткое обозначение компрессора сохранено/.test(note)) return 'Подбор по краткому обозначению компрессора.';
  const parts = note.replace(/(^|[;\n])\s*[A-Z]{1,3}:\s*/g, '$1').split(/[;\n]/).map(tidy).filter(Boolean);
  return [...new Set(parts)].join('; ');
}
function prepareSearchRows(records) {
  const out=[], tables=new Map();
  for (const row of records) {
    if (!['Сопоставление по таблице','Примерный аналог по источнику'].includes(tidy(row.kind))) {out.push(row);continue;}
    // A table row was stored as pairs sharing the same first model. Reassemble
    // ONLY that original row; keep different source rows and anchors separate.
    const key=JSON.stringify([row.category,row.source||row.id,row.a_brand,row.a,row.kind]);
    if (!tables.has(key)) tables.set(key,{row,members:new Map(),notes:new Set()});
    const table=tables.get(key);table.notes.add(row.note);
    for (const [model,brand,specs] of [[row.a,row.a_brand,row.a_specs],[row.b,row.b_brand,row.b_specs]]) {
      const memberKey=modelKey(brand,model);
      if (!table.members.has(memberKey)) table.members.set(memberKey,{model,brand,specs:new Set()});
      if (tidy(specs)) table.members.get(memberKey).specs.add(specs);
    }
  }
  for (const table of tables.values()) {
    const members=[...table.members.values()];
    for(let i=0;i<members.length;i++) for(let j=i+1;j<members.length;j++) {
      const a=members[i],b=members[j];
      out.push({...table.row,a:a.model,a_brand:a.brand,a_specs:[...a.specs].join('\n'),b:b.model,b_brand:b.brand,b_specs:[...b.specs].join('\n'),note:[...table.notes].join('\n')});
    }
  }
  return out;
}
function collect(q) {
  const groups = new Map();
  for (const row of state.searchRows) {
    if (state.category && tidy(row.category) !== state.category) continue;
    const aScore = score(row.a, row.a_brand, q), bScore = score(row.b, row.b_brand, q);
    if (Math.min(aScore, bScore) === 9) continue;
    // Never infer extra links across separate source rows.
    const reverse = bScore < aScore;
    const from = reverse ? row.b : row.a, fromBrand = reverse ? row.b_brand : row.a_brand;
    const to = reverse ? row.a : row.b, toBrand = reverse ? row.a_brand : row.b_brand;
    const key = JSON.stringify([tidy(row.category),modelKey(fromBrand, from)]);
    if (!groups.has(key)) groups.set(key, {from, fromBrand, category:row.category, score:Math.min(aScore,bScore), matches:new Map(),contexts:new Map()});
    const group = groups.get(key);
    const directional=['Подходящая комплектующая','Артикул аналога'].includes(tidy(row.kind));
    const matchKey = JSON.stringify([modelKey(toBrand,to),tidy(row.kind),directional?reverse:false]);
    if (!group.matches.has(matchKey)) group.matches.set(matchKey, {to,toBrand,kind:row.kind,reverse,rows:[]});
    group.matches.get(matchKey).rows.push({...row,_reverse:reverse});
    if(row.kind==='Артикул аналога'&&reverse){
      for(const related of state.articleContexts.get(row.id)||[]){
        const contextKey=JSON.stringify([related._sourceKey,related.b,related.b_brand,related.kind]);
        if(!group.contexts.has(contextKey))group.contexts.set(contextKey,{to:related.b,toBrand:related.b_brand,kind:related.kind,reverse:false,rows:[{...related,_reverse:false}],contextFor:related.a,contextForBrand:related.a_brand});
      }
    }
  }
  return [...groups.values()].sort((a,b) => a.score-b.score || a.from.localeCompare(b.from,'ru'));
}
function detailsHTML(match) {
  const unique = new Map();
  for (const r of match.rows) {
    const fromSpecs = r._reverse ? r.b_specs : r.a_specs, toSpecs = r._reverse ? r.a_specs : r.b_specs;
    const note = cleanNote(r.note), key = JSON.stringify([fromSpecs,toSpecs,note]);
    if (!unique.has(key)) unique.set(key, {fromSpecs,toSpecs,note});
  }
  const blocks = [...unique.values()].map((s,i) => `${unique.size>1?`<div class="kicker">Сведения ${i+1}</div>`:''}${[['Исходная модель',s.fromSpecs],['Результат подбора',s.toSpecs],['Условия и сведения каталога',s.note]].filter(([,v])=>tidy(v)).map(([title,value])=>`<div class="spec-block"><strong>${title}</strong><p>${e(value)}</p></div>`).join('')}`).join('');
  return blocks ? `<details class="details"><summary>Характеристики и условия</summary>${blocks}</details>` : '';
}
function voltage(value) {
  const values=[...String(value).matchAll(/(?:^|[^\d])(220|230|380|400)\s*[ВBV](?=$|[^A-Za-zА-Яа-я])/gi)].map(m=>m[1]+' В');
  return [...new Set(values)].map(v=>`<span class="voltage">${e(v)}</span>`).join('');
}
function matchHTML(match, token, group, number) {
  copyValues.set(token, tidy(match.to));
  orders.set(token,{from:tidy(group.from),fromBrand:tidy(group.fromBrand),to:tidy(match.to),toBrand:tidy(match.toBrand),kind:match.kind,reverse:match.reverse,contextFor:match.contextFor});
  const known=match.rows.find(r=>tidy(r._reverse?r.a_specs:r.b_specs));
  const specs=known?(known._reverse?known.a_specs:known.b_specs):'';
  const shortSpecs=tidy(specs).length>155?tidy(specs).slice(0,152)+'…':tidy(specs);
  const typeLabel=label(match.kind,match.reverse);
  const analog=!match.contextFor&&!['Подходящая комплектующая','Артикул аналога'].includes(match.kind);
  const title=match.contextFor?`Модель из этого подбора ${number}`:analog?`${match.kind.startsWith('Примерный')?'Примерный аналог':'Аналог'} ${number}`:`${typeLabel} ${number}`;
  return `<div class="match ${match.contextFor?'context-match':''}"><div class="match-label ${match.kind.startsWith('Примерный')?'caution':''}">${e(title)}</div><div class="option-title"><h4 class="match-model">${e(match.to)}</h4>${voltage(match.to)}</div><div class="brand-name ${tidy(match.toBrand)?'':'unknown-brand'}">${tidy(match.toBrand)?e(match.toBrand):'Производитель не указан'}</div>${match.contextFor?`<p class="context-relation">Аналог для ${e(match.contextFor)}${match.kind.startsWith('Примерный')?' · примерный по источнику':''}</p>`:''}${shortSpecs?`<p class="quick-specs">${e(shortSpecs)}</p>`:''}<div class="match-actions"><button type="button" class="primary option-order" data-order="${token}">${match.contextFor?'Уточнить совместимость':analog?'Заказать этот аналог':'Уточнить заказ'}</button><button type="button" class="copy" data-copy="${token}" aria-label="Скопировать ${e(tidy(match.to))}">${copyIcon}<span>Копировать</span></button></div>${detailsHTML(match)}</div>`;
}
function cardHTML(group, index) {
  const matches = [...group.matches.values()], fromToken = `${index}-from`;
  copyValues.set(fromToken, tidy(group.from));
  const sections=new Map();
  matches.forEach((match,i)=>{
    const title=match.kind==='Подходящая комплектующая'?(match.reverse?'Подходит к оборудованию':'Подходящие комплектующие'):match.kind==='Артикул аналога'?(match.reverse?'Подбор, в котором указан артикул':'Артикулы аналогов'):'Найденные аналоги';
    if(!sections.has(title))sections.set(title,[]);
    sections.get(title).push({match,token:`${index}-${i}`});
  });
  const isArticle=matches.every(m=>m.kind==='Артикул аналога'&&m.reverse);
  const context=[...group.contexts.values()];
  const contextHTML=context.length?`<section class="options-section article-context"><div class="options-heading"><h3>Другие модели из того же подбора</h3><span>${context.length}</span></div><p class="context-explanation">В исходной строке они перечислены вместе с артикулом ${e(group.from)}. Какой именно модели принадлежит артикул, не указано. Прямая замена по нему требует уточнения.</p><div class="options-grid">${context.map((m,i)=>matchHTML(m,`${index}-context-${i}`,group,i+1)).join('')}</div></section>`:'';
  return `<article class="card ${group.score===0?'exact-card':'similar-card'}"><div class="card-top"><div class="found-context"><span class="kicker">${group.score===0?'Вы искали':'Похожее обозначение'}</span><span class="match-status">${group.score===0?'Точное совпадение':'Совпадение по части запроса'}</span></div><div class="match-line"><div><h3 class="model">${e(group.from)}</h3><div class="source-meta">${tidy(group.fromBrand)?`<span>${e(group.fromBrand)}</span>`:isArticle?'<span>Артикул в списке аналогов</span>':'<span>Производитель не указан</span>'}<span>${e(group.category)}</span>${voltage(group.from)}</div></div><button class="copy" type="button" data-copy="${fromToken}" aria-label="Скопировать ${e(tidy(group.from))}">${copyIcon}</button></div></div>${[...sections].map(([title,items])=>`<section class="options-section"><div class="options-heading"><h3>${title}</h3><span>${items.length}</span></div>${title==='Подбор, в котором указан артикул'?'<p class="context-explanation">Это исходная модель подбора, в списке аналогов которой указан ваш артикул.</p>':''}<div class="options-grid">${items.map(({match,token},i)=>matchHTML(match,token,group,i+1)).join('')}</div></section>`).join('')}${contextHTML}</article>`;
}
function render() {
  copyValues.clear();
  orders.clear();
  cards.innerHTML = state.found.slice(0,state.visible).map(cardHTML).join('');
  $('#moreBtn').hidden = state.visible >= state.found.length;
  $('#count').textContent = `Моделей / артикулов: ${state.found.length}${state.visible<state.found.length?' · показано: '+state.visible:''}`;
}
function search() {
  clearTimeout(timer);
  const q = normalize(query.value);
  document.body.classList.toggle('has-query',!!q);
  $('#clearBtn').hidden = !query.value;
  if (!state.loaded) return;
  state.visible = 12;
  $('#welcome').hidden = !!q;
  $('#results').hidden = $('#empty').hidden = true;
  if (q) {
    state.found = collect(q);
    if (state.found.length) { $('#results').hidden = false; render(); }
    else { cards.replaceChildren(); $('#empty').hidden = false; }
  } else cards.replaceChildren();
  const params = new URLSearchParams();
  if (query.value.trim()) params.set('q',query.value.trim());
  if (state.category) params.set('category',state.category);
  history.replaceState(null,'',location.pathname+(params.size?'?'+params:''));
}
async function load() {
  state.loaded = false;
  $('#findBtn').disabled = true;
  $('#loadState').hidden = false;
  $('#loadState').className = 'load-state';
  $('#loadState').innerHTML = '<span class="spinner" aria-hidden="true"></span>Загружаем каталог…';
  $('#welcome').hidden = $('#results').hidden = $('#empty').hidden = true;
  try {
    const response = await fetch(new URL(CATALOG_FILE,location.href), {cache:'no-store'});
    if (!response.ok) throw Error('Файл каталога недоступен.');
    const result = await readCatalog(await response.arrayBuffer());
    if (result.errors.length) throw Error('В таблице каталога есть ошибки.');
    state.records = result.records;
    const enriched=enrichBrands(state.records);
    state.articleContexts=buildArticleContexts(enriched);
    state.searchRows = prepareSearchRows(enriched);
    const categories = [...new Set(state.records.map(r=>tidy(r.category)))].sort((a,b)=>a.localeCompare(b,'ru'));
    if (!categories.includes(state.category)) state.category = '';
    $('#filters').innerHTML = [['','Всё оборудование'],...categories.map(c=>[c,c])].map(([value,title])=>`<button type="button" class="chip ${value===state.category?'active':''}" data-category="${e(value)}" aria-pressed="${value===state.category}">${e(title)}</button>`).join('');
    $('#catalogCount').textContent = `${state.records.length.toLocaleString('ru-RU')} записей соответствий в каталоге`;
    state.loaded = true;
    $('#findBtn').disabled = false;
    $('#loadState').hidden = true;
    search();
  } catch (error) {
    console.error('Catalog load failed:',error);
    $('#loadState').className = 'load-state load-error';
    $('#loadState').innerHTML = '<strong>Не удалось загрузить каталог</strong><p>Попробуйте ещё раз чуть позже.</p><button type="button" class="secondary" id="retryBtn">Повторить</button>';
    $('#retryBtn').addEventListener('click',load);
  }
}
$('#searchForm').addEventListener('submit',event=>{event.preventDefault();search();});
query.addEventListener('input',()=>{clearTimeout(timer);$('#clearBtn').hidden=!query.value;timer=setTimeout(search,140);});
$('#clearBtn').addEventListener('click',()=>{query.value='';search();query.focus();});
$('#filters').addEventListener('click',event=>{
  const button = event.target.closest('[data-category]');
  if (!button) return;
  state.category = button.dataset.category;
  $('#filters').querySelectorAll('button').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});
  search();
});
document.querySelectorAll('[data-example]').forEach(b=>b.addEventListener('click',()=>{query.value=b.dataset.example;search();query.focus();}));
$('#moreBtn').addEventListener('click',()=>{state.visible+=12;render();});
cards.addEventListener('click',async event=>{
  const order=event.target.closest('[data-order]');
  if(order){openOrder(orders.get(order.dataset.order));return;}
  const expand = event.target.closest('[data-expand]');
  if (expand) { expand.closest('.card').querySelectorAll('[data-extra-match]').forEach(n=>n.hidden=false);expand.hidden=true;return; }
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const value = copyValues.get(button.dataset.copy);
  if (!value) return;
  try { await navigator.clipboard.writeText(value);showToast('Скопировано: '+value); }
  catch { showToast('Не удалось скопировать. Выделите модель и скопируйте вручную.'); }
});
function openOrder(item) {
  let message='Здравствуйте! Хочу заказать запчасть. Помогите, пожалуйста, с подбором.';
  $('#orderTitle').textContent='Заказать запчасть';
  if(item){
    const original=[item.fromBrand,item.from].filter(Boolean).join(' · '), result=[item.toBrand,item.to].filter(Boolean).join(' · ');
    const relation=label(item.kind,item.reverse);
    message=`Здравствуйте! Ищу запчасть: ${original}.\n${relation}: ${result}.\nПодскажите, пожалуйста, наличие, стоимость и условия заказа.`;
    if(item.contextFor)message=`Здравствуйте! Ищу по артикулу: ${original}.\nВ том же подборе для ${item.contextFor} указана модель: ${result}.\nПодтвердите, пожалуйста, совместимость с моим оборудованием, наличие и стоимость.`;
    $('#orderTitle').textContent=item.kind==='Подходящая комплектующая'?'Уточнить комплектующую':item.kind==='Артикул аналога'?'Заказать по артикулу':'Заказать аналог';
    if(item.contextFor)$('#orderTitle').textContent='Уточнить совместимость';
  }
  $('#orderMessage').value=message;
  $('#orderCopyStatus').textContent='Сообщение можно дополнить перед копированием.';
  $('#copyOrder').textContent='1. Скопировать сообщение';
  $('#orderDialog').showModal();
}
$('#headerOrder').addEventListener('click',()=>openOrder());
$('#closeOrder').addEventListener('click',()=>$('#orderDialog').close());
$('#copyOrder').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText($('#orderMessage').value);$('#copyOrder').textContent='✓ Сообщение скопировано';$('#orderCopyStatus').textContent='Откройте MAX и вставьте сообщение в переписку.';}
  catch{$('#orderMessage').focus();$('#orderMessage').select();$('#orderCopyStatus').textContent='Скопируйте выделенный текст вручную, затем откройте MAX.';}
});
$('#orderDialog').addEventListener('click',event=>{if(event.target===$('#orderDialog')){const r=$('#orderDialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('#orderDialog').close();}});
$('#openMax').href=settings.maxUrl;
document.querySelectorAll('.contact-slot').forEach(slot=>{
  slot.classList.add('contacts');
  if (/^https:\/\//.test(settings.maxUrl)) { const a=document.createElement('a');a.href=settings.maxUrl;a.textContent='Написать в MAX';slot.append(a); }
  settings.phones.forEach(phone=>{ const a=document.createElement('a');a.href='tel:'+phone.number;a.textContent=phone.label;slot.append(a); });
});
if (/^https:\/\//.test(settings.maxUrl)) document.querySelectorAll('.max-slot').forEach(slot=>{
  slot.append('Нужна помощь с подбором? ');
  const a=document.createElement('a');a.href=settings.maxUrl;a.textContent='Написать в MAX';slot.append(a);
});
load();

