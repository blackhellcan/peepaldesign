import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {brotliDecompressSync} from 'node:zlib';
import worker from '../worker/index.js';
import {extractDocuments} from '../engine/extract.mjs';
import {filterInventory} from '../engine/relevance.mjs';
import {enrichExamples} from '../engine/insights.mjs';
import {buildCategoryTree} from '../engine/category-tree.mjs';
test('standalone SVG filenames preserve distinct icons despite identical root IDs',()=>{
 const inventory=filterInventory(extractDocuments(['check','close'].map(name=>({url:'https://example.com/icons/'+name+'.svg',label:name+'.svg',content:'<svg xmlns="http://www.w3.org/2000/svg" id="icon" class="icon"><path d="M2 2h20"/></svg>'})))).inventory;
 assert.deepEqual(inventory.items.map(item=>item.name).sort(),['Icon check','Icon close']);assert.ok(inventory.items.every(item=>item.html.includes('<path')));
});
test('sprite symbol geometry is not duplicated as unnamed nested SVG records',()=>{
 const inventory=filterInventory(extractDocuments([{url:'https://example.com/sprite.svg',content:'<svg><symbol id="check" class="bi bi-check"><svg><path d="M2 2h20"/></svg></symbol></svg>'}])).inventory;
 assert.equal(inventory.items.length,1);assert.equal(inventory.items[0].name,'Icon check');
});
test('typed literal token maps and declared component states retain evidence without executing code',()=>{
 const docs=[{url:'https://example.com/tokens/brand.ts',content:"export const brand: Record<string,string>={brand600:'#0b5fff'};globalThis.noExecution=true;"},{url:'https://example.com/Button.types.ts',content:"export interface ButtonProps { appearance?: 'primary' | 'secondary'; size?: 'small' | 'large'; loading?: boolean; disabled?: boolean; }"}];
 const inventory=enrichExamples(filterInventory(extractDocuments(docs)).inventory);assert.ok(inventory.items.some(item=>item.name==='brand.brand600'&&item.examples.value==='#0b5fff'));assert.equal(globalThis.noExecution,undefined);
 const tree=buildCategoryTree({old:inventory.items,new:[]},[]),button=tree.categories.find(category=>category.name==='Actions').items.find(item=>item.name==='Button').systems.old;
 assert.ok(button.variations.some(value=>value.name==='primary'));assert.ok(button.sizes.some(value=>value.name==='small'));assert.ok(button.states.some(value=>value.name==='loading'));assert.ok(!button.states.some(value=>value.name==='checked'));
});
test('expanded reference assets serve valid compressed source snapshots with revision and ledger',async()=>{
 const index=await (await worker.fetch(new Request('https://example.com/references/index.json'))).json();assert.equal(index.length,11);
 const reference=index.find(item=>item.id==='reference-material-web');const response=await worker.fetch(new Request('https://example.com'+reference.asset));assert.equal(response.headers.get('Content-Encoding'),'br');
 const profile=JSON.parse(brotliDecompressSync(Buffer.from(await response.arrayBuffer())));assert.equal(profile.referenceRevision,reference.referenceRevision);assert.equal(profile.files.length,reference.files);assert.equal(profile.sourceLedger.length,profile.files.length);assert.ok(profile.itemCounts.tokens>2000);assert.deepEqual(profile.pendingSources,[]);
 const report=JSON.parse(await readFile(new URL('../references/retraining-report.json',import.meta.url)));assert.equal(report.systems.length,11);assert.ok(report.systems.every(system=>system.archiveSha256.length===64));
});

test('HTML font URLs do not become CSS component selectors',()=>{
 const inventory=filterInventory(extractDocuments([{url:'https://example.com/index.html',type:'text/html',content:'<link href="https://fonts.googleapis.com/css?family=Roboto"><style>/* comment */ .button{color:red}</style><button class="button">Save</button>'}])).inventory;
 assert.ok(inventory.items.some(item=>item.name==='button'&&item.css.includes('color:red')));assert.ok(!inventory.items.some(item=>['googleapis','com'].includes(item.name)));
});

test('font codepoint maps are retained as tooling evidence rather than fake design tokens',()=>{
 const data=Object.fromEntries(Array.from({length:12},(_,n)=>['icon-'+n,0xf000+n]));const inventory=filterInventory(extractDocuments([{url:'Local/font/icons.json',label:'icons.json',content:JSON.stringify(data)}])).inventory;assert.equal(inventory.items.length,1);assert.equal(inventory.items[0].kind,'api');
});
