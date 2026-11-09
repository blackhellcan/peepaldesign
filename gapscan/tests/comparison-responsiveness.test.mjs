import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {scanDocuments} from '../engine/extract.mjs';
import {compactReport,hydrateReport,hydrateReportAsync,compactFingerprint,comparisonFingerprint,hydrateFingerprint,restoreComparisonReferences} from '../engine/report-storage.mjs';
import {extractDocuments,createComparisonReport} from '../engine/extract.mjs';
import {filterInventory} from '../engine/relevance.mjs';
import {enrichExamples,profileStyles} from '../engine/insights.mjs';
import worker from '../worker/index.js';
const transportSource=()=>readFileSync(new URL('../web/comparison-transport.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'');

test('incremental hydration preserves all report data and yields to the browser',async()=>{
 const source=Array.from({length:160},(_,n)=>`.component-${n}{color:rgb(${n},0,0);padding:16px}`).join('\n');
 const report=scanDocuments([{url:'source',content:source}],[{url:'target',content:source}],'upgrade');
 report.extractions={old:report.inventories.old.items,new:report.inventories.new.items};delete report.inventories;
 const packed=JSON.stringify(compactReport(report));let yields=0;
 const restored=await hydrateReportAsync(JSON.parse(packed),async()=>{yields++});
 assert.ok(yields>5);
 assert.deepEqual(restored,hydrateReport(JSON.parse(packed)));
 assert.ok(restored.items.every(row=>!row.old||restored.extractions.old.includes(row.old)));
});

test('incremental hydration can be cancelled before completing a report',async()=>{
 const report={storageFormat:1,textPool:['a'.repeat(100)],extractions:{old:Array.from({length:2500},(_,id)=>({id,value:{gapscanText:0}})),new:[]},items:[]};
 await assert.rejects(hydrateReportAsync(report,async()=>{throw new DOMException('Cancelled','AbortError')}),{name:'AbortError'});
});

test('background transport reconstructs a large fragmented result and progress without losing data',async()=>{
 const messages=[],payload={items:Array.from({length:4000},(_,id)=>({id,name:'Button 🟢 '+id}))};
 const bytes=new TextEncoder().encode(JSON.stringify({type:'progress',message:'Comparing'})+'\n'+JSON.stringify({type:'result',report:payload})+'\n');
 const stream=new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=97)controller.enqueue(bytes.slice(i,i+97));controller.close()}});
 const context=vm.createContext({self:{postMessage:event=>messages.push(event)},AbortController,TextDecoder,Blob,Response,CompressionStream,comparisonFingerprint:value=>value,fetch:async(url,options)=>{assert.equal(options.headers['Content-Encoding'],'gzip');return new Response(stream)}});
 vm.runInContext(transportSource(),context);
 await context.self.onmessage({data:{type:'compare',payload:{old:{},new:{}}}});
 assert.equal(messages[0].message,'Comparing');
 assert.deepEqual(JSON.parse(JSON.stringify(messages[1].report)),payload);
 assert.equal(messages.length,2);
});

test('background transport returns a clear error for truncated responses',async()=>{
 const messages=[];const context=vm.createContext({self:{postMessage:event=>messages.push(event)},AbortController,TextDecoder,Blob,Response,CompressionStream,comparisonFingerprint:value=>value,fetch:async()=>new Response('{"type":"result","report":')});
 vm.runInContext(transportSource(),context);
 await context.self.onmessage({data:{type:'compare',payload:{old:{},new:{}}}});
 assert.equal(messages.at(-1).type,'error');
});

test('comparison projection retains verdicts, variants, token bindings and source evidence',()=>{
 const make=color=>{const filtered=filterInventory(extractDocuments([{url:'local.css',content:`:root{--brand:${color}}body{font-family:Arial}.btn{color:var(--brand)}.btn:hover{color:white}<button class="btn">Save</button>`}]),'local');enrichExamples(filtered.inventory);return filtered};
 const old=make('red'),target=make('blue');
 const expected=createComparisonReport(structuredClone(old),structuredClone(target),'upgrade');
 const projectedOld=hydrateFingerprint(comparisonFingerprint(compactFingerprint(structuredClone(old)))),projectedNew=hydrateFingerprint(comparisonFingerprint(compactFingerprint(structuredClone(target))));
 const actual=createComparisonReport(projectedOld,projectedNew,'upgrade');
 assert.deepEqual(actual.summary,expected.summary);
 assert.deepEqual(actual.taxonomy.counts,expected.taxonomy.counts);
 assert.deepEqual(actual.items.map(row=>({status:row.status,insight:row.insight})),expected.items.map(row=>({status:row.status,insight:row.insight})));
 for(let index=0;index<old.inventory.items.length;index++){assert.deepEqual(projectedOld.inventory.items[index].variants,old.inventory.items[index].variants);assert.deepEqual(projectedOld.inventory.items[index].evidence,old.inventory.items[index].evidence.map(({snippet,...entry})=>entry));assert.deepEqual(profileStyles(projectedOld.inventory.items[index]),profileStyles(old.inventory.items[index]))}
});

test('backend accepts compressed comparison snapshots and returns a complete report',async()=>{
 const filtered=filterInventory(extractDocuments([{url:'button.css',content:'.btn{color:red}<button class="btn">Save</button>'}]),'local');enrichExamples(filtered.inventory);
 const snapshots={old:structuredClone(filtered),new:structuredClone(filtered)};
 const fingerprint=comparisonFingerprint(compactFingerprint(filtered));
 const payload={scenario:'auto',old:{input:{},fingerprint},new:{input:{},fingerprint}};
 const compressed=await new Response(new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
 const response=await worker.fetch(new Request('https://example.com/api/compare',{method:'POST',headers:{'Content-Type':'application/json','Content-Encoding':'gzip'},body:compressed}),{},{});
 assert.equal(response.status,200);
 const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
 assert.ok(!events.some(event=>event.type==='error'));
 const result=hydrateReport(events.find(event=>event.type==='result').report);
 assert.equal(result.processingMode,'backend');assert.equal(result.summary.unchanged,result.summary.total);
 assert.equal(result.externalExtractions,true);
 await restoreComparisonReferences(result,snapshots);
 assert.deepEqual(result.extractions.old[0].evidence,snapshots.old.inventory.items[0].evidence);
 assert.equal(result.extractions.old[0].html,snapshots.old.inventory.items[0].html);
 assert.equal(result.extractions.old[0].css,snapshots.old.inventory.items[0].css);
 assert.deepEqual(result.extractions.old[0].variants,snapshots.old.inventory.items[0].variants);
 assert.ok(result.mappingResolution.groups.old.every(group=>group.records.every(record=>result.extractions.old.includes(record))));
 assert.ok(!result.externalExtractions);
});

test('a deferred brief is generated on demand from the complete captured item',async()=>{
 const item={id:'gap-0',name:'Button',kind:'component',category:'Actions',status:'Source only',old:{name:'Button',kind:'component',html:'<button>Save</button>',value:'Original button implementation',evidence:[{source:'button.html',line:1}]},new:null};
 const response=await worker.fetch(new Request('https://example.com/api/compare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deliverable:item})}),{},{});
 const {brief}=await response.json();assert.equal(brief.id,'deliverable-gap-0');assert.ok(brief.prompt.includes('Original button implementation'));assert.ok(brief.prompt.includes('button.html'));
});

test('progress heartbeats stop before the multi-chunk result event begins',async()=>{
 const interval=globalThis.setInterval,clear=globalThis.clearInterval;let heartbeat=null;
 globalThis.setInterval=callback=>{heartbeat=callback;return 123};globalThis.clearInterval=()=>{heartbeat=null};
 try{
  const fingerprint=compactFingerprint(filterInventory(extractDocuments([{url:'button.css',content:'.btn{color:red}'}]),'local'));
  const response=await worker.fetch(new Request('https://example.com/api/compare',{method:'POST',body:JSON.stringify({old:{fingerprint},new:{fingerprint}})}),{},{});
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='',sawResult=false;
  while(true){const part=await reader.read();if(part.done)break;const chunk=decoder.decode(part.value,{stream:true});if(chunk.includes('"type":"result"')){sawResult=true;assert.equal(heartbeat,null,'heartbeat must not interrupt the result JSON')}text+=chunk}
  assert.ok(sawResult);assert.ok(text.trim().split('\n').map(line=>JSON.parse(line)).some(event=>event.type==='result'));
 }finally{globalThis.setInterval=interval;globalThis.clearInterval=clear}
});
