import test from 'node:test';
import assert from 'node:assert/strict';
import {detectMigrationType} from '../engine/migration-detection.mjs';

test('detects a same-library version comparison from package identities',()=>{
  const result=detectMigrationType({old:{npmPackage:'bootstrap@5.3.2'},new:{npmPackage:'bootstrap@5.3.3'}},{scenario:'auto'});
  assert.equal(result.scenario,'upgrade');
  assert.equal(result.mode,'auto');
});

test('detects a cross-system comparison from recognized documentation URLs',()=>{
  const result=detectMigrationType({old:{url:'https://getbootstrap.com/docs/5.3/'},new:{url:'https://m3.material.io/'}},{scenario:'auto'});
  assert.equal(result.scenario,'switch');
  assert.match(result.label,/Cross-system/);
});

test('keeps ambiguous inputs explicit instead of guessing a migration type',()=>{
  const result=detectMigrationType({old:{url:'https://example.com/a'},new:{code:'.button{color:red}'}},{scenario:'auto'});
  assert.equal(result.scenario,'unknown');
  assert.equal(result.mode,'auto');
});

test('preserves an explicit project mode for backwards compatibility',()=>{
  const result=detectMigrationType({old:{},new:{}},{scenario:'switch'});
  assert.equal(result.scenario,'switch');
  assert.equal(result.mode,'explicit');
});
