// Synthetic storage only; no network, browser account, wallet or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { KeyValueStorage } from '@walletconnect/keyvaluestorage';

function load(crypto) {
  const source=fs.readFileSync('src/lib/walletconnect-scoped-storage.ts','utf8');
  const mod={exports:{}};
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{module:mod,exports:mod.exports,crypto,Uint8Array});
  return mod.exports;
}
class MemoryStorage {
  constructor(){this.data=new Map();}
  async getKeys(){return [...this.data.keys()];}
  async getEntries(){return [...this.data.entries()];}
  async getItem(key){return this.data.get(key);}
  async setItem(key,value){this.data.set(key,value);}
  async removeItem(key){this.data.delete(key);}
}
const checks=[];
async function check(name,fn){await fn();checks.push(name);}
const api=load({getRandomValues(bytes){for(let i=0;i<bytes.length;i++)bytes[i]=i;return bytes;}});
const {scopeWalletConnectStorage:scope,createWalletConnectStorageScope:randomScope}=api;
await check('scope generation uses sixteen cryptographic bytes and fails closed without a source',async()=>{
  assert.equal(randomScope(),'000102030405060708090a0b0c0d0e0f');
  assert.throws(()=>load(undefined).createWalletConnectStorageScope(),/Secure random generation is unavailable/);
  assert.throws(()=>load({getRandomValues(){throw new Error('synthetic entropy failure');}}).createWalletConnectStorageScope(),/synthetic entropy failure/);
});
await check('invalid scope IDs cannot overlap or inject another prefix',async()=>{
  for(const id of ['', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'a'.repeat(31)+':', '../'+ 'b'.repeat(32)]) {
    assert.throws(()=>scope(new MemoryStorage(),id),/Invalid WalletConnect storage scope/);
  }
});
const backend=new MemoryStorage(), first=scope(backend,'a'.repeat(32)), second=scope(backend,'b'.repeat(32));
await check('shared logical names remain independent across scoped views',async()=>{
  await Promise.all([first.setItem('session',{owner:'first'}),second.setItem('session',{owner:'second'})]);
  assert.equal((await first.getItem('session')).owner,'first');
  assert.equal((await second.getItem('session')).owner,'second');
  assert.equal(await first.getItem('absent'),undefined);
  await assert.rejects(()=>first.getItem(undefined),/Invalid WalletConnect storage key/);
});
await check('enumeration exposes only local logical keys and values',async()=>{
  await first.setItem('provider:state','first-state');
  await second.setItem('other','second-state');
  await backend.setItem('unrelated','do-not-enumerate');
  assert.deepEqual(Array.from(await first.getKeys()).sort(),['provider:state','session']);
  assert.deepEqual(Array.from(await second.getKeys()).sort(),['other','session']);
  assert.deepEqual(Array.from(await first.getEntries(),([key,value])=>[key,typeof value==='object'?value.owner:value]).sort(),[['provider:state','first-state'],['session','first']]);
});
await check('entry enumeration reads values only for its own keys',async()=>{
  class AuditedStorage extends MemoryStorage {
    reads=[];
    async getEntries(){throw new Error('must not read all scopes');}
    async getItem(key){this.reads.push(key);return super.getItem(key);}
  }
  const store=new AuditedStorage(),a=scope(store,'6'.repeat(32)),b=scope(store,'7'.repeat(32));
  await a.setItem('own','visible');await b.setItem('other','private');
  assert.deepEqual(Array.from(await a.getEntries(),([key,value])=>[key,value]),[['own','visible']]);
  assert.equal(store.reads.length,1);
  assert(store.reads.every(key=>key.includes('6'.repeat(32))&&!key.includes('7'.repeat(32))));
});
await check('attempt cleanup and a forged foreign-prefix key cannot remove another scope',async()=>{
  const foreignPhysicalKey=(await backend.getKeys()).find(key=>key.includes('b'.repeat(32)));
  assert(foreignPhysicalKey);
  await first.removeItem(foreignPhysicalKey);
  await first.close();
  assert.equal(first.closed,true);
  assert.deepEqual(Array.from(await first.getKeys()),[]);
  assert.deepEqual(Array.from(await first.getEntries()),[]);
  assert.equal(await first.getItem('session'),undefined);
  await first.setItem('after-close','must-not-persist');
  await first.removeItem(foreignPhysicalKey);
  assert.equal((await second.getItem('session')).owner,'second');
  assert.equal(await second.getItem('other'),'second-state');
  assert.equal(await backend.getItem('unrelated'),'do-not-enumerate');
});
await check('real WalletConnect in-memory backend preserves distinct logical keys through normalization',async()=>{
  const actualBackend=new KeyValueStorage({database:':memory:'});
  const a=scope(actualBackend,'d'.repeat(32)),b=scope(actualBackend,'e'.repeat(32));
  const names=['','a/b','a:b','a\\b','a?b','a','中文','😀','\ud800','\udc00','imtoken-fans:walletconnect-attempt:v1:'+ 'e'.repeat(32)+':k'];
  for(let i=0;i<names.length;i++)await a.setItem(names[i],i);
  await b.setItem('a/b','other');
  assert.deepEqual(Array.from(await a.getKeys()).sort(),names.slice().sort());
  const entries=Array.from(await a.getEntries(),([key,value])=>[key,value]);
  for(let i=0;i<names.length;i++) {
    assert.equal(await a.getItem(names[i]),i);
    assert(entries.some(([key,value])=>key===names[i]&&value===i));
  }
  await a.close();
  assert.equal(await b.getItem('a/b'),'other');
  await b.close();
});
await check('malformed physical keys fail closed and close removes only their scope',async()=>{
  const store=new MemoryStorage(),a=scope(store,'f'.repeat(32)),b=scope(store,'0'.repeat(32));
  await a.setItem('valid',1);await b.setItem('keep',2);
  const physical=(await store.getKeys()).find(key=>key.includes('f'.repeat(32)));
  await store.setItem(physical+'z','malformed');
  await assert.rejects(()=>a.getKeys(),/Invalid encoded WalletConnect storage key/);
  await assert.rejects(()=>a.getEntries(),/Invalid encoded WalletConnect storage key/);
  await a.close();
  assert.equal(await b.getItem('keep'),2);
});
await check('close waits for in-flight writes and prevents late writes',async()=>{
  let release,started;
  const gate=new Promise(resolve=>{release=resolve;});
  const ready=new Promise(resolve=>{started=resolve;});
  class DeferredStorage extends MemoryStorage {
    async setItem(key,value){if(value==='pending'){started();await gate;}return super.setItem(key,value);}
  }
  const store=new DeferredStorage(),a=scope(store,'1'.repeat(32)),b=scope(store,'2'.repeat(32));
  await b.setItem('keep','other');
  const pending=a.setItem('late','pending');await ready;
  const closing=a.close();
  assert.equal(a.closed,true);
  await a.setItem('after','blocked');
  const unhandled=[];
  const record=error=>unhandled.push(error);
  process.on('unhandledRejection',record);
  try {
    void a.setItem('fire-and-forget','blocked');
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(unhandled,[]);
  } finally { process.off('unhandledRejection',record); }
  release();await pending;await closing;
  assert.equal((await store.getKeys()).some(key=>key.includes('1'.repeat(32))),false);
  assert.equal(await b.getItem('keep'),'other');
  await a.close();
});
await check('a read already in flight cannot expose a value after retirement',async()=>{
  let release,started;
  const gate=new Promise(resolve=>{release=resolve;});
  const ready=new Promise(resolve=>{started=resolve;});
  class DeferredRead extends MemoryStorage {
    async getItem(key){started();await gate;return super.getItem(key);}
  }
  const store=new DeferredRead(),a=scope(store,'5'.repeat(32));
  await a.setItem('secret','synthetic');
  const pending=a.getItem('secret');await ready;
  const closing=a.close();release();
  assert.equal(await pending,undefined);
  await closing;
  assert.equal((await store.getKeys()).length,0);
});
await check('failed cleanup stays closed and can be retried without touching another scope',async()=>{
  class FailingStorage extends MemoryStorage {
    fail=true;
    async removeItem(key){if(this.fail){this.fail=false;throw new Error('synthetic cleanup failure');}return super.removeItem(key);}
  }
  const store=new FailingStorage(),a=scope(store,'3'.repeat(32)),b=scope(store,'4'.repeat(32));
  await a.setItem('one',1);await b.setItem('keep',2);
  await assert.rejects(()=>a.close(),/synthetic cleanup failure/);
  assert.equal(a.closed,true);
  assert.equal(await a.getItem('one'),undefined);
  await a.setItem('after','must-not-persist');
  await a.close();
  assert.equal(await b.getItem('keep'),2);
});
await check('backend failures propagate to the caller',async()=>{
  const failure=new Error('synthetic storage failure');
  const broken={getKeys:async()=>{throw failure;},getEntries:async()=>{throw failure;},getItem:async()=>{throw failure;},setItem:async()=>{throw failure;},removeItem:async()=>{throw failure;}};
  const view=scope(broken,'c'.repeat(32));
  for(const operation of [()=>view.getKeys(),()=>view.getEntries(),()=>view.getItem('x'),()=>view.setItem('x',1),()=>view.removeItem('x')]) await assert.rejects(operation,error=>error===failure);
});
console.log(JSON.stringify({status:'passed',checks:checks.length,scenarios:checks}));
