import {readCatalog, CATALOG_FILE, NO_ANALOG_KIND,tidy, normalize, escape as e} from './catalog.js?v=20261117-check1';
import {settings} from './settings.js?v=20261117-check1';
import {enrichBrands,buildArticleContexts,evidenceDirection,reverseReferenceOnly,manufacturerName} from './catalog-search.js?v=20261117-check1';
const $ = s => document.querySelector(s);
const query = $('#query'), cards = $('#cards');
const state = {records:[], catalogById:new Map(),brandSources:new Map(),sourceRows:new Map(),knownRows:[],searchRows:[], articleContexts:new Map(),category:'', found:[], visible:12, showSimilar:false,loaded:false};
const initial = new URLSearchParams(location.search);
query.value = (initial.get('q') || '').slice(0, 180);
state.category = initial.get('category') || '';
const copyIcon = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="6" y="6" width="10" height="11" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M12 6V3H3v10h3" stroke="currentColor" stroke-width="1.5"/></svg>';
const copyValues = new Map();
const orders = new Map();
let timer, toastTimer;
function showToast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, 3500); }
function modelKey(brand, model) { return JSON.stringify([tidy(brand).toUpperCase(),tidy(model)]); }
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
function cleanNote(note, row) {
  // Hide a repeated, fully structured list of codes, but retain actual conditions.
  const sourceText=tidy(note).replace(/^A:\s*/,''), prefix=tidy(row?.a)+' Аналоги:';
  if(row?.source && sourceText.startsWith(prefix)){
    const codes=sourceText.slice(prefix.length).split(',').map(tidy);
    const recorded=new Set(state.records.filter(r=>r.source===row.source&&r.a===row.a).flatMap(r=>[tidy(r.a),tidy(r.b)]));
    if(codes.length&&codes.every(code=>recorded.has(code)))return '';
  }
  if (/^(?:Краткое обозначение компрессора сохранено|Соответствие из первоначального каталога|Подтверждение заказчика|В первоначальном каталоге и прайсе)/.test(tidy(note))) return '';
  const parts = note.replace(/(^|[;\n])\s*[A-Z]{1,3}:\s*/g, '$1').split(/[;\n]/).map(tidy).filter(v=>v && !/^(?:Нет аналога|Соответствие из первоначального каталога.*|Подтверждение заказчика.*)$/i.test(v));
  return [...new Set(parts)].join('; ');
}
function prepareSearchRows(records) {
  const out=[], tables=new Map();
  for (const row of records) {
    if(row.kind===NO_ANALOG_KIND)continue;
    if (!['Сопоставление по таблице','Примерный аналог по источнику'].includes(tidy(row.kind))) {out.push(row);continue;}
    // A table row was stored as pairs sharing the same first model. Reassemble
    // ONLY that original row; keep different source rows and anchors separate.
    const key=JSON.stringify([row.category,row.source||row.id,row.a_brand,row.a,row.kind]);
    if (!tables.has(key)) tables.set(key,{row,originalRows:[],members:new Map(),notes:new Set()});
    const table=tables.get(key);table.notes.add(row.note);table.originalRows.push(row);
    for (const [model,brand,specs] of [[row.a,row.a_brand,row.a_specs],[row.b,row.b_brand,row.b_specs]]) {
      const memberKey=modelKey(brand,model);
      if (!table.members.has(memberKey)) table.members.set(memberKey,{model,brand,specs:new Set(),recordIds:new Set()});
      table.members.get(memberKey).recordIds.add(row.id);
      if (tidy(specs)) table.members.get(memberKey).specs.add(specs);
    }
  }
  for (const table of tables.values()) {
    const members=[...table.members.values()];
    for(let i=0;i<members.length;i++) for(let j=i+1;j<members.length;j++) {
      const a=members[i],b=members[j];
      const endpoints=[modelKey(a.brand,a.model),modelKey(b.brand,b.model)].sort();
      const direct=table.originalRows.filter(r=>JSON.stringify([modelKey(r.a_brand,r.a),modelKey(r.b_brand,r.b)].sort())===JSON.stringify(endpoints));
      const catalogIds=direct.length?direct.map(r=>r.id):[...new Set([...a.recordIds,...b.recordIds])];
      const witnessRows=direct.length?direct:table.originalRows.filter(r=>catalogIds.includes(r.id));
      out.push({...table.row,_catalogIds:catalogIds,a:a.model,a_brand:a.brand,a_specs:[...a.specs].join('\n'),b:b.model,b_brand:b.brand,b_specs:[...b.specs].join('\n'),note:[...new Set(witnessRows.map(r=>r.note))].join('\n')});
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
    const relation=directional?row.kind:row.kind==='Примерный аналог по источнику'?'approximate':'analog';
    const matchKey = JSON.stringify([modelKey(toBrand,to),relation,directional?reverse:false]);
    if (!group.matches.has(matchKey)) group.matches.set(matchKey, {to,toBrand,kind:row.kind,reverse,rows:[]});
    group.matches.get(matchKey).rows.push({...row,_reverse:reverse,_evidenceDirection:evidenceDirection(row,reverse)});
    if(row.kind==='Артикул аналога'&&reverse){
      for(const related of state.articleContexts.get(row.id)||[]){
        const contextKey=JSON.stringify([related._sourceKey,related.b,related.b_brand,related.kind]);
        if(!group.contexts.has(contextKey))group.contexts.set(contextKey,{to:related.b,toBrand:related.b_brand,kind:related.kind,reverse:false,rows:[{...related,_reverse:false}],contextFor:related.a,contextForBrand:related.a_brand});
      }
    }
  }
  const hasAnalogResults=groups.size>0;
  for(const row of state.knownRows){
    if(state.category&&tidy(row.category)!==state.category)continue;
    const rank=score(row.a,row.a_brand,q);if(rank===9)continue;
    if(rank!==0&&hasAnalogResults)continue;
    // An empty cell in one source does not override an analog in another source.
    const alreadyKnown=[...groups.values()].some(g=>tidy(g.category)===tidy(row.category)&&normalize(g.from)===normalize(row.a)&&(!tidy(g.fromBrand)||!tidy(row.a_brand)||tidy(g.fromBrand).toUpperCase()===tidy(row.a_brand).toUpperCase()));
    if(alreadyKnown)continue;
    const key=JSON.stringify([tidy(row.category),modelKey(row.a_brand,row.a)]);
    groups.set(key,{from:row.a,fromBrand:row.a_brand,category:row.category,score:rank,matches:new Map(),contexts:new Map(),noAnalog:true,knownRecord:row});
  }
  return [...groups.values()].sort((a,b) => a.score-b.score || a.from.localeCompare(b.from,'ru'));
}
function detailsHTML(match) {
  const unique = new Map();
  for (const r of match.rows) {
    const fromSpecs = r._reverse ? r.b_specs : r.a_specs, toSpecs = r._reverse ? r.a_specs : r.b_specs;
    const note = cleanNote(r.note,r), key = JSON.stringify([fromSpecs,toSpecs,note]);
    if (!unique.has(key)) unique.set(key, {fromSpecs,toSpecs,note});
  }
  const blocks = [...unique.values()].map((s,i) => `${unique.size>1?`<div class="kicker">Сведения ${i+1}</div>`:''}${[['Исходная модель',s.fromSpecs],['Результат подбора',s.toSpecs],['Условия подбора',s.note]].filter(([,v])=>tidy(v)).map(([title,value])=>`<div class="spec-block"><strong>${title}</strong><p>${e(value)}</p></div>`).join('')}`).join('');
  if(!blocks)return '';
  return `<details class="details"><summary>Характеристики и условия</summary>${blocks}</details>`;
}
function voltage(value) {
  const values=[...String(value).matchAll(/(?:^|[^\d])(220|230|380|400)\s*[ВBV](?=$|[^A-Za-zА-Яа-я])/gi)].map(m=>m[1]+' В');
  return [...new Set(values)].map(v=>`<span class="voltage">${e(v)}</span>`).join('');
}
function matchHTML(match, token, group, number) {
  copyValues.set(token, tidy(match.to));
  const reverseOnly=reverseReferenceOnly(match);
  orders.set(token,{from:tidy(group.from),fromBrand:tidy(group.fromBrand),to:tidy(match.to),toBrand:tidy(match.toBrand),kind:match.kind,reverse:match.reverse,contextFor:match.contextFor,reverseOnly});
  const typeLabel=label(match.kind,match.reverse);
  const analog=!reverseOnly&&!match.contextFor&&!['Подходящая комплектующая','Артикул аналога'].includes(match.kind);
  const title=reverseOnly?'Обратная ссылка':match.contextFor?`Модель из этого подбора ${number}`:analog?`${match.kind.startsWith('Примерный')?'Примерный аналог':'Аналог'} ${number}`:`${typeLabel} ${number}`;
  return `<div class="match ${match.contextFor?'context-match':''}"><div class="result-main"><div class="match-label ${match.kind.startsWith('Примерный')||reverseOnly?'caution':''}">${e(title)}</div><div class="result-identity"><span class="brand-name ${tidy(match.toBrand)?'':'unknown-brand'}">${tidy(match.toBrand)?e(match.toBrand):'Производитель не указан'}</span><h4 class="match-model">${e(match.to)}</h4>${voltage(match.to)}</div>${match.contextFor?`<span class="context-relation">Для ${e(match.contextFor)}${match.kind.startsWith('Примерный')?' · примерный по источнику':''}</span>`:''}</div><div class="match-actions"><button type="button" class="primary option-order" data-order="${token}">${reverseOnly||match.contextFor?'Уточнить':analog?'Заказать':'Уточнить заказ'}</button><button type="button" class="copy" data-copy="${token}" aria-label="Скопировать ${e(tidy(match.to))}">${copyIcon}<span>Копировать</span></button></div>${detailsHTML(match)}</div>`;
}
function cardHTML(group, index) {
  if(group.noAnalog){
    const token=`${index}-known`;copyValues.set(token,tidy(group.from));
    orders.set(token,{from:tidy(group.from),fromBrand:tidy(group.fromBrand),kind:NO_ANALOG_KIND,to:'',toBrand:''});
    return `<article class="card known-model-card ${group.score===0?'exact-card':'similar-card'}"><div class="card-top"><span class="kicker">${group.score===0?'Модель найдена':'Похожее обозначение'}</span><div class="match-line"><div><h3 class="model">${e(group.from)}</h3><div class="source-meta">${tidy(group.fromBrand)?`<span>${e(group.fromBrand)}</span>`:''}<span>${e(group.category)}</span>${voltage(group.from)}</div></div><button class="copy" type="button" data-copy="${token}" aria-label="Скопировать ${e(tidy(group.from))}">${copyIcon}</button></div></div><div class="options-section no-analog-state"><h3>Аналог в каталоге не указан</h3><p>Уточните подбор у специалиста — он поможет проверить возможную замену.</p><button type="button" class="primary" data-order="${token}">Уточнить подбор</button>${detailsHTML({to:group.from,toBrand:group.fromBrand,rows:[{...group.knownRecord,_reverse:false}]})}</div></article>`;
  }
  const matches = [...group.matches.values()].sort((a,b)=>{
    const firstA=a.rows.some(r=>r.status==='По первоначальному прайсу'),firstB=b.rows.some(r=>r.status==='По первоначальному прайсу');
    return Number(firstB)-Number(firstA)||Number(!tidy(a.toBrand))-Number(!tidy(b.toBrand))||a.toBrand.localeCompare(b.toBrand,'ru')||a.to.localeCompare(b.to,'ru');
  }), fromToken = `${index}-from`;
  copyValues.set(fromToken, tidy(group.from));
  const sections=new Map();
  matches.forEach((match,i)=>{
    const title=reverseReferenceOnly(match)?'Обратные ссылки из каталога':match.kind==='Подходящая комплектующая'?(match.reverse?'Подходит к оборудованию':'Подходящие комплектующие'):match.kind==='Артикул аналога'?(match.reverse?'Подбор, в котором указан артикул':'Артикулы аналогов'):'Найденные аналоги';
    if(!sections.has(title))sections.set(title,[]);
    sections.get(title).push({match,token:`${index}-${i}`});
  });
  const isArticle=matches.every(m=>m.kind==='Артикул аналога'&&m.reverse);
  const context=[...group.contexts.values()];
  const contextHTML=context.length?`<section class="options-section article-context"><div class="options-heading"><h3>Другие модели из того же подбора</h3><span>${context.length}</span></div><p class="context-explanation">В исходной строке они перечислены вместе с артикулом ${e(group.from)}. Какой именно модели принадлежит артикул, не указано. Прямая замена по нему требует уточнения.</p><div class="options-grid">${context.map((m,i)=>matchHTML(m,`${index}-context-${i}`,group,i+1)).join('')}</div></section>`:'';
  return `<article class="card ${group.score===0?'exact-card':'similar-card'}"><div class="card-top"><div class="found-context"><span class="kicker">${group.score===0?'Вы искали':'Похожее обозначение'}</span><span class="match-status">${group.score===0?'Точное совпадение':'Совпадение по части запроса'}</span></div><div class="match-line"><div><h3 class="model">${e(group.from)}</h3><div class="source-meta">${tidy(group.fromBrand)?`<span>${e(group.fromBrand)}</span>`:isArticle?'<span>Артикул в списке аналогов</span>':'<span>Производитель не указан</span>'}<span>${e(group.category)}</span>${voltage(group.from)}</div></div><button class="copy" type="button" data-copy="${fromToken}" aria-label="Скопировать ${e(tidy(group.from))}">${copyIcon}</button></div></div>${[...sections].map(([title,items])=>`<section class="options-section"><div class="options-heading"><h3>${title}</h3><span>${items.length}</span></div>${title==='Обратные ссылки из каталога'?'<p class="context-explanation">В источнике ваша модель указана как аналог перечисленных моделей. Возможность обратной замены нужно уточнить.</p>':''}${title==='Подбор, в котором указан артикул'?'<p class="context-explanation">Это исходная модель подбора, в списке аналогов которой указан ваш артикул.</p>':''}<div class="options-grid">${items.map(({match,token},i)=>matchHTML(match,token,group,i+1)).join('')}</div></section>`).join('')}${contextHTML}</article>`;
}
function render() {
  copyValues.clear();
  orders.clear();
  const exact=state.found.filter(g=>g.score===0),similar=state.found.length-exact.length;
  const shown=exact.length&&!state.showSimilar?exact:state.found;
  cards.innerHTML = shown.slice(0,state.visible).map(cardHTML).join('');
  $('#moreBtn').hidden = state.visible >= shown.length;
  $('#similarBtn').hidden = !exact.length||!similar;
  $('#similarBtn').textContent=state.showSimilar?'Скрыть похожие обозначения':`Показать похожие обозначения (${similar})`;
  $('#count').textContent = `Моделей / артикулов: ${shown.length}${state.visible<shown.length?' · показано: '+state.visible:''}`;
}
function search() {
  clearTimeout(timer);
  const q = normalize(query.value);
  document.body.classList.toggle('has-query',!!q);
  $('#clearBtn').hidden = !query.value;
  if (!state.loaded) return;
  state.visible = 12;
  state.showSimilar=false;
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
async function fetchCatalog() {
  for(let attempt=0;attempt<2;attempt++) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try {
      const response=await fetch(new URL(CATALOG_FILE,location.href),{cache:'no-store',signal:controller.signal});
      // Read the body within the same timeout, not just the HTTP headers.
      if(!response.ok){if(response.status>=500&&attempt===0)continue;return response;}
      const buffer=await response.arrayBuffer();
      return {ok:true,arrayBuffer:async()=>buffer};
    }catch(error){if(attempt===1)throw Error('Не удалось скачать файл каталога. Проверьте интернет-соединение и нажмите «Повторить».');}
    finally{clearTimeout(timer);}
  }
}
async function load() {
  state.loaded = false;
  $('#findBtn').disabled = true;
  $('#loadState').hidden = false;
  $('#loadState').className = 'load-state';
  $('#loadState').innerHTML = '<span class="spinner" aria-hidden="true"></span>Загружаем каталог…';
  $('#welcome').hidden = $('#results').hidden = $('#empty').hidden = true;
  try {
    const response = await fetchCatalog();
    if (!response.ok) throw Error('Файл каталога недоступен (HTTP '+response.status+'). Попробуйте ещё раз чуть позже.');
    const result = await readCatalog(await response.arrayBuffer());
    if (result.errors.length) throw Error('В таблице каталога есть ошибки.');
    state.records = result.records;
    state.sourceRows=new Map(state.records.map((r,i)=>[r.id,result.rowNumbers[i]]));
    state.catalogById=new Map(state.records.map(r=>[r.id,r]));state.brandSources=new Map();
    for(const r of state.records)for(const side of ['a','b'])if(tidy(r[side])&&tidy(r[side+'_brand'])){
      const key=JSON.stringify([tidy(r.category).toUpperCase(),tidy(r[side]).toUpperCase(),manufacturerName(r[side+'_brand']).toUpperCase()]);
      if(!state.brandSources.has(key))state.brandSources.set(key,{source:r.source,row:state.sourceRows.get(r.id)});
    }
    const enriched=enrichBrands(state.records);
    state.knownRows=enriched.filter(r=>r.kind===NO_ANALOG_KIND);
    state.articleContexts=buildArticleContexts(enriched);
    state.searchRows = prepareSearchRows(enriched);
    const categories = [...new Set(state.records.map(r=>tidy(r.category)))].sort((a,b)=>a.localeCompare(b,'ru'));
    if (!categories.includes(state.category)) state.category = '';
    $('#filters').innerHTML = [['','Всё оборудование'],...categories.map(c=>[c,c])].map(([value,title])=>`<button type="button" class="chip ${value===state.category?'active':''}" data-category="${e(value)}" aria-pressed="${value===state.category}">${e(title)}</button>`).join('');
    $('#catalogCount').textContent = `${state.records.length.toLocaleString('ru-RU')} записей в каталоге`;
    state.loaded = true;
    $('#findBtn').disabled = false;
    $('#loadState').hidden = true;
    search();
  } catch (error) {
    console.error('Catalog load failed:',error);
    $('#loadState').className = 'load-state load-error';
    $('#loadState').innerHTML = '<strong>Не удалось загрузить каталог</strong><p>'+e(error.message || 'Проверьте соединение и попробуйте ещё раз.')+'</p><button type="button" class="secondary" id="retryBtn">Повторить</button>';
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
$('#similarBtn').addEventListener('click',()=>{state.showSimilar=!state.showSimilar;state.visible=12;render();});
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
    if(item.kind===NO_ANALOG_KIND){message=`Здравствуйте! Помогите, пожалуйста, подобрать аналог для ${original}.\nМодель найдена в каталоге, но замена для неё не указана.`;$('#orderTitle').textContent='Уточнить подбор';}
    if(item.reverseOnly){message=`Здравствуйте! Ищу замену для ${original}.\nВ источнике моя модель указана как аналог ${result}.\nМожно ли использовать ${result} в обратном направлении? Уточните совместимость и условия заказа.`;$('#orderTitle').textContent='Уточнить обратную замену';}
  }
  $('#orderMessage').value=message;
  $('#orderCopyStatus').textContent='Сообщение можно дополнить перед копированием.';
  $('#copyOrder').textContent='1. Скопировать сообщение';
  $('#orderDialog').showModal();
}
$('#headerOrder').addEventListener('click',()=>openOrder());
$('#closeOrder').addEventListener('click',()=>$('#orderDialog').close());
$('#copyOrder').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText($('#orderMessage').value);$('#copyOrder').textContent='✓ Сообщение скопировано';$('#orderCopyStatus').textContent='Откройте удобный мессенджер и вставьте сообщение в переписку.';}
  catch{$('#orderMessage').focus();$('#orderMessage').select();$('#orderCopyStatus').textContent='Скопируйте выделенный текст вручную, затем выберите мессенджер.';}
});
$('#orderDialog').addEventListener('click',event=>{if(event.target===$('#orderDialog')){const r=$('#orderDialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('#orderDialog').close();}});
const messengers=[{id:'max',label:'MAX',url:settings.maxUrl},{id:'telegram',label:'Telegram',url:settings.telegramUrl},{id:'whatsapp',label:'WhatsApp',url:settings.whatsappUrl}].filter(m=>/^https:\/\//.test(m.url||''));
function messengerLink(m,label=m.label){const a=document.createElement('a');a.href=m.url;a.textContent=label;a.target='_blank';a.rel='noopener noreferrer';a.dataset.channel=m.id;return a;}
for(const messenger of messengers){const link=messengerLink(messenger);link.className='messenger-link';link.id=messenger.id==='max'?'openMax':'open'+messenger.id;$('#messengerOptions')?.append(link);}
document.querySelectorAll('.contact-slot').forEach(slot=>{
  slot.classList.add('contacts');
  messengers.forEach(m=>slot.append(messengerLink(m,'Написать в '+m.label)));
  settings.phones.forEach(phone=>{ const a=document.createElement('a');a.href='tel:'+phone.number;a.textContent=phone.label;slot.append(a); });
});
if(messengers.length) document.querySelectorAll('.max-slot').forEach(slot=>{
  slot.append('Нужна помощь с подбором? ');
  const links=document.createElement('span');links.className='quick-messengers';messengers.forEach(m=>links.append(messengerLink(m)));slot.append(links);
});
load();

