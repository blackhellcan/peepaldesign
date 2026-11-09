import {dimensionEvidence} from './category-tree.mjs';
import {componentFamily} from './extract.mjs';
import {NOT_ESTIMATED} from './estimate.mjs';
export const MAPPING_RESOLUTION_VERSION=2;
const ROOTS=[['Icon button',/icon.?button/],['Button group',/(?:button|btn).?group/],['Text field',/text.?field|text.?input|textfield|textinput/],['Text area',/text.?area/],['Floating action button',/floating.?action|\bfab\b/],['Split button',/split.?button/],['Toggle button',/toggle.?button/],['Button',/\bbutton\b|\bbtn\b/],['Checkbox',/checkbox/],['Radio',/\bradio\b/],['Toggle switch',/\bswitch\b/],['Select and dropdown',/\bselect\b|dropdown/],['Tabs',/\btabs?\b/],['Card',/\bcard\b/],['Modal dialog',/dialog|modal/],['Table',/\btable\b/]];
export function resolutionName(item){let name=item.name.replace(/([a-z])([A-Z])/g,'$1-$2').toLowerCase().replace(/^(?:--|\$|md-|mdc-|cds-|bx--|wa-|sp-|spectrum--?|bp\d?-|fui-|ms-|bs-|bi-)/,'').replace(/[_ .:/]+/g,'-').replace(/-(?:props|options|interface)$/,'');return name.replace(/text-input|textfield|textinput/g,'text-field').replace(/^-|-$/g,'')}
function groupLabel(item){if(item.canonicalLabel&&!/Anything that fits/.test(item.canonicalLabel)&&['component','api'].includes(item.kind)&&!item.icon)return item.canonicalLabel;const name=resolutionName(item).replace(/-/g,' ');if(['component','api'].includes(item.kind)&&!item.icon){const root=ROOTS.find(([,pattern])=>pattern.test(name));if(root)return root[0]}return item.name}
function groupType(item){return item.icon?'icon':['component','api'].includes(item.kind)?'component':item.kind}
function value(item){return item.resolvedValue||item.examples?.value||item.value||''}
function propEvidence(items){const props=new Set();for(const item of items.filter(item=>item.kind==='api'))for(const match of (item.value||'').matchAll(/\b([a-z][\w]*)\??\s*:\s*([^;\n]+)/g))props.add(match[1]+':'+match[2].trim());return [...props].sort()}
export function groupMappingInventory(items,side){
 const map=new Map();for(const item of items){const label=groupLabel(item),kind=groupType(item),key=kind+'|'+item.category+'|'+label;if(!map.has(key))map.set(key,{id:side+':'+key,label,category:item.category,kind,records:[]});map.get(key).records.push(item)}
 const groups=[...map.values()];for(const group of groups){group.itemIds=group.records.map(item=>item.id);group.relatedItemIds=[];group.dimensions=dimensionEvidence(group.records);group.props=propEvidence(group.records);group.tokenValues=[...new Set(group.records.filter(item=>['token','foundation'].includes(item.kind)).map(value).filter(Boolean))];group.styles=[...new Set(group.records.flatMap(item=>Object.keys(item.styleProfile?.default||{})))].sort();group.structures=[...new Set(group.records.filter(item=>item.html).map(item=>item.html.replace(/\b(?:class|id|style)=["'][^"']*["']/g,'').replace(/>[\s\S]*?</g,'><').replace(/\s+/g,' ')))];group.evidence=group.records.flatMap(item=>(item.evidence||[]).map(entry=>({...entry,itemId:item.id}))).slice(0,24);group.computed=group.records.some(item=>item.sourceIssue||item.aliasIssues?.length);group.a11y=group.records.flatMap(item=>[...(item.html||'').matchAll(/\b(aria-[\w-]+|role)=["']([^"']+)["']/g)].map(match=>match[1]+'='+match[2]));}
 // Component-specific tokens stay in Foundations and are cross-referenced rather than dropped or double-counted.
 for(const component of groups.filter(group=>group.kind==='component')){const terms=component.label.toLowerCase().split(/\W+/).filter(term=>term.length>3),refs=new Set(component.records.flatMap(item=>(item.tokens||[]).map(token=>token.name)));for(const item of items.filter(item=>item.kind==='token'))if(refs.has(item.name)||terms.some(term=>resolutionName(item).split('-').includes(term)||(item.evidence||[]).some(entry=>new RegExp('/'+term+'(?:/|[._-])','i').test(entry.source||''))))component.relatedItemIds.push(item.id);component.tokenValues=[...new Set(items.filter(item=>component.relatedItemIds.includes(item.id)).map(value).filter(Boolean))]}
 if(groups.reduce((sum,group)=>sum+group.itemIds.length,0)!==items.length)throw Error('Grouped mapping coverage mismatch');return groups;
}
function shared(a,b){const set=new Set(b);return [...new Set(a.filter(value=>set.has(value)))]}
function observed(group,key){return group.dimensions[key].map(item=>item.name).filter(name=>name!=='default')}
export function compareMappingCapabilities(source,target){
 const dimensions={};for(const key of ['variations','sizes','states']){const a=observed(source,key),b=observed(target,key);dimensions[key]={source:a,target:b,shared:shared(a,b),sourceOnly:a.filter(value=>!b.includes(value)),unknown:!a.length||!b.length};}
 const props={source:source.props,target:target.props,shared:shared(source.props,target.props)},tokens={source:source.tokenValues,target:target.tokenValues,shared:shared(source.tokenValues,target.tokenValues)},a11y={source:[...new Set(source.a11y)],target:[...new Set(target.a11y)],shared:shared(source.a11y,target.a11y),runtimeVerified:false};
 const proofs=[];if(tokens.shared.length)proofs.push('Matching resolved token/foundation values');if(shared(source.structures,target.structures).length)proofs.push('Matching retrieved markup structure');if(props.shared.length)proofs.push('Matching declared prop signatures');for(const key of ['variations','sizes','states'])if(dimensions[key].shared.length)proofs.push('Matching observed '+key);if(a11y.shared.length)proofs.push('Matching published ARIA/role attributes');
 return {dimensions,props,tokens,a11y,proofs,computed:source.computed||target.computed,unknowns:['Runtime state untested','Accessibility behavior untested',...(source.computed||target.computed?['Computed value unresolved']:[])]};
}
function canonicalEvidenceValue(value){if(Array.isArray(value))return value.map(canonicalEvidenceValue).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalEvidenceValue(value[key])]));return typeof value==='string'?value.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\s+/g,' ').replace(/\s*([:;,{}])\s*/g,'$1').trim().toLowerCase():value}
function canonicalCss(value){return String(value||'').split(/(?<=})/).map(rule=>{const match=rule.match(/^\s*([^{}]+)\{([\s\S]*)\}\s*$/);if(!match)return canonicalEvidenceValue(rule);const selectors=match[1].split(',').map(selector=>canonicalEvidenceValue(selector)).sort().join(',');const declarations=match[2].split(';').map(declaration=>canonicalEvidenceValue(declaration)).filter(Boolean).sort().join(';');return selectors+'{'+declarations+'}'}).filter(Boolean).sort().join('')}
function canonicalHtml(value){return String(value||'').replace(/\s+/g,' ').replace(/\bclass=(['"])([^'"]*)\1/gi,(_,quote,classes)=>'class="'+classes.split(/\s+/).filter(Boolean).sort().join(' ')+'"').trim().toLowerCase()}
function canonicalImplementation(item){return canonicalEvidenceValue({kind:item.kind,value:item.value,resolvedValue:item.resolvedValue,html:canonicalHtml(item.html),css:canonicalCss(item.css),styleProfile:item.styleProfile,variants:item.variants,tokenDefinitions:item.tokenDefinitions,tokens:item.tokens,icon:item.icon,glyph:item.glyph})}
function substantiveImplementation(item){return Boolean(item.value||item.resolvedValue||item.css||item.styleProfile&&Object.keys(item.styleProfile).length||item.variants?.length||item.tokenDefinitions?.length||item.tokens?.length||item.icon||item.glyph)}
function equivalentRecord(source,target,sourceLabel,targetLabel){if(source.kind!==target.kind)return false;const sameSemanticName=resolutionName(source)===resolutionName(target)||sourceLabel===targetLabel;if(!sameSemanticName)return false;return JSON.stringify(canonicalImplementation(source))===JSON.stringify(canonicalImplementation(target))}
function equivalentGroups(source,target){if(source.kind!==target.kind||source.category!==target.category||source.label!==target.label)return false;if(!source.records.length||!source.records.some(substantiveImplementation))return false;return source.records.every(record=>target.records.some(candidate=>equivalentRecord(record,candidate,source.label,target.label)))}
// Markup and its ARIA attributes are one evidence family, not two independent proofs.
function candidateScore(source,target){const sourceName=resolutionName({name:source.label}),targetName=resolutionName({name:target.label}),sameName=sourceName===targetName,family=componentFamily(source.label)===componentFamily(target.label),capabilities=compareMappingCapabilities(source,target),exactEvidence=equivalentGroups(source,target);if(exactEvidence)capabilities.proofs.push('Matching normalized implementation evidence');const reasons=[];if(sameName)reasons.push('Same canonical component label');else if(family)reasons.push('Same component family across framework naming');if(capabilities.tokens.shared.length)reasons.push('Shared resolved token values');if(capabilities.props.shared.length)reasons.push('Shared declared props');if(capabilities.proofs.includes('Matching retrieved markup structure'))reasons.push('Matching retrieved markup structure');if(capabilities.proofs.some(proof=>/observed (variations|sizes|states)/.test(proof)))reasons.push('Overlapping variants, sizes or states');if(capabilities.a11y.shared.length)reasons.push('Shared published ARIA or role evidence');if(exactEvidence)reasons.push('Matching normalized implementation evidence');// Weighted 0–100 evidence score: anatomy 35, capabilities 25, role 20, token
// slots 10, name 10. A shared name alone only proposes a candidate for review.
const glyph=source.kind==='icon'&&source.records.some(a=>target.records.some(b=>a.html&&a.html===b.html));if(glyph)reasons.push('Matching SVG or glyph geometry');
const capabilityProofs=capabilities.proofs.filter(proof=>/observed (variations|sizes|states)/.test(proof)).length+Number(capabilities.props.shared.length>0);
const anatomy=exactEvidence||glyph||capabilities.proofs.includes('Matching retrieved markup structure')?1:0,capability=exactEvidence?1:Math.min(1,capabilityProofs/3),role=exactEvidence||capabilities.a11y.shared.length?1:0,tokenSlots=exactEvidence||capabilities.tokens.shared.length?1:0,naming=sameName?1:family?.5:0;
const score=Math.round(35*anatomy+25*capability+20*role+10*tokenSlots+10*naming);const independent=Number(capabilities.tokens.shared.length>0)+Number(capabilities.props.shared.length>0)+Number(capabilities.proofs.includes('Matching retrieved markup structure')||capabilities.a11y.shared.length>0);const quality=[source.records,target.records].flatMap(records=>records.map(record=>record.evidenceProfile?.quality||'weak'));const strongEvidence=quality.some(value=>value==='strong');const confirmed=sameName&&!capabilities.computed&&(exactEvidence||(source.kind==='token'||source.kind==='foundation'?capabilities.tokens.shared.length>0:independent>=2&&capabilities.proofs.length>=3));return {targetId:target.id,score,confirmed,capabilities,sameName,family,exactEvidence,evidenceQuality:strongEvidence?'strong':quality.includes('moderate')?'moderate':'weak',matchReasons:[...new Set(reasons)]};}
export function initializeMappingResolution(report,decisions=[]){
 const groups={old:groupMappingInventory(report.extractions.old,'source'),new:groupMappingInventory(report.extractions.new,'target')},index=new Map();for(const target of groups.new){const key=target.kind+'|'+target.category;if(!index.has(key))index.set(key,[]);index.get(key).push(target)}
 // Index every capability used by scoring so adding unrelated targets cannot hide a match.
 const features=group=>[
  'name:'+resolutionName({name:group.label}),
  'family:'+componentFamily(group.label),
  ...group.tokenValues.map(value=>'token:'+value),
  ...group.props.map(value=>'prop:'+value),
  ...group.structures.map(value=>'structure:'+value),
  ...group.a11y.map(value=>'a11y:'+value),
  ...['variations','sizes','states'].flatMap(key=>observed(group,key).map(value=>key+':'+value)),
  ...(group.kind==='icon'?group.records.filter(item=>item.html).map(item=>'icon:'+item.html):[])
 ];
 const postings=new Map();for(const [key,bucket]of index){const evidence=new Map();for(const target of bucket)for(const feature of new Set(features(target))){if(!evidence.has(feature))evidence.set(feature,[]);evidence.get(feature).push(target)}postings.set(key,evidence)}
 const rows=groups.old.map(source=>{const posting=postings.get(source.kind+'|'+source.category),pool=new Map();if(posting)for(const feature of features(source))for(const target of posting.get(feature)||[])pool.set(target.id,target);const candidates=[...pool.values()].map(target=>candidateScore(source,target)).filter(candidate=>candidate.score>=10).sort((a,b)=>b.score-a.score||a.targetId.localeCompare(b.targetId)),best=candidates[0];const status=best?.confirmed&&(!candidates[1]||best.score-candidates[1].score>=15)?'Confirmed':candidates.length?'Suggested':'Unresolved';const reasons=[...(source.computed?['Computed value unresolved']:[]),...(!candidates.length?['No counterpart identified']:candidates.length>1?['Multiple possible matches']:status!=='Confirmed'?['Insufficient capability evidence']:[]),'Runtime state untested'];if(best?.matchReasons?.length&&status!=='Confirmed')reasons.push('Evidence: '+best.matchReasons.slice(0,3).join('; '));return {id:source.id,sourceId:source.id,targetId:status==='Confirmed'?best.targetId:null,status,basis:status==='Confirmed'?'Deterministic capability evidence':'Candidate review',candidates,reasons:[...new Set(reasons)],confidence:best?.evidenceQuality||'weak',matchReasons:best?.matchReasons||[],effort:null};});
 const claims=new Map();for(const row of rows.filter(row=>row.status==='Confirmed'))claims.set(row.targetId,(claims.get(row.targetId)||0)+1);for(const row of rows)if(claims.get(row.targetId)>1){row.status='Suggested';row.targetId=null;row.reasons.unshift('Multiple source groups claim this counterpart')}
 report.mappingResolution={schemaVersion:MAPPING_RESOLUTION_VERSION,groups,rows,policy:'Confirmation establishes correspondence only. Runtime and accessibility parity remain separate checks. No records are discarded.'};for(const decision of decisions)applyMappingDecision(report,decision);updateMappingSummary(report);return report;
}
// Old automatic confirmations are recomputed; prior approvals remain auditable, never silently trusted.
export function migrateMappingResolution(report){
 const previous=report.mappingResolution;
 if(previous?.schemaVersion===MAPPING_RESOLUTION_VERSION)return report;
 if(!previous)return initializeMappingResolution(report);
 const approvalReview=[...(previous.migration?.approvalReview||[]),...previous.rows.filter(row=>row.decision).map(row=>({...row.decision,status:'Needs reapproval',sourceLabel:previous.groups.old.find(group=>group.id===row.sourceId)?.label,targetLabel:previous.groups.new.find(group=>group.id===row.targetId)?.label}))];
 initializeMappingResolution(report);
 report.mappingResolution.migration={fromVersion:previous.schemaVersion||1,approvalReview,message:'Saved mappings were recomputed with current evidence rules. Previous manual approvals are retained for review and require approval against the current library versions and evidence.'};
 return report;
}
export function applyMappingDecision(report,decision){
 const resolution=report.mappingResolution,row=resolution.rows.find(row=>row.id===decision.sourceId&&row.sourceId),source=resolution.groups.old.find(group=>group.id===decision.sourceId),target=resolution.groups.new.find(group=>group.id===decision.targetId);if(!row||!source||!target||source.kind!==target.kind||source.category!==target.category||!decision.reason?.trim())throw Error('Select compatible source/target groups and provide a reason.');
 if(resolution.rows.some(other=>other.sourceId&&other.id!==row.id&&other.status==='Confirmed'&&other.targetId===target.id))throw Error('This counterpart is already confirmed for another source group.');
 row.status='Confirmed';row.targetId=target.id;row.basis='Manually approved mapping';row.decision={...decision};for(const prior of resolution.migration?.approvalReview||[])if(prior.sourceId===source.id&&prior.status==='Needs reapproval'){prior.status=prior.targetId===target.id?'Reapproved':'Superseded';prior.currentDecisionId=decision.id||null;}row.confirmedCapabilities=compareMappingCapabilities(source,target);row.reasons=row.confirmedCapabilities.unknowns;resolution.rows=resolution.rows.filter(other=>other.id!==target.id);updateMappingSummary(report);return report;
}
// Keep every target either attached to an active decision or in its own adoption queue.
function reconcileResolutionTargets(resolution){
 const sourceRows=resolution.rows.filter(row=>row.sourceId),represented=new Set();
 for(const row of sourceRows)if(row.status==='Confirmed')represented.add(row.targetId);else for(const candidate of row.candidates)represented.add(candidate.targetId);
 const previous=new Map(resolution.rows.filter(row=>!row.sourceId).map(row=>[row.targetId,row]));
 resolution.rows=[...sourceRows,...resolution.groups.new.filter(target=>!represented.has(target.id)).map(target=>previous.get(target.id)||{id:target.id,sourceId:null,targetId:target.id,status:'Unresolved',basis:'Target inventory',candidates:[],reasons:['Target-only adoption decision'],effort:null})];
}
export function updateMappingSummary(report){const resolution=report.mappingResolution;reconcileResolutionTargets(resolution);resolution.summary=Object.fromEntries(['Confirmed','Suggested','Unresolved'].map(status=>[status,resolution.rows.filter(row=>row.status===status).length]));resolution.summary.sourceRecords=report.extractions.old.length;resolution.summary.targetRecords=report.extractions.new.length;resolution.summary.sourceGroups=resolution.groups.old.length;resolution.summary.targetGroups=resolution.groups.new.length;applyMappingEffort(report);applyPresenceStatus(report);applyResolutionTriage(report);return report}
function stableResolutionValue(value){
 if(Array.isArray(value))return value.map(stableResolutionValue);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableResolutionValue(value[key])]));
 return value;
}
export async function mappingDecisionKey(report,source,target){
 const record=item=>stableResolutionValue({id:item.id,name:item.name,kind:item.kind,icon:item.icon,category:item.category,evidence:[...(item.evidence||[])].map(stableResolutionValue).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),value:item.value,resolvedValue:item.resolvedValue,examples:item.examples,html:item.html,css:item.css,variants:item.variants,sourceIssue:item.sourceIssue,aliasIssues:item.aliasIssues,styleProfile:item.styleProfile,tokenType:item.tokenType,tokenDefinitions:item.tokenDefinitions,tokens:item.tokens,a11y:item.a11y,registryOnly:item.registryOnly});
 const signature=(group,side)=>({id:group.id,label:group.label,records:group.records.map(record).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),related:report.extractions[side].filter(item=>group.relatedItemIds.includes(item.id)).map(record).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});
 const scope=report.savedLibraries?Object.fromEntries(Object.entries(report.savedLibraries).map(([side,library])=>[side,library?{id:library.id,name:library.name,version:library.version}:null])):report.coverage;
 const bytes=new TextEncoder().encode(JSON.stringify(stableResolutionValue({schemaVersion:2,scope,source:signature(source,'old'),target:signature(target,'new')})));return 'mapping-'+[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
}

export function applyMappingEffort(report){
 const resolution=report.mappingResolution,bySource=new Map(),sourceGroups=new Map(resolution.groups.old.map(group=>[group.id,group]));for(const row of resolution.rows.filter(row=>row.sourceId)){const group=sourceGroups.get(row.sourceId);for(const id of group.itemIds)bySource.set(id,row)}const targetGroups=new Map(resolution.groups.new.map(group=>[group.id,new Set(group.itemIds)]));
 for(const item of report.items){item.mappingEstimateBase||={hours:item.hours,available:item.estimateAvailable,level:item.effortLevel??null,tier:item.tier};const row=bySource.get(item.old?.id);item.mappingStatus=row?.status||'Unresolved';const sufficient=row?.status==='Confirmed'&&item.old&&item.new&&targetGroups.get(row.targetId)?.has(item.new.id)&&!item.old.sourceIssue&&!item.new.sourceIssue&&!item.old.aliasIssues?.length&&!item.new.aliasIssues?.length&&!item.old.registryOnly&&!item.new.registryOnly&&item.status!=='Unverified'&&item.mappingEstimateBase.available===true&&Number.isFinite(item.mappingEstimateBase.hours)&&item.mappingEstimateBase.hours>=0;item.estimateAvailable=!!sufficient;item.hours=sufficient?item.mappingEstimateBase.hours:0;item.effortLevel=sufficient?item.mappingEstimateBase.level:null;item.tier=sufficient?item.mappingEstimateBase.tier:NOT_ESTIMATED;}report.summary.hours=report.items.reduce((sum,item)=>sum+item.hours,0);return report;
}

export function applyPresenceStatus(report){
 for(const item of report.items){item.presenceStatus=item.old&&!item.new?'Not found in target':!item.old&&item.new?'Not found in source':null;item.presenceNote=item.presenceStatus?'No item-level counterpart was identified in the scanned inventory. Different naming or incomplete coverage may require review; removal is not inferred.':null;}
 const resolution=report.mappingResolution;if(resolution){for(const row of resolution.rows){row.presenceStatus=row.sourceId&&!row.targetId&&!row.candidates.length?'Not found in target':!row.sourceId&&row.targetId?'Not found in source':null;}resolution.summary.notFoundInTarget=resolution.rows.filter(row=>row.presenceStatus==='Not found in target').length;resolution.summary.notFoundInSource=resolution.rows.filter(row=>row.presenceStatus==='Not found in source').length;}return report;
}


// One exclusive queue per grouped decision; additional blockers remain attached as issues.
export const RESOLUTION_QUEUES=['Not found in target','Not found in source','Computed value unresolved','Ambiguous counterpart','Candidate proposed','Evidence needed','Validation pending','Confirmed counterpart'];
export function applyResolutionTriage(report){
 const resolution=report.mappingResolution;if(!resolution)return report;
 const groups=new Map([...resolution.groups.old,...resolution.groups.new].map(group=>[group.id,group])),bySource=new Map(),byTarget=new Map();
 const actions={
  'Not found in target':'Check target coverage and renamed equivalents. If absence is confirmed, choose a replacement or create the component.',
  'Not found in source':'Evaluate this target-only item for adoption; no source migration is required.',
  'Computed value unresolved':'Resolve aliases or computed values from the token definitions, then compare the resolved values.',
  'Ambiguous counterpart':'Compare the competing candidates and select the counterpart using props, variants, states and semantic purpose.',
  'Candidate proposed':'Review the proposed counterpart and its capability differences, then approve or select another target.',
  'Evidence needed':'Inspect the implementation or documentation for the missing capability evidence before estimating changes.',
  'Validation pending':'Validate keyboard interaction, runtime states and accessibility behavior; the counterpart is already confirmed.',
  'Confirmed counterpart':'Use the confirmed counterpart and inspect the observed item-level changes.'};
 for(const row of resolution.rows){const source=groups.get(row.sourceId),target=groups.get(row.targetId),caps=row.confirmedCapabilities||row.candidates?.[0]?.capabilities;
  const computed=source?.computed||target?.computed||caps?.computed||row.reasons?.includes('Computed value unresolved');
  const ambiguous=row.status!=='Confirmed'&&(row.reasons?.some(reason=>/Multiple/.test(reason))||row.candidates?.length>1);
  const runtime=row.status==='Confirmed'&&source?.kind==='component';
  row.resolutionStatus=row.presenceStatus|| (computed?'Computed value unresolved':ambiguous?'Ambiguous counterpart':row.status==='Suggested'?'Candidate proposed':runtime?'Validation pending':row.status==='Confirmed'?'Confirmed counterpart':'Evidence needed');
  row.nextAction=actions[row.resolutionStatus];row.resolutionIssues=[...(row.reasons||[])];row.classificationBasis='Deterministic evidence triage; queue assignment does not verify equivalence or prove removal.';
  for(const id of source?.itemIds||[])bySource.set(id,row);if(!source)for(const id of target?.itemIds||[])byTarget.set(id,row);
 }
 const counts=Object.fromEntries(RESOLUTION_QUEUES.map(status=>[status,resolution.rows.filter(row=>row.resolutionStatus===status).length]));
 if(Object.values(counts).reduce((a,b)=>a+b,0)!==resolution.rows.length)throw Error('Resolution queue coverage mismatch');
 resolution.summary.resolutionQueues=counts;resolution.summary.classifiedGroups=resolution.rows.length;
 const itemCounts={};for(const item of report.items){const row=bySource.get(item.old?.id)||byTarget.get(item.new?.id);item.resolutionStatus=row?.resolutionStatus||item.presenceStatus||'Evidence needed';item.resolutionAction=row?.nextAction||actions[item.resolutionStatus];item.reviewStatus=item.status==='Unverified'?item.resolutionStatus:item.presenceStatus||item.status;itemCounts[item.reviewStatus]=(itemCounts[item.reviewStatus]||0)+1;}
 report.summary.reviewCounts=itemCounts;report.summary.classifiedUnverified=report.items.filter(item=>item.status==='Unverified').length;return report;
}
