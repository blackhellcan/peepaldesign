import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePackage,discoverPackages,selectPackageFiles,collectPackage} from '../engine/packages.mjs';
import {resolveInput} from '../engine/website.mjs';
import {extractDocuments} from '../engine/extract.mjs';
const reply=(body,type='application/json')=>new Response(typeof body==='string'?body:JSON.stringify(body),{headers:{'content-type':type}});
function fixture(failFile=false){return async url=>{
  if(url.startsWith('https://registry.npmjs.org/'))return reply({name:'@fixture/ui',version:'1.2.3',homepage:'https://example.com/components/',dependencies:{'@fixture/tokens':'1.0.0'}});
  if(url.includes('/flat'))return reply({files:[{name:'/dist/ui.css',size:100},{name:'/tokens/colors.json',size:100},{name:'/Button.d.ts',size:100},{name:'/package.json',size:100}]});
  if(url.endsWith('.css'))return failFile?new Response('missing',{status:404}):reply(':root{--brand:#123456}.btn{color:var(--brand)}','text/css');
  if(url.endsWith('colors.json'))return reply({color:{$type:'color',$value:'#123456'}});
  if(url.endsWith('Button.d.ts'))return reply('export declare class Button {} export interface ButtonProps { disabled?: boolean }','text/plain');
  return new Response('blocked',{status:403});
}}
test('parses scoped packages, exact versions, tags and npm links; rejects command injection/private URLs',()=>{
  assert.deepEqual(parsePackage('@material/web@2.5.0'),{name:'@material/web',requested:'2.5.0',spec:'@material/web@2.5.0'});
  assert.equal(parsePackage('https://www.npmjs.com/package/@material/web/v/2.5.0').requested,'2.5.0');
  assert.equal(parsePackage('bootstrap').requested,'latest');
  for(const value of ['npm install bootstrap','x; curl evil','https://localhost/p','@scope','pkg@../../../secret','pkg@^1.0.0'])assert.throws(()=>parsePackage(value));
});
test('discovers packages from actual installation/import/dependency evidence without treating prose as package names',()=>{
  assert.deepEqual(discoverPackages('<code>npm install @material/web</code><p>Then add your component.</p>'),['@material/web']);
  assert.ok(discoverPackages('import {Button} from "@fixture/ui/button";').includes('@fixture/ui'));
  assert.ok(discoverPackages('{"dependencies":{"@carbon/react":"1.2.3","react":"18"}}').includes('@carbon/react'));
});
test('package sampling balances CSS, tokens, typography, icons and component definitions and excludes duplicate/support files',()=>{
  const files=['/dist/theme.css','/dist/theme.min.css','/tokens/colors.json','/typography/font.json','/icons/save.svg','/Button.d.ts','/labs/button.ts','/test/button.test.js','/package.json','/button.cssresult.d.ts'].map(name=>({name,size:100}));
  const plan=selectPackageFiles(files,8);assert.ok(plan.selected.some(f=>f.name==='/icons/save.svg'));assert.ok(plan.selected.some(f=>f.name==='/Button.d.ts'));assert.ok(plan.selected.every(f=>!(/min.css|labs|test|package.json|cssresult.d.ts/.test(f.name))));
});
test('reads exact version artifacts and extracts actual tokens and API definitions without executing packages',async()=>{
  const result=await collectPackage('@fixture/ui@1.2.3','Target',12,fixture());
  assert.equal(result.record.version,'1.2.3');assert.equal(result.documents.length,3);assert.ok(result.documents.every(d=>d.url.includes('@fixture/ui@1.2.3/')));assert.equal(result.record.filesPending,0);
  const items=extractDocuments(result.documents).items;assert.ok(items.some(i=>i.name==='--brand'));assert.ok(items.some(i=>i.name==='ButtonProps'));
});
test('package-only inputs and npm links use published files rather than npm website HTML',async()=>{
  for(const input of [{npmPackage:'@fixture/ui@1.2.3'},{url:'https://www.npmjs.com/package/@fixture/ui/v/1.2.3'}]){const result=await resolveInput(input,'Target',12,fixture());assert.equal(result.packages[0].version,'1.2.3');assert.equal(result.coverage.failed.length,0);}
});
test('unavailable optional package files remain audit issues while readable artifacts survive',async()=>{
  const result=await resolveInput({npmPackage:'@fixture/ui@1.2.3'},'Target',12,fixture(true));assert.equal(result.documents.length,2);assert.ok(result.coverage.failed.some(f=>f.url.endsWith('/dist/ui.css')));
});
test('bad CDN file integrity is excluded rather than counted as successful evidence',async()=>{
  const fetcher=async url=>url.includes('/flat')?reply({files:[{name:'/dist/ui.css',size:10,hash:'bad-hash'}]}):fixture()(url);
  const result=await collectPackage('@fixture/ui@1.2.3','Target',1,fetcher);assert.equal(result.documents.length,0);assert.match(result.coverage.failed[0].error,/integrity mismatch/);
});
test('transient document failures retry once and a second pinned CDN can recover a package file',async()=>{
  let calls=0;const fetcher=async url=>{if(url.includes('cdn.jsdelivr.net')&&url.endsWith('.css')){calls++;return new Response('outage',{status:503})}return fixture()(url)};
  const result=await collectPackage('@fixture/ui@1.2.3','Target',12,fetcher);assert.equal(calls,2);assert.equal(result.documents.length,3);assert.ok(result.documents.some(d=>d.url.startsWith('https://unpkg.com/')));
});
