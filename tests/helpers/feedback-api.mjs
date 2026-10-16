// Local preview/regression fixture only. No production credentials or Supabase calls.
import { createServer } from 'node:http';
import { READER_ID, CREATOR_ID, profileFor, sessionFor, userFor } from './auth-fixtures.mjs';
const posts = new Map();
const seedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
posts.set(seedId, { id: seedId, title: '示例反馈：保留未发布草稿', description: '本地回归示例，不写入正式数据库。', author_name: 'Test Reader', module: 'wallet', status: 'inbox', mark: 'none', visibility: 'published', version: 1, support_count: 0, supported: false, comment_count: 0, merge_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
let loseNextResponse = false;
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', 'http://localhost:4000');
  response.setHeader('Access-Control-Allow-Headers', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'OPTIONS') return response.writeHead(204).end();
  const url = new URL(request.url, 'http://127.0.0.1:54329');
  const send = (value, status=200) => response.writeHead(status).end(JSON.stringify(value));
  let viewer = null;
  try { viewer = JSON.parse(Buffer.from(request.headers.authorization.replace(/^Bearer /i,'').split('.')[1], 'base64url').toString()).sub; } catch {}
  let body = '';
  for await (const chunk of request) body += chunk;
  let input = {};
  try { input = JSON.parse(body || '{}'); } catch { return send({message:'Invalid local fixture input'},400); }
  if (url.pathname === '/health') return send({ok:true});
  if (url.pathname === '/test/lose-next-response' && request.method === 'POST') { loseNextResponse = true; return send({ok:true}); }
  if (url.pathname === '/test/summary') return send({count:posts.size});
  if (url.pathname === '/auth/v1/user') return viewer ? send(userFor(viewer)) : send({message:'No test session'},401);
  if (url.pathname === '/auth/v1/token') return send(sessionFor(input.email?.startsWith('creator') ? CREATOR_ID : READER_ID));
  if (url.pathname === '/auth/v1/logout') return send({});
  if (url.pathname === '/rest/v1/profiles') return send(profileFor(url.searchParams.get('id')?.replace(/^eq\./,'') || viewer || READER_ID));
  if (url.pathname === '/rest/v1/rpc/feedback_read') {
    const list = [...posts.values()].filter(p => !input.p_query || (p.title+' '+p.description).toLowerCase().includes(input.p_query.toLowerCase()));
    return send({posts:list,total:list.length,selected:posts.get(input.p_id)??null,sources:[],comments:[],comment_total:0,history:[],viewer:{user_id:viewer,signed_in:Boolean(viewer),can_manage:false}});
  }
  if (url.pathname === '/rest/v1/rpc/feedback_write') {
    if (!viewer) return send({message:'feedback_sign_in'},401);
    const p = input.p_payload;
    if (input.p_action !== 'create' || !p?.title?.trim() || !p?.description?.trim()) return send({message:'feedback_invalid'},400);
    const previous = posts.get(p.id);
    if (previous && (previous.title !== p.title.trim() || previous.description !== p.description.trim() || previous.module !== p.module)) return send({message:'feedback_conflict'},409);
    if (!previous) posts.set(p.id,{...posts.get(seedId),id:p.id,title:p.title.trim(),description:p.description.trim(),module:p.module});
    if (loseNextResponse) { loseNextResponse = false; return send({message:'Simulated response lost after commit'},503); }
    return send({id:p.id});
  }
  if (url.pathname === '/rest/v1/rpc/notification_read') return send({items:[],unread_count:0,total:0});
  if (url.pathname.startsWith('/rest/v1/')) return send([]);
  return send({message:'Unknown local fixture endpoint'},404);
});
server.listen(54329,'127.0.0.1',()=>console.log('Local feedback fixture on 127.0.0.1:54329; no external database.'));
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>server.close(()=>process.exit(0)));
