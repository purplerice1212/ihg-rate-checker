import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSnapshot,collectSearch} from './browser_adapter.mjs';
test('extract synthetic points without certifying price',()=>{
  const r=parseSnapshot('Twin room\n90,000 points total stay\nRefundable');
  assert.equal(r.status,'UNKNOWN');assert.equal(r.candidates[0].points,90000);assert.equal(r.candidates[0].scope,'TOTAL_CANDIDATE');
});
test('nightly is not a total',()=>assert.equal(parseSnapshot('30,000 points per night').candidates[0].scope,'NIGHTLY'));
test('blocks stay blocked',()=>assert.equal(parseSnapshot('Verify you are human CAPTCHA').status,'BLOCKED'));
test('errors are not unavailable',()=>assert.equal(parseSnapshot('404 Page not found').status,'UNKNOWN'));
test('collection drives browser and returns structured private observation',async()=>{
  let visited;
  const tab={goto:async u=>{visited=u},url:async()=>visited,playwright:{domSnapshot:async()=> '90,000 points total stay'}};
  const result=await collectSearch(tab,{adapter_status:'BROWSER_REQUIRED',request:{hotel:'ABCDE'},search_url:'https://www.ihg.com/example'}, {clock:()=> '2030-01-01T00:00:00Z'});
  assert.equal(visited,'https://www.ihg.com/example');assert.equal(result.candidates[0].points,90000);assert.equal(result.requires_verification,true);
});
test('reject nonofficial source before navigation',async()=>{
  await assert.rejects(()=>collectSearch({}, {adapter_status:'BROWSER_REQUIRED',request:{},search_url:'https://other.example'}));
});
