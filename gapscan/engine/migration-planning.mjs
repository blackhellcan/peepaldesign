// Explainable assistance labels; no AI execution or time-saving claim is implied.
import {buildDeliverables} from './deliverables.mjs';
import {effortLabel,levelForHours} from './estimate.mjs';

export function migrationPlan(item){
 const unverified=item.estimateAvailable===false||item.status==='Unverified';
 const unchanged=item.status==='Unchanged';const hours=unverified?null:item.hours,level=unverified?null:item.effortLevel??levelForHours(hours);
 const differences=item.insight?.differences||[];const checks=item.insight?.validation||[];
 const behavior= differences.some(delta=>delta.type==='api'||delta.state&&delta.state!=='default'||/focus|keyboard|aria|contrast|event/i.test(delta.property||''));
 const ai=unverified?{label:'Evidence review first',canAssist:false,tasks:[],humanReview:['Identify and verify a counterpart before estimating implementation.']} :unchanged?{label:'No implementation change',canAssist:false,tasks:[],humanReview:checks}: {label:behavior?'AI can assist · human validation required':'AI can assist',canAssist:true,tasks:item.kind==='token'?['Draft token replacements and update references using the observed mappings.']:['Draft the observed code/style changes and consumer migration steps.','Generate validation cases for the listed differences.'],humanReview:[...new Set([...(behavior?['Verify keyboard interaction, accessibility and runtime behavior.']:['Review generated changes and confirm visual parity.']),...checks])]};
 return {hours,level,size:effortLabel(level),basis:'Heuristic engineering hours per application; editable, not a measured guarantee.',actions:item.insight?.actions||[item.action],ai};
}
export function applyMigrationPlanning(report,options={}){
 const labels={old:new Map(),new:new Map()};
 for(const category of report.categoryTree?.categories||[])for(const row of category.items)for(const side of ['old','new'])for(const id of row.systems[side].itemIds)if(!labels[side].has(id))labels[side].set(id,{category:category.name,name:row.name});
 for(const side of ['old','new'])for(const item of report.extractions?.[side]||[]){const label=labels[side].get(item.id);if(label){item.category=label.category;item.canonicalLabel=label.name}}
 for(const item of report.items){const label=labels.old.get(item.old?.id)||labels.new.get(item.new?.id);if(label){item.category=label.category;item.canonicalLabel=label.name}item.migration=migrationPlan(item)}
 report.deliverables=buildDeliverables(report,options);
 return report;
}
