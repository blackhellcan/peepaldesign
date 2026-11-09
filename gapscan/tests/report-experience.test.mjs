import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
function node(){return {children:[],value:'',dataset:{},append(...children){this.children.push(...children)},replaceChildren(...children){this.children=children},querySelector(){return null},setAttribute(){},addEventListener(){}}}
test('source and target gallery renderers are callable and independently populate captured examples',()=>{
 const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id)};
 const item=(id,name)=>({id,name,kind:'component',category:'Actions',html:'<button>'+name+'</button>',evidence:[],variants:[]});
 const report={extractions:{old:[item('old','Source button')],new:[item('new','Target button')]},coverage:{old:{fetched:1},new:{fetched:1}},relevance:{old:{excludedItems:0},new:{excludedItems:0}},domains:['Actions']};
 for(const side of ['source','target']){get(side+'-extraction-kind').value='All';get(side+'-extraction-category').value='All';get(side+'-extraction-display').value='visual'}
 const context=vm.createContext({report,$:get,document:{createElement:node},renderCategoryTree(){},renderWebsitePlaceholders(){},primaryExample:item=>!!item.html,makePreview:item=>({...node(),specimen:item.name}),extractionLimits:{source:36,target:36}});
 const start=app.indexOf('function renderExtraction(side)'),end=app.indexOf('\nfunction filtered()',start);
 // Include any preceding unary operator: "+function" creates a private
 // expression name, and was the reason both navigation tabs appeared empty.
 vm.runInContext(app.slice(start-1,end),context);
 assert.equal(vm.runInContext('typeof renderExtraction',context),'function');
 vm.runInContext("renderExtraction('source');renderExtraction('target')",context);
 for(const [side,label]of [['source','Source button'],['target','Target button']]){const cards=get(side+'-extraction-grid').children.filter(child=>child.className==='panel extraction-card');assert.equal(cards.length,1);assert.ok(cards[0].children.some(child=>child.specimen===label));assert.match(get(side+'-extraction-meta').textContent,/1 captured items/)}
});
test('plain-language component summaries explain differences without printing code or claiming removal',()=>{
 const code=readFileSync(new URL('../web/report-experience.js',import.meta.url),'utf8');const context=vm.createContext({URL});vm.runInContext(code.slice(0,code.indexOf('const originalSinglePreview')),context);
 const summarize=item=>context.friendlyChangeSummary(item);
 assert.match(summarize({old:{},new:{},status:'Changed',insight:{differences:[{type:'style',property:'border-radius'},{type:'style',property:'font-size'}]}}),/Corners, text size differ/);
 assert.match(summarize({old:{},new:null}),/before replacing/);
 assert.doesNotMatch(summarize({old:{},new:null}),/was removed/i);
 assert.equal(context.documentationLink({documentationUrl:'https://example.com/components/button#usage'}),'https://example.com/components/button#usage');
 assert.equal(context.documentationLink({documentationUrl:'https://example.com/assets/button.css'}),null);
 assert.equal(context.documentationLink({documentationUrl:'javascript:alert(1)'}),null);
});
test('overview counts distinguish paired items, observed changes and missing counterparts',()=>{
 const code=readFileSync(new URL('../web/report-experience.js',import.meta.url),'utf8');const start=code.indexOf('function reportOverviewFacts'),end=code.indexOf('\nfunction renderFriendlyOverview',start);const context=vm.createContext({});vm.runInContext(code.slice(start,end),context);
 const result=context.reportOverviewFacts({items:[{old:{},new:{},status:'Changed'},{old:{},new:{},status:'Unchanged'},{old:{},new:null},{old:null,new:{}}]});assert.deepEqual(JSON.parse(JSON.stringify(result)),{paired:2,changes:1,unmatched:2});
});
