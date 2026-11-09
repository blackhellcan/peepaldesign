import test from 'node:test';import assert from 'node:assert/strict';import {readFile,readdir} from 'node:fs/promises';
import {RUBRIC,NOT_ESTIMATED,effortDrivers,effortLevel,effortRange,estimateRecord,effortLabel,migrationBriefTotals} from '../engine/estimate.mjs';
import {scanDocuments} from '../engine/extract.mjs';
import {initializeMappingResolution} from '../engine/resolution.mjs';
import {buildCategoryTree} from '../engine/category-tree.mjs';
import {applyMigrationPlanning,migrationPlan} from '../engine/migration-planning.mjs';
import {buildMigrationBrief} from '../engine/migration-brief.mjs';
const doc=content=>({content,url:'Pasted code',type:'text/plain'});
const pair=(differences,extra={})=>({old:{name:'btn'},new:{name:'btn'},kind:'component',status:'Changed',insight:{differences},...extra});
// Mirrors the /api/compare order in server.mjs so the golden checks exercise the shipped pipeline.
function compare(a,b,scenario='upgrade'){const report=scanDocuments([doc(a)],[doc(b)],scenario);report.extractions={old:report.inventories.old.items,new:report.inventories.new.items};delete report.inventories;report.categoryTree=buildCategoryTree(report.extractions,report.items);applyMigrationPlanning(report,{includePrompts:false});initializeMappingResolution(report);for(const item of report.items)item.migration=migrationPlan(item);report.migrationBrief=buildMigrationBrief(report);return report}

test('drivers map observed differences onto the 1–5 rubric with severity floors',()=>{
 assert.equal(effortLevel(effortDrivers(pair([{type:'token',state:'default'}]))),1);
 assert.equal(effortLevel(effortDrivers(pair([{type:'style',state:'focus'}]))),2);
 assert.equal(effortLevel(effortDrivers(pair([{type:'api',state:'default'}]))),3);
 assert.equal(effortLevel(effortDrivers(pair([{type:'markup',state:'default'}]))),4);
 assert.equal(effortLevel(effortDrivers(pair([{type:'style',state:'default'},{type:'style',state:'focus'},{type:'style',state:'hover'},{type:'style',state:'active'},{type:'style',state:'disabled'}],{status:'Renamed'}))),4,'1+1+2+3 points reach the Hard band');
 assert.equal(effortLevel(effortDrivers(pair([{type:'token',state:'default'}]),'switch')),2,'a framework switch is never trivial');
});
test('unchanged definitions carry verification time and missing counterparts are never priced',()=>{
 const unchanged=estimateRecord({old:{},new:{},kind:'component',status:'Unchanged'});assert.equal(unchanged.effortLevel,1);assert.equal(unchanged.hours,RUBRIC.base[1][0]);assert.ok(unchanged.hours>0);
 const missing=estimateRecord({old:{},new:null,kind:'component',status:'Source only'});assert.equal(missing.effortLevel,null);assert.equal(missing.hours,0);assert.equal(missing.estimateAvailable,false);assert.equal(missing.tier,NOT_ESTIMATED);
 const stored=estimateRecord({old:{registryOnly:true},new:{},kind:'component',status:'Unchanged'});assert.equal(stored.estimateAvailable,false);
 const optional=estimateRecord({old:null,new:{},kind:'component',status:'Added'});assert.equal(optional.optional,true);
});
test('manual edits keep the level spread, and legacy reports keep their 50% range',()=>{
 assert.deepEqual(effortRange(10,2),{low:10,high:20});assert.deepEqual(effortRange(0.5,1),{low:0.5,high:1.5});assert.deepEqual(effortRange(4,undefined),{low:4,high:6});
});
test('card tier and planning size come from the same label',()=>{
 const report=scanDocuments([doc('.btn {background:red}.btn:focus {outline:none}')],[doc('.btn {background:blue}.btn:focus {outline:2px solid blue}')],'upgrade');const item=report.items.find(i=>i.name==='btn');
 assert.equal(item.effortLevel,2);assert.equal(item.tier,effortLabel(2));assert.equal(migrationPlan(item).size,item.tier);
});
test('identical inputs produce no invented work, only verification, and totals are deterministic',()=>{
 const css='.btn {background:red;padding:4px}.card {padding:16px}',first=compare(css,css),second=compare(css,css);
 assert.ok(first.items.every(item=>item.status==='Unchanged'));
 const totals=migrationBriefTotals(first.migrationBrief,{buffer:0});assert.equal(totals.hours.low,2*RUBRIC.base[1][0]);assert.equal(totals.hours.high,2*RUBRIC.base[1][1]);
 assert.deepEqual(migrationBriefTotals(second.migrationBrief,{buffer:0}).hours,totals.hours);
});
test('name-only matches stay suggested, unestimated, and score no more than the name weight',()=>{
 const report=compare('.btn {background:red}.btn:focus {outline:none}','.btn {background:blue}.btn:focus {outline:2px solid blue}'),row=report.mappingResolution.rows.find(r=>r.sourceId?.includes('Button'));
 assert.equal(row.status,'Suggested');assert.ok(row.candidates[0].score<=10);
 const item=report.items.find(i=>i.name==='btn');assert.equal(item.estimateAvailable,false);assert.equal(item.tier,NOT_ESTIMATED);assert.equal(item.migration.size,NOT_ESTIMATED);assert.equal(migrationBriefTotals(report.migrationBrief).available,false);
});
test('planning totals scale monotonically with applications, QA allowance and rate',()=>{
 const brief=compare('.btn {padding:4px}','.btn {padding:4px}').migrationBrief,base=migrationBriefTotals(brief,{apps:1,buffer:0,rate:50});
 const more=migrationBriefTotals(brief,{apps:3,buffer:20,rate:100});assert.ok(more.hours.low>base.hours.low&&more.hours.high>base.hours.high&&more.budget.low>base.budget.low);
 assert.equal(base.assumptions.productiveHours,RUBRIC.productiveHours);
});
test('effort maths lives only in engine/estimate.mjs and the browser never runs comparisons',async()=>{
 const web=new URL('../web/',import.meta.url),engine=new URL('../engine/',import.meta.url);
 for(const name of (await readdir(web)).filter(file=>file.endsWith('.js'))){const source=await readFile(new URL(name,web),'utf8');
  assert.doesNotMatch(source,/createComparisonReport\(/,name+' must not compare inventories in the browser');
  assert.doesNotMatch(source,/\*\s*35\b|\b35\s*\)/,name+' must not hard-code productive hours');
  assert.doesNotMatch(source,/decisionTotalsLocal/,name);}
 for(const name of (await readdir(engine)).filter(file=>file.endsWith('.mjs')&&file!=='estimate.mjs')){const source=await readFile(new URL(name,engine),'utf8');
  assert.doesNotMatch(source,/hours\s*<=\s*\d|hours\s*\*\s*1\.5|\*\s*35\b/,name+' must use the shared rubric');}
});
