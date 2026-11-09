// The only place GapScan turns observed differences into effort levels, hour
// ranges and planning totals. Every view, export and test reads these rules from
// here so the overview, calculator and saved reports cannot disagree. The numbers
// are editable planning heuristics, not measured delivery guarantees.
export const RUBRIC=Object.freeze({
 base:Object.freeze({1:[0.5,1.5],2:[2,4],3:[6,12],4:[16,32],5:[40,80]}),
 labels:Object.freeze({1:'Trivial',2:'Easy',3:'Moderate',4:'Hard',5:'Very hard'}),
 bands:Object.freeze([[1,1],[3,2],[6,3],[10,4]]),
 legacyRangeRatio:1.5,
 productiveHours:35,
 defaults:Object.freeze({rate:75,apps:1,team:2,buffer:20})
});
export const NOT_ESTIMATED='Not estimated';
const halfHourUp=value=>Math.ceil(value*2)/2;
const FOCUS_STATE=/focus/i;
// Each driver adds points; the level is the larger of the points band and the
// floor of the most severe driver, so one rebuild is never averaged away.
export function effortDrivers(item,scenario){
 const o=item.old,n=item.new,drivers=[],add=(driver,points,floor)=>drivers.push({driver,points,floor});
 if(!o||!n||item.status==='Unchanged')return drivers;
 const differences=item.insight?.differences||[],types=new Set(differences.map(d=>d.type));
 if(item.status==='Renamed')add('Identifier renamed',1,1);
 if(types.has('token')||types.has('token-binding'))add('Token value or binding change',1,1);
 const styles=differences.filter(d=>d.type==='style'),states=new Set(styles.map(d=>d.state||'default'));
 if(states.has('default'))add('Visual style change',1,1);
 if([...states].some(state=>FOCUS_STATE.test(state)))add('Focus or accessibility change',2,2);
 const otherStates=[...states].filter(state=>state!=='default'&&!FOCUS_STATE.test(state));
 if(otherStates.length)add('State styling change ('+otherStates.join(', ')+')',Math.min(3,otherStates.length),2);
 if(types.has('api'))add('API signature change',4,3);
 if(types.has('markup'))add('Markup or anatomy change',4,4);
 if(!drivers.length)add(item.kind==='token'?'Token value change':'Observed definition change',item.kind==='token'?1:2,item.kind==='token'?1:2);
 if(scenario==='switch')add('Framework switch: imports and call sites change',2,2);
 return drivers;
}
export function effortLevel(drivers){
 const points=drivers.reduce((sum,d)=>sum+d.points,0),floor=Math.max(1,...drivers.map(d=>d.floor));
 const band=RUBRIC.bands.find(([max])=>points<=max)?.[1]||5;
 return Math.max(band,floor);
}
export function levelForHours(hours){
 if(!Number.isFinite(hours)||hours<=0)return null;
 return Number(Object.entries(RUBRIC.base).find(([,range])=>hours<=range[1])?.[0]||5);
}
export function effortLabel(level){return level?`Level ${level} · ${RUBRIC.labels[level]}`:NOT_ESTIMATED}
// A manual edit replaces the low baseline; the high end keeps that level's spread.
// Reports saved before levels existed keep their original 50% planning range.
export function effortRange(hours,level){
 if(!Number.isFinite(hours))return null;
 const range=RUBRIC.base[level],ratio=range?range[1]/range[0]:RUBRIC.legacyRangeRatio;
 return {low:hours,high:halfHourUp(hours*ratio)};
}
// Missing counterparts, foundation evidence and stored-only facts get no hours:
// absence from captured evidence is not proof of work to create.
export function estimateRecord(item,scenario){
 const o=item.old,n=item.new;
 if(item.kind==='foundation'||o?.registryOnly||n?.registryOnly)return {effortLevel:null,hours:0,hoursHigh:null,tier:NOT_ESTIMATED,effortDrivers:[],estimateAvailable:false};
 if(!n)return {effortLevel:null,hours:0,hoursHigh:null,tier:NOT_ESTIMATED,effortDrivers:[{driver:'No counterpart found in captured target evidence',points:0,floor:0}],estimateAvailable:false};
 if(!o){const [low,high]=RUBRIC.base[2];return {effortLevel:2,hours:low,hoursHigh:high,tier:effortLabel(2),effortDrivers:[{driver:'Optional target adoption',points:2,floor:2}],estimateAvailable:true,optional:true}}
 const drivers=effortDrivers(item,scenario),level=item.status==='Unchanged'?1:effortLevel(drivers),[low,high]=RUBRIC.base[level];
 if(item.status==='Unchanged')drivers.push({driver:'Verification of unchanged definition',points:0,floor:1});
 return {effortLevel:level,hours:low,hoursHigh:high,tier:effortLabel(level),effortDrivers:drivers,estimateAvailable:true};
}
// Planning totals over the grouped migration brief. Groups contribute their
// largest non-excluded record so related selectors are not summed as components.
export function migrationBriefTotals(brief,{rate=RUBRIC.defaults.rate,apps=RUBRIC.defaults.apps,team=RUBRIC.defaults.team,buffer=RUBRIC.defaults.buffer,usage={},excluded=[],edited={}}={}){
 const excludedIds=new Set(excluded),manual=brief.items.some(item=>!item.optional&&usage[item.id]==='used');
 const inScope=brief.items.filter(item=>!item.optional&&(!manual||usage[item.id]==='used')&&usage[item.id]!=='unused');
 const estimated=inScope.filter(item=>item.estimate&&(item.estimateRecords?.length?item.estimateRecords.some(record=>!excludedIds.has(record.id)):!item.rowIds.every(id=>excludedIds.has(id))));
 const groupRange=item=>{
  if(!item.estimateRecords?.length)return {low:item.estimate.low,high:item.estimate.high};
  const ranges=item.estimateRecords.filter(record=>!excludedIds.has(record.id)).map(record=>effortRange(Number.isFinite(edited[record.id])?edited[record.id]:record.hours,record.level));
  return {low:Math.max(0,...ranges.map(r=>r.low)),high:Math.max(0,...ranges.map(r=>r.high))};
 };
 const ranges=estimated.map(groupRange),low=ranges.reduce((sum,r)=>sum+r.low,0)*apps,high=ranges.reduce((sum,r)=>sum+r.high,0)*apps;
 const multiplier=1+buffer/100,round=value=>Math.round(value*100)/100,weekly=Math.max(1,team)*RUBRIC.productiveHours;
 return {available:estimated.length>0,scope:manual?'Known changes marked as used':'Known library changes, if used',estimatedGroups:estimated.length,unestimatedGroups:inScope.filter(item=>!item.estimate&&item.decision!=='Keep').length,usedGroups:Object.values(usage).filter(value=>value==='used').length,uncheckedGroups:brief.items.filter(item=>!item.optional&&!usage[item.id]).length,hours:{low:round(low*multiplier),high:round(high*multiplier)},budget:{low:round(low*multiplier*rate),high:round(high*multiplier*rate)},weeks:{low:low*multiplier/weekly,high:high*multiplier/weekly},assumptions:{rate,apps,team,buffer,productiveHours:RUBRIC.productiveHours},partial:true};
}
