import test from 'node:test';import assert from 'node:assert/strict';import {extractDocuments} from '../engine/extract.mjs';import {filterInventory} from '../engine/relevance.mjs';
test('upgrade instructions beside embedded styles do not become imaginary CSS components',()=>{
 const content='<h1>Upgrade from v1 to v2</h1><ul><li>Replace corners with 8px.</li><li>Install the package.</li><li>Verify keyboard focus.</li></ul><style>:root{--brand:#794dff}.btn{color:white;background:var(--brand)}</style><button class="btn">Save</button>';
 const inventory=filterInventory(extractDocuments([{url:'Target pasted code',type:'text/plain',content}]),'target').inventory;
 assert.ok(inventory.items.some(item=>item.name==='btn'));assert.ok(inventory.items.some(item=>item.name==='--brand'));assert.ok(!inventory.items.some(item=>['Install','Verify','Replace'].includes(item.name)));
});
