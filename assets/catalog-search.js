import {tidy} from './catalog.js';

// Metadata matching is intentionally stricter than fuzzy search: no guessed
// prefixes, suffixes, cross-script letters or manufacturer aliases.
const metadataKey = (category, model) => JSON.stringify([tidy(category).toUpperCase(),tidy(model).toUpperCase()]);
export function enrichBrands(records) {
  const brands=new Map();
  for(const row of records) for(const side of ['a','b']) {
    const model=tidy(row[side]),brand=tidy(row[side+'_brand']);
    if(!model||!brand)continue;
    const key=metadataKey(row.category,model);
    if(!brands.has(key))brands.set(key,new Map());
    const name=brand.toUpperCase();
    if(!brands.get(key).has(name))brands.get(key).set(name,{brand,source:row.source});
  }
  return records.map(row=>{
    const next={...row};
    // Original source and anchor are retained before metadata is enriched.
    next._sourceKey=tidy(row.source)?JSON.stringify([row.category,row.source,tidy(row.a),tidy(row.a_brand)]):null;
    for(const side of ['a','b']){
      if(tidy(row[side+'_brand']))continue;
      const known=brands.get(metadataKey(row.category,row[side]));
      if(known?.size===1){
        const match=[...known.values()][0];
        next[side+'_brand']=match.brand;
        next['_'+side+'_brand_source']=match.source;
      }
    }
    return next;
  });
}

export function buildArticleContexts(records) {
  const bySource=new Map(),result=new Map();
  const allowed=new Set(['Аналог по источнику','Текстовое сопоставление по источнику','Сопоставление по таблице','Примерный аналог по источнику']);
  for(const row of records){
    if(!row._sourceKey||!allowed.has(row.kind))continue;
    if(!bySource.has(row._sourceKey))bySource.set(row._sourceKey,[]);
    bySource.get(row._sourceKey).push(row);
  }
  for(const row of records){
    if(row.kind==='Артикул аналога')result.set(row.id,bySource.get(row._sourceKey)||[]);
  }
  return result;
}
