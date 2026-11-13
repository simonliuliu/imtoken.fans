// Isolated, synthetic protocol experiment. No real wallet or service is contacted.
// Use a separately installed 2.26.0 fixture; this does not modify project dependencies.
// The local broker models only the messages needed here, not the production relay.
// Run through walletconnect-universal-offline-runner.mjs for bounded failure cleanup.
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (process.env.IMTOKEN_WALLET_OFFLINE_WORKER !== '1') {
  process.stderr.write('Use walletconnect-universal-offline-runner.mjs\n');
  process.exit(2);
}
const projectRoot=process.env.IMTOKEN_WALLET_QA_PROJECT_ROOT||path.resolve(__dirname,'../..');
if (!path.isAbsolute(projectRoot)) throw new Error('QA project root must be absolute');
const require = createRequire(import.meta.url);
const fixtureRoot = process.env.WALLETCONNECT_TEST_DEPS_ROOT;
if (!fixtureRoot || !path.isAbsolute(fixtureRoot)) {
  process.stderr.write('Set WALLETCONNECT_TEST_DEPS_ROOT to an absolute isolated dependency directory.\n');
  process.exit(1);
}
const fixtureRequire = createRequire(path.join(fixtureRoot, 'package.json'));
const { WebSocketServer } = fixtureRequire('ws');
let allowedPort = 0;
let blockedNetwork = 0;
const blockedTargets = new Set();
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const arg = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof arg === 'object' ? arg.host || arg.hostname : args[1];
  const port = Number(typeof arg === 'object' ? arg.port : arg);
  if ((host !== '127.0.0.1' && host !== 'localhost') || port !== allowedPort) {
    blockedNetwork++;
    blockedTargets.add('socket:' + String(host) + ':' + String(port));
    throw new Error('Outbound network disabled in isolated fixture');
  }
  return originalConnect.apply(this, args);
};
tls.connect = function() { blockedNetwork++; blockedTargets.add('tls'); throw new Error('TLS disabled in isolated fixture'); };
dgram.createSocket = function() { blockedNetwork++; throw new Error('UDP disabled in isolated fixture'); };
const originalLookup = dns.lookup;
dns.lookup = function(host, ...args) {
  if (host !== 'localhost' && host !== '127.0.0.1') { blockedNetwork++; blockedTargets.add('dns:' + host); throw new Error('DNS disabled in isolated fixture'); }
  return originalLookup.call(this, host, ...args);
};
globalThis.fetch = async function(target) { blockedNetwork++; try { blockedTargets.add('fetch:' + new URL(String(target)).origin); } catch { blockedTargets.add('fetch:unknown'); } throw new Error('HTTP disabled in isolated fixture'); };
process.env.DISABLE_GLOBAL_CORE = 'true';
process.env.WALLETCONNECT_DISABLE_LOGGER = 'true';
const waitFor = (promise, name, duration = 12000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out: '+name)), duration).unref())]);
const eventOnce = (source, event) => new Promise(resolve => source.once(event, resolve));
class MemoryStorage {
  constructor() { this.data = new Map(); }
  async getKeys() { return [...this.data.keys()]; }
  async getEntries() { return [...this.data.entries()]; }
  async getItem(key) { return this.data.get(key); }
  async setItem(key, value) { this.data.set(key, value); }
  async removeItem(key) { this.data.delete(key); }
}
const subs = new Map();
const backlog = new Map();
let msgId = Date.now();
let pubCount = 0;
let requestCount = 0;
const syntheticChallenge = 'synthetic-offline-walletconnect-identity';
let challengeVisibleOnRelay = false;
const rpcMethods = new Map();
const unexpectedRejections = [];
process.on('unhandledRejection', error => { unexpectedRejections.push(error); process.exitCode=1; });
function handle(ws, message) {
  let data;
  const wire = message.toString();
  if (wire.includes(syntheticChallenge) || wire.toLowerCase().includes(Buffer.from(syntheticChallenge).toString('hex'))) challengeVisibleOnRelay = true;
  try { data = JSON.parse(wire); } catch { return; }
  if (!data.method) return;
  requestCount++;
  const {method, params = {}, id} = data;
  rpcMethods.set(method,(rpcMethods.get(method)||0)+1);
  const response = result => ws.send(JSON.stringify({jsonrpc:'2.0',id,result}));
  const deliver = (socket, subscriptionId, item) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({jsonrpc:'2.0', id:++msgId, method:'irn_subscription', params:{id:subscriptionId,data:item}}));
  };
  const subscribe = topic => {
    const subId = crypto.createHash('sha256').update(topic+String(ws.fixtureClientId||'missing')).digest('hex');
    if (!subs.has(topic)) subs.set(topic, new Map());
    subs.get(topic).set(ws,subId);
    const pending = backlog.get(topic) || [];
    backlog.delete(topic);
    setImmediate(() => { for(const item of pending) deliver(ws,subId,item); });
    return subId;
  };
  if (method === 'wc_proposeSession') {
    subscribe(params.pairingTopic);
    const item={topic:params.pairingTopic,message:params.sessionProposal,publishedAt:Date.now(),tag:1100};
    const q=backlog.get(params.pairingTopic)||[];q.push(item);backlog.set(params.pairingTopic,q);pubCount++;
    return response(true);
  }
  if (method === 'wc_approveSession') {
    subscribe(params.sessionTopic);
    const items=[{topic:params.pairingTopic,message:params.sessionProposalResponse,publishedAt:Date.now(),tag:1101},{topic:params.sessionTopic,message:params.sessionSettlementRequest,publishedAt:Date.now(),tag:1102}];
    pubCount+=2;response(true);
    setImmediate(()=>{for(const item of items){const recipients=[...(subs.get(item.topic)||new Map())].filter(([socket])=>socket!==ws);if(!recipients.length){const q=backlog.get(item.topic)||[];q.push(item);backlog.set(item.topic,q);}else for(const [socket,subId] of recipients)deliver(socket,subId,item);}});return;
  }
  if (method === 'irn_subscribe') return response(subscribe(params.topic));
  if (method === 'irn_batchSubscribe') return response(params.topics.map(subscribe));
  if (method === 'irn_unsubscribe') { subs.get(params.topic)?.delete(ws); return response(true); }
  if (method === 'irn_batchUnsubscribe') { for(const sub of params.subscriptions) subs.get(sub.topic)?.delete(ws); return response(true); }
  if (method === 'irn_publish') {
    pubCount++;
    const item = {topic:params.topic,message:params.message,publishedAt:Date.now(),tag:params.tag};
    const recipients = [...(subs.get(params.topic) || new Map())].filter(([socket]) => socket !== ws);
    if (!recipients.length) { const q=backlog.get(params.topic)||[];q.push(item);backlog.set(params.topic,q); }
    response(true);
    setImmediate(() => { for(const [socket,subId] of recipients) deliver(socket,subId,item); });
    return;
  }
  if (method === 'irn_fetchMessages') return response({messages:[],hasMore:false});
  ws.send(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32601,message:'Unsupported fixture method'}}));
}
(async () => {
  let phase = 'relay startup';
  const clients=[];
  let success;
  let failure;
  let signatureRequests=0;
  let signaturesCreated=0;
  let signatureResponses=0;
  const server = new WebSocketServer({host:'127.0.0.1',port:0});
  await eventOnce(server,'listening');
  allowedPort=server.address().port;
  server.on('connection', (socket, request) => {
    try { const token=new URL(request.url,'http://127.0.0.1').searchParams.get('auth'); socket.fixtureClientId=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).iss; } catch { socket.fixtureClientId='missing'; }
    socket.on('message', message => handle(socket,message));
    socket.on('close', () => { for(const s of subs.values()) s.delete(socket); });
  });
  const shut = async () => {
    for (const client of clients) client.core.heartbeat.stop();
    const results=await Promise.allSettled(clients.map(c=>waitFor(c.core.relayer.transportClose(),'transport close',2000)));
    for(const socket of server.clients) socket.terminate();
    await new Promise(resolve=>server.close(resolve));
    if(results.some(result=>result.status==='rejected')) throw new Error('Fixture transport cleanup failed');
  };
  try {
    const versionOf=name=>JSON.parse(fs.readFileSync(path.join(path.dirname(fixtureRequire.resolve(name)),'..','package.json'),'utf8')).version;
    assert.equal(versionOf('@walletconnect/sign-client'),'2.26.0');
    assert.equal(versionOf('@walletconnect/universal-provider'),'2.26.0');
    const {SignClient}=fixtureRequire('@walletconnect/sign-client');
    const {UniversalProvider}=fixtureRequire('@walletconnect/universal-provider');
    const {privateKeyToAccount,generatePrivateKey}=fixtureRequire('viem/accounts');
    const {verifyMessage,stringToHex}=fixtureRequire('viem');
    const guardSource=fs.readFileSync(path.join(projectRoot,'src/lib/walletconnect-session.ts'),'utf8');
    const guardModule={exports:{}};
    vm.runInNewContext(ts.transpileModule(guardSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:guardModule,exports:guardModule.exports,require});
    const guard=guardModule.exports.walletConnectSessionAllowsSignIn;
    const account=privateKeyToAccount(generatePrivateKey());
    const common={projectId:'00000000000000000000000000000000',relayUrl:'ws://127.0.0.1:'+allowedPort,logger:'silent',telemetryEnabled:false};
    phase='wallet init';
    const wallet=await waitFor(SignClient.init({...common,storage:new MemoryStorage(),customStoragePrefix:'wallet',metadata:{name:'Synthetic wallet',description:'Offline fixture',url:'https://fixture.invalid',icons:[]}}),'wallet init');
    clients.push(wallet);
    async function waitForWalletAcknowledgement(topic) {
      const deadline=Date.now()+10000;
      while(Date.now()<deadline) {
        if(wallet.session.get(topic)?.acknowledged===true) return;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      throw new Error('Timed out: wallet session acknowledgement');
    }
    wallet.on('session_request',async event => {
      signatureRequests++;
      try {
        assert.equal(event.params.request.method,'personal_sign');
        assert.equal(event.params.chainId,'eip155:1');
        const raw=event.params.request.params[0];
        const result=await account.signMessage({message:{raw}});
        signaturesCreated++;
        await wallet.respond({topic:event.topic,response:{id:event.id,jsonrpc:'2.0',result}});
        signatureResponses++;
      } catch(error) { unexpectedRejections.push(error); }
    });
    async function runScenario({name, methods, chain, abort=false, sign=false}) {
      phase=name+' init';
      const provider=await waitFor(UniversalProvider.init({...common,storage:new MemoryStorage(),customStoragePrefix:'dapp-'+name,disableProviderPing:true,metadata:{name:'Synthetic app',description:'Offline fixture',url:'https://fixture.invalid',icons:[]}}),'provider init');
      clients.push(provider.client);
      phase=name+' proposal';
      const proposalPromise=eventOnce(wallet,'session_proposal');
      const uriPromise=eventOnce(provider,'display_uri');
      const sessionPromise=provider.connect({namespaces:{eip155:{chains:['eip155:1'],methods:['personal_sign'],events:['accountsChanged','chainChanged'],rpcMap:{'1':'http://127.0.0.1:1'}}}});
      sessionPromise.catch(()=>{});
      const uri=await waitFor(uriPromise,'display URI');
      if (abort) provider.abortPairingAttempt();
      await waitFor(wallet.pair({uri}),'wallet pair');
      const proposal=await waitFor(proposalPromise,'wallet proposal');
      assert.deepEqual(proposal.params.requiredNamespaces,{});
      assert(proposal.params.optionalNamespaces.eip155.methods.includes('personal_sign'));
      phase=name+' approval';
      const approval=await wallet.approve({id:proposal.id,namespaces:{eip155:{accounts:[`eip155:${chain}:${account.address}`],methods,events:['accountsChanged','chainChanged']}}});
      const session=await waitFor(sessionPromise,'dapp session');
      await waitFor(approval.acknowledged(),'wallet acknowledgement');
      await waitForWalletAcknowledgement(session.topic);
      assert.equal(guard(session,account.address),sign||abort);
      if (sign) {
        phase=name+' signature';
        const signature=await waitFor(provider.request({method:'personal_sign',params:[stringToHex(syntheticChallenge),account.address]},'eip155:1'),'personal sign');
        assert.equal(await verifyMessage({address:account.address,message:syntheticChallenge,signature}),true);
      }
      phase=name+' disconnect';
      assert.equal(provider.session.topic,session.topic);
      assert(wallet.session.getAll().some(item=>item.topic===session.topic));
      const walletDeleted=eventOnce(wallet,'session_delete');
      await waitFor(provider.disconnect(),'disconnect');
      await waitFor(walletDeleted,'wallet session deletion');
      assert.equal(provider.session,undefined);
      assert.equal(provider.client.session.getAll().some(item=>item.topic===session.topic),false);
      assert.equal(wallet.session.getAll().some(item=>item.topic===session.topic),false);
    }
    await runScenario({name:'authorized',methods:['personal_sign'],chain:1,sign:true});
    await runScenario({name:'missing-method',methods:[],chain:1});
    await runScenario({name:'wrong-chain',methods:['personal_sign'],chain:137});
    await runScenario({name:'late-after-abort',methods:['personal_sign'],chain:1,abort:true});
    // Use the SDK's default global-core behavior for these two-attempt probes.
    // A distinct prefix alone does not necessarily isolate a shared backend.
    delete process.env.DISABLE_GLOBAL_CORE;
    async function runStorageIsolation(shared) {
      const label=shared?'shared-storage':'separate-storage';
      const oldStore=new MemoryStorage();
      const newStore=shared?oldStore:new MemoryStorage();
      async function init(name,storage) {
        const provider=await waitFor(UniversalProvider.init({...common,storage,customStoragePrefix:label+'-'+name,disableProviderPing:true,metadata:{name:'Synthetic app',description:'Offline fixture',url:'https://fixture.invalid',icons:[]}}),label+' init');
        clients.push(provider.client);
        return provider;
      }
      const oldProvider=await init('old',oldStore);
      const newProvider=await init('new',newStore);
      assert.notEqual(oldProvider.client.core,newProvider.client.core);
      assert.equal(oldProvider.client.core.storage===newProvider.client.core.storage,shared);
      const start=provider=>{
        const uri=eventOnce(provider,'display_uri');
        const session=provider.connect({namespaces:{eip155:{chains:['eip155:1'],methods:['personal_sign'],events:['accountsChanged','chainChanged'],rpcMap:{'1':'http://127.0.0.1:1'}}}});
        session.catch(()=>{});
        return {uri,session};
      };
      async function approve(attempt) {
        phase=label+' awaiting URI';
        const uri=await waitFor(attempt.uri,label+' URI');
        const proposal=eventOnce(wallet,'session_proposal');
        phase=label+' pairing wallet';
        await waitFor(wallet.pair({uri}),label+' wallet pair');
        phase=label+' awaiting proposal';
        const pending=await waitFor(proposal,label+' proposal');
        phase=label+' approving proposal';
        const approval=await wallet.approve({id:pending.id,namespaces:{eip155:{accounts:[`eip155:1:${account.address}`],methods:['personal_sign'],events:['accountsChanged','chainChanged']}}});
        phase=label+' awaiting session';
        const session=await waitFor(attempt.session,label+' session');
        phase=label+' acknowledging session';
        await waitFor(approval.acknowledged(),label+' acknowledgement');
        await waitForWalletAcknowledgement(session.topic);
        assert.equal(guard(session,account.address),true);
        return session;
      }
      phase=label+' old connect and cancel';
      const oldAttempt=start(oldProvider);
      await waitFor(oldAttempt.uri,label+' old URI');
      oldProvider.abortPairingAttempt();
      phase=label+' new approval';
      const newer=await approve(start(newProvider));
      const newKeys=(await newStore.getKeys()).filter(key=>key.startsWith('wc@2:universal_provider:')&&key.includes(newer.topic));
      assert(newKeys.length>0,'the newer session must have actual provider state in storage');
      const sign=()=>newProvider.request({method:'personal_sign',params:[stringToHex(syntheticChallenge),account.address]},'eip155:1');
      phase=label+' sign before cleanup';
      assert.equal(await verifyMessage({address:account.address,message:syntheticChallenge,signature:await waitFor(sign(),label+' sign before cleanup')}),true);
      phase=label+' late old approval';
      const older=await approve(oldAttempt);
      assert.notEqual(older.topic,newer.topic);
      const oldDeleted=eventOnce(wallet,'session_delete');
      await waitFor(oldProvider.disconnect(),label+' old disconnect');
      assert.equal((await waitFor(oldDeleted,label+' old deletion')).topic,older.topic);
      const after=new Set(await newStore.getKeys());
      const removedNewKeys=newKeys.filter(key=>!after.has(key));
      if(shared) assert(removedNewKeys.length>0,'shared backend must expose the cross-attempt cleanup hazard');
      else assert.deepEqual(removedNewKeys,[],'separate backend must retain the newer provider state');
      assert(newProvider.client.session.getAll().some(item=>item.topic===newer.topic));
      assert(wallet.session.getAll().some(item=>item.topic===newer.topic));
      phase=label+' sign after cleanup';
      assert.equal(await verifyMessage({address:account.address,message:syntheticChallenge,signature:await waitFor(sign(),label+' sign after cleanup')}),true);
      // Reconstruct from the same SignClient session, forcing UniversalProvider
      // to read its namespaces from the tested storage rather than live memory.
      phase=label+' reconstruct provider';
      const restored=await waitFor(UniversalProvider.init({...common,client:newProvider.client,session:newer,metadata:{name:'Synthetic app',description:'Offline fixture',url:'https://fixture.invalid',icons:[]}}),label+' restore');
      if(shared) {
        phase=label+' inspect restored namespaces';
        assert.equal(Object.keys(restored.namespaces||{}).length,0);
        assert.equal(Object.keys(restored.optionalNamespaces||{}).length,0);
        phase=label+' inspect restored session';
        assert.equal(restored.session.topic,newer.topic);
      } else {
        assert(restored.namespaces?.eip155||restored.optionalNamespaces?.eip155);
      }
      // This SDK can rebuild an EIP-155 provider from the live session even
      // after its persisted namespace options are gone; check signing as well.
      phase=label+' inspect restored chain provider';
      assert(restored.getProvider('eip155'));
      phase=label+' restored signature';
      const restoredSign=()=>waitFor(restored.request({method:'personal_sign',params:[stringToHex(syntheticChallenge),account.address]},'eip155:1'),label+' restored signature');
      if(shared) await assert.rejects(restoredSign,{name:'TypeError',message:/undefined.*includes/});
      else assert.equal(await verifyMessage({address:account.address,message:syntheticChallenge,signature:await restoredSign()}),true);
      const newDeleted=eventOnce(wallet,'session_delete');
      await waitFor(newProvider.disconnect(),label+' new disconnect');
      assert.equal((await waitFor(newDeleted,label+' new deletion')).topic,newer.topic);
      assert.equal(wallet.session.getAll().some(item=>item.topic===newer.topic),false);
    }
    await runStorageIsolation(true);
    await runStorageIsolation(false);
    phase='same-prefix global core';
    const firstStorage=new MemoryStorage(),ignoredStorage=new MemoryStorage();
    const samePrefixOptions={...common,customStoragePrefix:'same-prefix-fixture',disableProviderPing:true,metadata:{name:'Synthetic app',description:'Offline fixture',url:'https://fixture.invalid',icons:[]}};
    const firstProvider=await waitFor(UniversalProvider.init({...samePrefixOptions,storage:firstStorage}),'same prefix first');
    clients.push(firstProvider.client);
    const secondProvider=await waitFor(UniversalProvider.init({...samePrefixOptions,storage:ignoredStorage}),'same prefix second');
    assert.equal(firstProvider.client.core,secondProvider.client.core);
    assert.equal(secondProvider.client.core.storage,firstStorage);
    assert.notEqual(secondProvider.client.core.storage,ignoredStorage);
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(unexpectedRejections.length,0);
    assert.equal(signatureRequests,6);
    assert.equal(challengeVisibleOnRelay,false);
    assert(pubCount>12);
    success={status:'passed',sharedStorageIsolation:'unsafe',samePrefixIsolation:'unsafe',separateStorageScope:'synthetic session and signature only',scenarios:['real encrypted pairing, namespace and synthetic signature','missing method rejected by project guard','wrong chain rejected by project guard','late approval still succeeds after abort and both peers clear session','shared storage permits old cleanup to remove new provider state','separate storage retains new provider state during old cleanup','same prefix reuses global core despite a different storage'],relayRequests:requestCount,published:pubCount,blockedOutboundAttempts:blockedNetwork,blockedTargets:[...blockedTargets]};
  } catch(error) {
    const diagnostic=String(error?.message||'').replace(/(?:wc:|https?:\/\/)\S+/gi,'[redacted]').replace(/(?:0x)?[a-f0-9]{24,}/gi,'[redacted]').slice(0,180);
    const walletError=unexpectedRejections.at(-1);
    const walletDiagnostic=String(walletError?.message||'').replace(/(?:wc:|https?:\/\/)\S+/gi,'[redacted]').replace(/(?:0x)?[a-f0-9]{24,}/gi,'[redacted]').slice(0,180);
    failure={status:'failed',phase,errorName:error?.name,diagnostic,signatureRequests,signaturesCreated,signatureResponses,walletErrorName:walletError?.name,walletDiagnostic,relayRequests:requestCount,published:pubCount,blockedOutboundAttempts:blockedNetwork,rpcMethods:[...rpcMethods],blockedTargets:[...blockedTargets]};
  } finally {
    try { await shut(); } catch(error) { failure=failure||{status:'failed',phase:'fixture cleanup',errorName:error?.name}; }
  }
  await new Promise(resolve=>setImmediate(resolve));
  if(unexpectedRejections.length) failure=failure||{status:'failed',phase:'unhandled rejection'};
  if(failure) { process.stderr.write(JSON.stringify(failure)+'\n');process.exitCode=1; }
  else process.stdout.write(JSON.stringify(success)+'\n');
})().catch(()=>{process.stderr.write('Fixture startup failed\n');process.exitCode=1;});
