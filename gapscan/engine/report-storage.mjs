import {profileStyles} from './insights.mjs';
// Store shared evidence once. Hydration restores the same fields used by comparisons and previews.
// Preview-only styles and raw observations stay in the browser's captured
// snapshot. All comparison inputs (including original CSS, markup, variants,
// tokens, resolved styles and source evidence) still reach the backend.
export function comparisonFingerprint(fingerprint){
 hydrateFingerprint(fingerprint);
 for(const item of fingerprint.inventory.items){item.comparisonRawStyles=profileStyles(item);delete item.previewCss;delete item.contextCss;delete item.observations;item.evidence=(item.evidence||[]).map(({snippet,...evidence})=>evidence)}
 fingerprint.collection.items=fingerprint.collection.items.map(item=>({...catalogEntry(item),evidence:(item.evidence||[]).map(({snippet,...evidence})=>evidence)}));
 delete fingerprint.inventory.baseCss;
 return compactFingerprint(fingerprint);
}
// The browser already owns the full captured inventories. Return decisions
// and stable IDs instead of serializing those inventories a second time.
export function compactComparisonReport(report){
 report.externalExtractions=true;
 for(const side of ['old','new'])report.extractions[side]=report.extractions[side].map(({id,name,kind,category,canonicalLabel})=>({id,name,kind,category,canonicalLabel}));
 report.taxonomy.items=report.taxonomy.items.map(({id,name,kind,category,tier,rank,system,collectionId,source,matchedBy})=>({id,name,kind,category,tier,rank,system,collectionId,source,matchedBy}));
 return compactReport(report);
}
export async function restoreComparisonReferences(report,snapshots,yieldWork=()=>Promise.resolve()){
 if(!report.externalExtractions)return report;
 for(const side of ['old','new']){
  const snapshot=snapshots[side],originals=new Map(snapshot.inventory.items.map(item=>[item.id,item]));
  for(let index=0;index<report.extractions[side].length;index++){const item=report.extractions[side][index],original=originals.get(item.id);if(!original)throw new Error('The captured '+side+' inventory changed. Extract both systems again before comparing.');const category=item.category,canonicalLabel=item.canonicalLabel;Object.assign(item,original,{category,canonicalLabel});delete item.comparisonRawStyles;if(index%100===0)await yieldWork()}
  for(const group of report.mappingResolution?.groups?.[side]||[])for(const evidence of group.evidence||[]){const original=originals.get(evidence.itemId)?.evidence?.find(entry=>entry.source===evidence.source&&entry.line===evidence.line);if(original)Object.assign(evidence,original)}
  const catalog=new Map(snapshot.collection.items.map(item=>[item.id,item]));for(const item of report.taxonomy.items.filter(item=>item.system===(side==='old'?'source':'target'))){const original=catalog.get(item.id);if(original)for(const key of Object.keys(original))if(!(key in item))item[key]=original[key]}
 }
 delete report.externalExtractions;return report;
}
function catalogEntry(item){return Object.fromEntries(Object.entries({...item,html:item.html?.match(/^<[^>]+>/)?.[0]||'',taxonomyHint:item.taxonomyHint||item.category}).filter(([key])=>!['observations','css','previewCss','contextCss','tokens','value','values','variants','styleProfile','examples','tokenDefinitions','resolvedValue'].includes(key)))}
function compactItems(items,pool,intern){const tokens=Object.fromEntries(items.filter(item=>item.kind==='token').map(item=>[item.name,{name:item.name,value:item.value,resolvedValue:item.resolvedValue,values:item.values||[]} ]));for(const item of items){if(item.tokens){item.tokenRefs=item.tokens.map(token=>token.name);delete item.tokens}for(const key of ['html','css','previewCss','contextCss','value','resolvedValue'])if(typeof item[key]==='string'&&item[key].length>80){item[key+'Ref']=intern(item[key]);delete item[key]}for(const variant of item.variants||[])for(const key of ['html','css'])if(variant[key]){variant[key+'Ref']=intern(variant[key]);delete variant[key]}}return tokens}
function hydrateItems(items,pool,tokens){for(const item of items){for(const key of ['html','css','previewCss','contextCss','value','resolvedValue'])if(Number.isInteger(item[key+'Ref'])){item[key]=pool[item[key+'Ref']]||'';delete item[key+'Ref']}for(const variant of item.variants||[])for(const key of ['html','css'])if(Number.isInteger(variant[key+'Ref'])){variant[key]=pool[variant[key+'Ref']]||'';delete variant[key+'Ref']}if(item.tokenRefs){item.tokens=item.tokenRefs.map(name=>tokens[name]).filter(Boolean);delete item.tokenRefs}}return items}
function packTexts(value,intern){if(!value||typeof value!=='object')return;for(const [key,child]of Object.entries(value)){if(key==='textPool')continue;if(typeof child==='string'&&child.length>80&&!/^https:\/\//.test(child))value[key]={gapscanText:intern(child)};else packTexts(child,intern)}}
function unpackTexts(value,pool){if(!value||typeof value!=='object')return;for(const [key,child]of Object.entries(value)){if(key==='textPool')continue;if(child&&typeof child==='object'&&Object.keys(child).length===1&&Number.isInteger(child.gapscanText))value[key]=pool[child.gapscanText]||'';else unpackTexts(child,pool)}}
export function compactFingerprint(fingerprint){if(fingerprint.storageFormat===1)return fingerprint;const pool=[],seen=new Map(),intern=value=>{if(!seen.has(value)){seen.set(value,pool.length);pool.push(value)}return seen.get(value)};fingerprint.tokenCatalog=compactItems(fingerprint.inventory.items,pool,intern);fingerprint.collection.items=fingerprint.collection.items.map(catalogEntry);packTexts(fingerprint,intern);fingerprint.textPool=pool;fingerprint.storageFormat=1;return fingerprint}
export function hydrateFingerprint(fingerprint){if(fingerprint.storageFormat===1){unpackTexts(fingerprint,fingerprint.textPool);hydrateItems(fingerprint.inventory.items,fingerprint.textPool,fingerprint.tokenCatalog||{});delete fingerprint.storageFormat;delete fingerprint.textPool;delete fingerprint.tokenCatalog}return fingerprint}
export function compactReport(report){if(report.storageFormat===1)return report;if(report.mappingResolution)for(const groups of Object.values(report.mappingResolution.groups))for(const group of groups)delete group.records;const pool=[],seen=new Map(),intern=value=>{if(!seen.has(value)){seen.set(value,pool.length);pool.push(value)}return seen.get(value)};report.tokenCatalog={old:compactItems(report.extractions.old,pool,intern),new:compactItems(report.extractions.new,pool,intern)};for(const row of report.items){row.oldRef=row.old?.id||null;row.newRef=row.new?.id||null;delete row.old;delete row.new}report.taxonomy.items=report.taxonomy.items.map(catalogEntry);packTexts(report,intern);report.textPool=pool;report.storageFormat=1;return report}
export function hydrateReport(report){if(report.storageFormat!==1)return report;unpackTexts(report,report.textPool);for(const side of ['old','new'])hydrateItems(report.extractions[side],report.textPool,report.tokenCatalog?.[side]||{});const old=new Map(report.extractions.old.map(item=>[item.id,item])),target=new Map(report.extractions.new.map(item=>[item.id,item]));for(const row of report.items){row.old=old.get(row.oldRef)||null;row.new=target.get(row.newRef)||null}if(report.mappingResolution)for(const [side,groups]of Object.entries(report.mappingResolution.groups)){const dictionary=side==='old'?old:target;for(const group of groups)group.records=group.itemIds.map(id=>dictionary.get(id)).filter(Boolean)}delete report.storageFormat;delete report.textPool;delete report.tokenCatalog;return report}
// Walk in bounded slices so the loader, cancellation and navigation can paint
// while a large backend report is restored. Preserve the synchronous API for
// server code and existing saved-project callers.
export async function hydrateReportAsync(report,yieldWork=()=>new Promise(resolve=>setTimeout(resolve,0))){
 if(report.storageFormat!==1)return report;
 const pool=report.textPool,stack=[report];let budget=0;
 while(stack.length){const value=stack.pop();if(!value||typeof value!=='object')continue;for(const key of Object.keys(value)){if(key==='textPool')continue;const child=value[key];if(child&&typeof child==='object'){if(Number.isInteger(child.gapscanText)&&Object.keys(child).length===1)value[key]=pool[child.gapscanText]||'';else stack.push(child)}if(++budget>=2000){budget=0;await yieldWork()}}}
 const dictionaries={};
 for(const side of ['old','new']){const items=report.extractions[side];dictionaries[side]=new Map();for(let index=0;index<items.length;index+=100){const batch=items.slice(index,index+100);hydrateItems(batch,pool,report.tokenCatalog?.[side]||{});for(const item of batch)dictionaries[side].set(item.id,item);await yieldWork()}}
 for(let index=0;index<report.items.length;index+=100){for(const row of report.items.slice(index,index+100)){row.old=dictionaries.old.get(row.oldRef)||null;row.new=dictionaries.new.get(row.newRef)||null}await yieldWork()}
 if(report.mappingResolution)for(const [side,groups]of Object.entries(report.mappingResolution.groups))for(let index=0;index<groups.length;index+=100){for(const group of groups.slice(index,index+100))group.records=group.itemIds.map(id=>dictionaries[side].get(id)).filter(Boolean);await yieldWork()}
 delete report.storageFormat;delete report.textPool;delete report.tokenCatalog;return report;
}
