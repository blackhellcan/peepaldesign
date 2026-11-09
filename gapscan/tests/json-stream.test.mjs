import test from 'node:test';import assert from 'node:assert/strict';
import {jsonChunks} from '../engine/json-stream.mjs';
test('report streaming preserves JSON values with bounded UTF-8 chunks',()=>{
 const value={unicode:'🟢'.repeat(100),text:'x'.repeat(10000),missing:undefined,items:[null,undefined,NaN,3,{quote:'"\n\\'}]};
 const chunks=[...jsonChunks(value,31)];assert.ok(chunks.every(chunk=>chunk.length<=31));
 const encoded=chunks.map(chunk=>new TextEncoder().encode(chunk));const bytes=new Uint8Array(encoded.reduce((n,b)=>n+b.length,0));let offset=0;for(const chunk of encoded){bytes.set(chunk,offset);offset+=chunk.length}
 assert.equal(new TextDecoder().decode(bytes),JSON.stringify(value));
});
