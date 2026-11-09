import test from 'node:test';import assert from 'node:assert/strict';
import {groupMappingInventory,initializeMappingResolution,applyMappingDecision,mappingDecisionKey,updateMappingSummary,migrateMappingResolution,MAPPING_RESOLUTION_VERSION} from '../engine/resolution.mjs';
import {compactReport,hydrateReport} from '../engine/report-storage.mjs';
const item=(id,name,kind='component',value='')=>({id,name,kind,value,category:kind==='token'?'Foundations and tokens':'Actions',evidence:[{source:'Local/button.ts',line:1,snippet:'definition'}],variants:[],html:'',css:'',styleProfile:{}});
function report(a,b){return {extractions:{old:a,new:b},items:a.map((old,i)=>({id:'gap-'+i,old,new:b[i]||null,status:b[i]?'Changed':'Unverified',hours:b[i]?4:0,estimateAvailable:!!b[i]})),domains:['Actions','Foundations and tokens'],summary:{},savedLibraries:{old:{id:'a',version:'1'},new:{id:'b',version:'2'}},taxonomy:{items:[]}}}
test('groups exports, typed props and variants without losing underlying evidence',()=>{const a=[item('1','Button'),item('2','ButtonProps','api',"size: 'small' | 'large'; loading?: boolean"),item('3','md-filled-button'),item('4','--button-radius','token','8px')];const groups=groupMappingInventory(a,'source'),button=groups.find(group=>group.label==='Button');assert.equal(button.records.length,3);assert.ok(button.props.length);assert.ok(button.relatedItemIds.includes('4'));assert.equal(groups.reduce((sum,group)=>sum+group.itemIds.length,0),4)});
test('names alone stay suggested and leave implementation effort unestimated',()=>{const a=item('a','TextInput');a.category='Forms and input';const b=item('b','md-outlined-text-field');b.category='Forms and input';const r=initializeMappingResolution(report([a],[b]));assert.equal(r.mappingResolution.rows[0].status,'Suggested');assert.equal(r.items[0].estimateAvailable,false);assert.equal(r.items[0].hours,0);assert.ok(r.mappingResolution.rows[0].reasons.includes('Runtime state untested'))});
test('identical implementation evidence confirms a component across different page links',()=>{const a=item('a','md-button');a.value='background:#6750a4; padding: 8px';a.css='.md-button { background:#6750a4; padding:8px; }';a.evidence=[{source:'https://system.example/components/buttons',line:8,snippet:'button'}];const b=item('b','md-button');b.value='background:#6750a4;padding:8px';b.css='.md-button{padding:8px;background:#6750a4}';b.evidence=[{source:'https://system.example/get-started',line:42,snippet:'button'}];const r=initializeMappingResolution(report([a],[b]));assert.equal(r.mappingResolution.rows[0].status,'Confirmed');assert.equal(r.mappingResolution.rows[0].candidates[0].exactEvidence,true);assert.ok(r.mappingResolution.rows[0].candidates[0].capabilities.proofs.includes('Matching normalized implementation evidence'))});
test('ambiguous matches and computed values never receive automatic confirmation',()=>{const a=item('a','--brand','token','#123456');a.sourceIssue='Computed map';const b=item('b','--brand','token','#123456'),c=item('c','brand','token','#123456');const r=initializeMappingResolution(report([a],[b,c]));assert.equal(r.mappingResolution.rows[0].status,'Suggested');assert.ok(r.mappingResolution.rows[0].reasons.includes('Computed value unresolved'));assert.ok(r.mappingResolution.rows[0].reasons.includes('Multiple possible matches'))});
test('unique identical resolved token roles confirm correspondence, not accessibility',()=>{const a=item('a','--brand','token','#123456'),b=item('b','brand','token','#123456');const r=initializeMappingResolution(report([a],[b]));assert.equal(r.mappingResolution.rows[0].status,'Confirmed');assert.ok(r.mappingResolution.rows[0].reasons.includes('Runtime state untested'))});
test('manual approval preserves audit, requires reason and prevents conflicting claims',()=>{const r=initializeMappingResolution(report([item('a','Button')],[item('b','md-filled-button')])),source=r.mappingResolution.groups.old[0],target=r.mappingResolution.groups.new[0];assert.throws(()=>applyMappingDecision(r,{sourceId:source.id,targetId:target.id}),/reason/);applyMappingDecision(r,{sourceId:source.id,targetId:target.id,reason:'Same business action; variants checked',reviewer:'Team',approvedAt:'2026-10-14'});assert.equal(r.mappingResolution.rows[0].status,'Confirmed');assert.equal(r.mappingResolution.rows[0].decision.reviewer,'Team');assert.equal(r.extractions.old.length,1)});
test('approval memory invalidates for evidence or library version changes',async()=>{const r=initializeMappingResolution(report([item('a','Button')],[item('b','md-filled-button')])),source=r.mappingResolution.groups.old[0],target=r.mappingResolution.groups.new[0],key=await mappingDecisionKey(r,source,target);source.records[0].css='.button{color:red}';assert.notEqual(await mappingDecisionKey(r,source,target),key);source.records[0].css='';r.savedLibraries.new.version='3';assert.notEqual(await mappingDecisionKey(r,source,target),key)});
test('saved report compaction reconstructs grouped record references without duplicating source objects',()=>{const r=initializeMappingResolution(report([item('a','Button')],[item('b','md-filled-button')]));const packed=compactReport(structuredClone(r));assert.equal(packed.mappingResolution.groups.old[0].records,undefined);const restored=hydrateReport(JSON.parse(JSON.stringify(packed)));assert.equal(restored.mappingResolution.groups.old[0].records[0],restored.extractions.old[0])});
test('manual counterpart approval does not restore estimates for unresolved implementation evidence',()=>{const a=item('a','--brand','token','computeBrand()');a.sourceIssue='Computed source';const b=item('b','brand','token','#123456');const r=initializeMappingResolution(report([a],[b]));applyMappingDecision(r,{sourceId:r.mappingResolution.groups.old[0].id,targetId:r.mappingResolution.groups.new[0].id,reason:'Same semantic brand role; resolved value still unknown',reviewer:'Team'});assert.equal(r.items[0].estimateAvailable,false);assert.equal(r.items[0].hours,0);assert.ok(r.mappingResolution.rows[0].reasons.includes('Computed value unresolved'))});
test('component capability comparison includes related token values while retaining their foundation records',()=>{const button=item('b','Button'),token=item('t','--brand','token','#123456');button.tokens=[{name:'--brand',value:'#123456'}];const groups=groupMappingInventory([button,token],'source'),group=groups.find(group=>group.label==='Button');assert.deepEqual(group.tokenValues,['#123456']);assert.equal(groups.reduce((sum,g)=>sum+g.itemIds.length,0),2)});
test('one-sided records and groups receive directional Not found labels without asserting removal or estimating effort',()=>{const r=report([item('a','Button')],[item('b','Table')]);r.extractions.new[0].category='Data display';r.items=[{id:'gap-a',old:r.extractions.old[0],new:null,status:'Unverified',hours:0,estimateAvailable:false},{id:'gap-b',old:null,new:r.extractions.new[0],status:'Unverified',hours:0,estimateAvailable:false}];initializeMappingResolution(r);assert.equal(r.items[0].presenceStatus,'Not found in target');assert.equal(r.items[1].presenceStatus,'Not found in source');assert.equal(r.mappingResolution.summary.notFoundInTarget,1);assert.equal(r.mappingResolution.summary.notFoundInSource,1);assert.ok(r.items.every(row=>row.status==='Unverified'&&row.hours===0&&!row.absenceConfirmed));assert.ok(r.items[0].presenceNote.includes('removal is not inferred'))});
test('suggested and confirmed counterpart groups are not labelled missing',()=>{const r=initializeMappingResolution(report([item('a','Button')],[item('b','md-filled-button')]));assert.equal(r.mappingResolution.rows[0].presenceStatus,null)});
test('every group and unverified record receives an actionable exclusive resolution queue',()=>{const a=item('a','Button'),b=item('b','Button'),c=item('c','--brand','token','computeColor()');c.sourceIssue='Computed value';const d=item('d','--brand','token','#123456');const r=initializeMappingResolution(report([a,c],[b,d]));r.items[0].status='Unverified';updateMappingSummary(r);assert.equal(r.mappingResolution.rows[0].resolutionStatus,'Candidate proposed');assert.equal(r.mappingResolution.rows[1].resolutionStatus,'Computed value unresolved');assert.equal(r.items[0].reviewStatus,'Candidate proposed');assert.equal(Object.values(r.mappingResolution.summary.resolutionQueues).reduce((a,b)=>a+b,0),r.mappingResolution.rows.length);assert.equal(Object.values(r.summary.reviewCounts).reduce((a,b)=>a+b,0),r.items.length);assert.ok(r.mappingResolution.rows.every(row=>row.nextAction));assert.ok(r.items.every(item=>!item.estimateAvailable&&item.hours===0))});
test('ambiguous candidates stay distinct and approval updates the queue to validation pending',()=>{const a=item('a','Button'),b=item('b','Button'),c=item('c','Alternate action');c.canonicalLabel='Alternate action';for(const entry of [a,b,c])entry.html='<button role="button">Submit</button>';const r=initializeMappingResolution(report([a],[b,c]));assert.equal(r.mappingResolution.rows[0].resolutionStatus,'Ambiguous counterpart');const source=r.mappingResolution.groups.old[0],target=r.mappingResolution.groups.new[0];applyMappingDecision(r,{sourceId:source.id,targetId:target.id,reason:'Reviewed declared capabilities',reviewer:'Team'});assert.equal(r.mappingResolution.rows[0].resolutionStatus,'Validation pending');assert.equal(r.mappingResolution.summary.resolutionQueues['Ambiguous counterpart'],0)});
test('confirmed static token mappings do not request component runtime tests',()=>{const r=initializeMappingResolution(report([item('a','--brand','token','#123456')],[item('b','brand','token','#123456')]));assert.equal(r.mappingResolution.rows[0].resolutionStatus,'Confirmed counterpart')});

test('specialized buttons remain distinct while their API records group with them',()=>{
 const entries=['Button','SplitButton','SplitButtonProps','ToggleButton','FloatingActionButton'].map((name,index)=>item(String(index),name,name.endsWith('Props')?'api':'component'));
 const groups=groupMappingInventory(entries,'source');
 assert.deepEqual(groups.map(group=>group.label),['Button','Split button','Toggle button','Floating action button']);
 assert.deepEqual(groups.find(group=>group.label==='Split button').itemIds,['1','2']);
});

test('capability candidates remain discoverable beyond forty targets without truncating alternatives',()=>{
 const a=item('a','Legacy action');a.html='<button role="button">Save</button>';
 const targets=Array.from({length:45},(_,i)=>{const target=item('target-'+i,'Replacement '+i);target.html=i<6?a.html:'';return target});
 const small=initializeMappingResolution(report([a],targets.slice(0,6)));
 const large=initializeMappingResolution(report([a],targets));
 assert.equal(large.mappingResolution.rows[0].status,'Suggested');
 assert.equal(large.mappingResolution.rows[0].candidates.length,6);
 assert.deepEqual(large.mappingResolution.rows[0].candidates,small.mappingResolution.rows[0].candidates);
 assert.equal(large.mappingResolution.summary.notFoundInSource,39);
});

test('full markup structure prevents equal prefixes from claiming matching evidence',()=>{
 const a=item('a','Button'),b=item('b','Button');
 const prefix='<section>'+Array.from({length:160},()=>'<span></span>').join('');
 a.html=prefix+'<button role="button" disabled>Save</button></section>';
 b.html=prefix+'<input role="button" disabled></section>';
 const r=initializeMappingResolution(report([a],[b]));
 assert.equal(r.mappingResolution.rows[0].status,'Suggested');
 assert.ok(!r.mappingResolution.rows[0].candidates[0].capabilities.proofs.includes('Matching retrieved markup structure'));
});

test('approval and reassignment return unused targets to exclusive adoption queues',()=>{
 const a=item('a','Legacy action'),b=item('b','Replacement one'),c=item('c','Replacement two');
 for(const entry of [a,b,c])entry.html='<button role="button">Save</button>';
 const r=initializeMappingResolution(report([a],[b,c]));
 const source=r.mappingResolution.groups.old[0],targets=r.mappingResolution.groups.new;
 assert.equal(r.mappingResolution.rows.length,1);
 applyMappingDecision(r,{sourceId:source.id,targetId:targets[0].id,reason:'Reviewed first counterpart'});
 assert.equal(r.mappingResolution.rows.length,2);
 assert.equal(r.mappingResolution.rows.find(row=>!row.sourceId).targetId,targets[1].id);
 applyMappingDecision(r,{sourceId:source.id,targetId:targets[1].id,reason:'Revised after review'});
 assert.equal(r.mappingResolution.rows.length,2);
 assert.equal(r.mappingResolution.rows.find(row=>!row.sourceId).targetId,targets[0].id);
 assert.equal(r.mappingResolution.summary.notFoundInSource,1);
 assert.equal(Object.values(r.mappingResolution.summary.resolutionQueues).reduce((sum,count)=>sum+count,0),2);
 assert.equal(r.items[0].estimateAvailable,false);
});

test('a target still proposed for another source remains a candidate rather than missing',()=>{
 const a=item('a','Legacy one'),d=item('d','Legacy two'),b=item('b','Replacement one'),c=item('c','Replacement two');
 for(const entry of [a,d,b,c])entry.html='<button role="button">Save</button>';
 const r=initializeMappingResolution(report([a,d],[b,c]));
 applyMappingDecision(r,{sourceId:r.mappingResolution.groups.old[0].id,targetId:r.mappingResolution.groups.new[0].id,reason:'Reviewed counterpart'});
 assert.equal(r.mappingResolution.rows.length,2);
 assert.equal(r.mappingResolution.summary.notFoundInSource,0);
 assert.equal(r.mappingResolution.rows[1].status,'Suggested');
});

test('approval memory includes related token definitions and remains stable across record/property order',async()=>{
 const a=item('a','Button'),api=item('api','ButtonProps','api','disabled?: boolean'),b=item('b','Button'),token=item('token','--brand','token','#123456');
 a.tokens=[{name:'--brand',value:'#123456'}];
 const r=initializeMappingResolution(report([a,api,token],[b]));
 const source=r.mappingResolution.groups.old[0],target=r.mappingResolution.groups.new[0];
 const key=await mappingDecisionKey(r,source,target);
 source.records.reverse();
 source.records[0].evidence=[{snippet:'definition',line:1,source:'Local/button.ts'}];
 assert.equal(await mappingDecisionKey(r,source,target),key);
 token.tokenDefinitions=[{scope:':root',value:'#abcdef'}];
 assert.notEqual(await mappingDecisionKey(r,source,target),key);
 delete token.tokenDefinitions;
 assert.equal(await mappingDecisionKey(r,source,target),key);
 a.tokens=[{name:'--brand',value:'#ffffff'}];
 assert.notEqual(await mappingDecisionKey(r,source,target),key);
});

test('confirmation never restores invalid, registry-only, or subsequently unverified estimates',()=>{
 for(const change of [row=>{row.hours=NaN},row=>{row.hours=-2},row=>{row.hours=Infinity},row=>{row.estimateAvailable=undefined},row=>{row.old.registryOnly=true},row=>{row.status='Unverified'}]){
  const r=report([item('a','--brand','token','#123456')],[item('b','brand','token','#123456')]);
  change(r.items[0]);initializeMappingResolution(r);
  assert.equal(r.items[0].estimateAvailable,false);assert.equal(r.summary.hours,0);
 }
 const r=initializeMappingResolution(report([item('a','--brand','token','#123456')],[item('b','brand','token','#123456')]));
 assert.equal(r.items[0].estimateAvailable,true);
 r.items[0].status='Unverified';updateMappingSummary(r);
 assert.equal(r.items[0].estimateAvailable,false);assert.equal(r.summary.hours,0);
});

test('markup, ARIA and attributes from a single snippet are not independent confirmation evidence',()=>{
 const a=item('a','Button'),b=item('b','Button');
 for(const entry of [a,b])entry.html='<button role="button" disabled>Save</button>';
 const r=initializeMappingResolution(report([a],[b]));
 assert.equal(r.mappingResolution.rows[0].candidates[0].capabilities.proofs.length,3);
 assert.equal(r.mappingResolution.rows[0].status,'Suggested');
 assert.equal(r.items[0].estimateAvailable,false);
 const sourceApi=item('a-api','ButtonProps','api','disabled?: boolean');
 const targetApi=item('b-api','ButtonProps','api','disabled?: boolean');
 const corroborated=initializeMappingResolution(report([a,sourceApi],[b,targetApi]));
 assert.equal(corroborated.mappingResolution.rows[0].status,'Confirmed');
 assert.equal(corroborated.mappingResolution.rows[0].resolutionStatus,'Validation pending');
});

test('old saved resolutions rebuild false confirmations and retain manual approval audit for reapproval',()=>{
 const a=item('a','Button'),b=item('b','Button');
 for(const entry of [a,b])entry.html='<button role="button" disabled>Save</button>';
 const r=initializeMappingResolution(report([a],[b]));
 const source=r.mappingResolution.groups.old[0],target=r.mappingResolution.groups.new[0];
 applyMappingDecision(r,{id:'old-hash',sourceId:source.id,targetId:target.id,reason:'Prior review',reviewer:'Team'});
 assert.equal(r.items[0].estimateAvailable,true);
 r.mappingResolution.schemaVersion=1;
 migrateMappingResolution(r);
 assert.equal(r.mappingResolution.schemaVersion,MAPPING_RESOLUTION_VERSION);
 assert.equal(r.mappingResolution.rows[0].status,'Suggested');
 assert.equal(r.items[0].estimateAvailable,false);
 assert.equal(r.mappingResolution.migration.approvalReview[0].reviewer,'Team');
 assert.equal(r.mappingResolution.migration.approvalReview[0].status,'Needs reapproval');
 const current=r.mappingResolution;
 migrateMappingResolution(r);assert.equal(r.mappingResolution,current);
 applyMappingDecision(r,{id:'new-hash',sourceId:source.id,targetId:target.id,reason:'Current evidence reviewed',reviewer:'Team'});
 assert.equal(r.mappingResolution.migration.approvalReview[0].status,'Reapproved');
 assert.equal(r.mappingResolution.migration.approvalReview[0].currentDecisionId,'new-hash');
});

test('migration recomputes old automatic confirmations and initializes missing resolutions',()=>{
 const r=report([item('a','Button')],[item('b','Button')]);
 migrateMappingResolution(r);
 r.mappingResolution.schemaVersion=1;
 Object.assign(r.mappingResolution.rows[0],{status:'Confirmed',targetId:r.mappingResolution.groups.new[0].id});
 migrateMappingResolution(r);
 assert.equal(r.mappingResolution.rows[0].status,'Suggested');
 assert.equal(r.mappingResolution.migration.approvalReview.length,0);
});
