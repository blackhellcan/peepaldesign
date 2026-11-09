import test from 'node:test';
import assert from 'node:assert/strict';
import {trainingDocuments,validateTrainingFiles,applyTrainingCategories,TRAINING_CATEGORIES} from '../engine/local-training.mjs';
import {extractDocuments,createComparisonReport} from '../engine/extract.mjs';
import {filterInventory} from '../engine/relevance.mjs';
import {enrichExamples,attachDocumentationLinks} from '../engine/insights.mjs';
import {applyComparisonCoverage,extractionAudit} from '../engine/foundations.mjs';
test('category entries preserve source files, notes, independent names and documentation links',()=>{
 const profile={name:'Acme',files:[{name:'button.html',category:'Actions',content:'<button class="acme-control">Save</button>',notes:'Loading state pending',documentationUrl:'https://example.com/components/button#states'},{name:'colors.json',category:'Colors',content:'{"brand":"#0B5FFF"}'}]};
 assert.ok(validateTrainingFiles(profile.files)>0);const docs=trainingDocuments(profile);const filtered=filterInventory(applyTrainingCategories(extractDocuments(docs),docs),'local');attachDocumentationLinks(enrichExamples(filtered.inventory),docs);
 const button=filtered.inventory.items.find(i=>i.name==='acme-control');assert.equal(button.category,'Actions');assert.deepEqual(button.trainingCategories,['Actions']);assert.ok(button.trainingNotes.includes('Loading state pending'));assert.equal(button.documentationUrl,'https://example.com/components/button#states');assert.ok(!filtered.inventory.items.some(i=>/Loading/.test(i.name)));
 const color=filtered.inventory.items.find(i=>i.name==='brand');assert.equal(color.examples.value,'#0B5FFF');assert.equal(color.category,'Foundations and tokens');
});
test('training permits partial category coverage and preserves unknown families without manufacturing examples',()=>{
 const docs=trainingDocuments({name:'Tokens only',files:[{name:'tokens.json',category:'Design tokens',content:'{"spacing":4}'}]});const inv=filterInventory(applyTrainingCategories(extractDocuments(docs),docs),'local');const r=createComparisonReport(structuredClone(inv),structuredClone(inv),'upgrade');applyComparisonCoverage(r,{old:extractionAudit(inv.inventory),new:extractionAudit(inv.inventory)});assert.equal(r.comparisonReady,true);assert.ok(r.extractionAudit.old.missingFamilies.includes('Components'));assert.equal(r.items.length,1);assert.equal(r.items[0].old.html,'');
});
test('invalid categories, empty details, oversized files and unsafe section links are rejected or sanitized',()=>{
 assert.throws(()=>validateTrainingFiles([]));assert.throws(()=>validateTrainingFiles([{name:'a',category:'bogus',content:'x'}]));assert.throws(()=>validateTrainingFiles([{name:'a',category:'Colors',content:''}]));assert.throws(()=>validateTrainingFiles([{name:'a',category:'Colors',content:'x'.repeat(10000001)}]),/10 MB/);
 const docs=trainingDocuments({name:'Acme',files:[{name:'a',category:'Actions',content:'.btn{color:red}',documentationUrl:'javascript:alert(1)'}]});assert.equal(docs[0].documentationUrl,null);assert.ok(TRAINING_CATEGORIES.includes('Icons'));
});
test('serialized fingerprints reuse the same normalized variants, theme values and category evidence',()=>{
 const docs=trainingDocuments({name:'Acme',files:[{name:'a',category:'Actions',content:':root{--brand:red}[data-theme="dark"]{--brand:blue}<button class="btn">Save</button><button class="btn" disabled>Save</button>'}]});const filtered=filterInventory(applyTrainingCategories(extractDocuments(docs),docs),'local');enrichExamples(filtered.inventory);const cached=JSON.parse(JSON.stringify({inventory:filtered.inventory,audit:filtered.audit,collection:filtered.collection}));assert.deepEqual(cached.inventory.items.find(i=>i.name==='btn').variants,filtered.inventory.items.find(i=>i.name==='btn').variants);assert.deepEqual(cached.inventory.items.find(i=>i.name==='--brand').values,['red','blue']);assert.equal(createComparisonReport(cached,structuredClone(cached),'upgrade').summary.changed,0);
});
