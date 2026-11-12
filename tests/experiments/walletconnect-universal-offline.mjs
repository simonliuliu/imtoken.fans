// Isolated, synthetic protocol experiment. No real wallet or service is contacted.
// Use a separately installed 2.26.0 fixture; this does not modify project dependencies.
// The local broker models only the messages needed here, not the production relay.
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
    const guardSource=fs.readFileSync(path.join(__dirname,'../../src/lib/walletconnect-session.ts'),'utf8');
    const guardModule={exports:{}};
    vm.runInNewContext(ts.transpileModule(guardSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:guardModule,exports:guardModule.exports,require});
    const guard=guardModule.exports.walletConnectSessionAllowsSignIn;
    const account=privateKeyToAccount(generatePrivateKey());
    const common={projectId:'00000000000000000000000000000000',relayUrl:'ws://127.0.0.1:'+allowedPort,logger:'silent',telemetryEnabled:false};
    phase='wallet init';
    const wallet=await waitFor(SignClient.init({...common,storage:new MemoryStorage(),customStoragePrefix:'wallet',metadata:{name:'Synthetic wallet',description:'Offline fixture',url:'https://fixture.invalid',icons:[]}}),'wallet init');
    clients.push(wallet);
    let signatureRequests=0;
    wallet.on('session_request',async event => {
      signatureRequests++;
      try {
        assert.equal(event.params.request.method,'personal_sign');
        assert.equal(event.params.chainId,'eip155:1');
        const raw=event.params.request.params[0];
        const result=await account.signMessage({message:{raw}});
        await wallet.respond({topic:event.topic,response:{id:event.id,jsonrpc:'2.0',result}});
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
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(unexpectedRejections.length,0);
    assert.equal(signatureRequests,1);
    assert.equal(challengeVisibleOnRelay,false);
    assert(pubCount>12);
    success={status:'passed',scenarios:['real encrypted pairing, namespace and synthetic signature','missing method rejected by project guard','wrong chain rejected by project guard','late approval still succeeds after abort and both peers clear session'],relayRequests:requestCount,published:pubCount,blockedOutboundAttempts:blockedNetwork,blockedTargets:[...blockedTargets]};
  } catch(error) {
    failure={status:'failed',phase,errorName:error?.name,relayRequests:requestCount,published:pubCount,blockedOutboundAttempts:blockedNetwork,rpcMethods:[...rpcMethods],blockedTargets:[...blockedTargets]};
  } finally {
    try { await shut(); } catch(error) { failure=failure||{status:'failed',phase:'fixture cleanup',errorName:error?.name}; }
  }
  await new Promise(resolve=>setImmediate(resolve));
  if(unexpectedRejections.length) failure=failure||{status:'failed',phase:'unhandled rejection'};
  if(failure) { process.stderr.write(JSON.stringify(failure)+'\n');process.exitCode=1; }
  else process.stdout.write(JSON.stringify(success)+'\n');
})().catch(()=>{process.stderr.write('Fixture startup failed\n');process.exitCode=1;});
