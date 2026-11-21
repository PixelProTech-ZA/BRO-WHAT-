// BRO, WHAT?! server. Node 18+, zero dependencies.  Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const C = {
  port: +process.env.PORT || 3000,
  key: process.env.OPENROUTER_API_KEY,
  model: process.env.OPENROUTER_MODEL,            // e.g. any OpenRouter model id. Change + restart, no rebuild.
  fallback: process.env.OPENROUTER_FALLBACK_MODEL,
  admin: process.env.ADMIN_PASSWORD,
  timeout: +process.env.TIMEOUT_MS || 25000,
};
const configured = () => !!(C.key && C.model);

// ---------- Editable modules: resources, prompts, safety rules ----------
const RESOURCES = { // only these domains may appear in replies
  'who.int': 'World Health Organization', 'nhs.uk': 'NHS',
  'plannedparenthood.org': 'Planned Parenthood', 'health.gov.za': 'South African Department of Health' };
const SYSTEM = `You are BRO, WHAT? - a friendly, honest, approachable assistant for questions people are embarrassed to ask.
You are not a comedian mocking anyone. Be relaxed and warm, and become serious the moment it matters.
Rules: speak naturally in simple language; explain unfamiliar terms; use emojis sparingly; never shame or ridicule; never assume gender, sexuality or circumstances; never invent medical facts; never diagnose from text; never give false reassurance; correct dangerous misunderstandings respectfully; recommend professional care when appropriate; ask one relevant follow-up if key info is missing.
Sexual health answers stay educational and age-appropriate, never erotic. Never produce sexual content involving minors. If abuse is disclosed, give safeguarding guidance.
Severe pain, heavy bleeding, breathing trouble, fainting or similar: clearly advise urgent medical care.
Links: only use these exact sites, only when they truly help, and say why: ${Object.keys(RESOURCES).map(d => 'https://www.' + d + '/').join(' ')}. Never invent a URL. Never give an emergency phone number unless the user's country is known and you are certain; otherwise tell them to contact local emergency services and offer to help find the local number.
Keep answers short and scannable.`;
const CLASSIFY = `Classify the user's LAST message. Reply JSON only: {"category":one of GENERAL,SEXUAL_HEALTH,SEXUAL_EDUCATION,BODY_HEALTH,ANAL_HEALTH,RELATIONSHIPS,MENTAL_WELLBEING,EMBARRASSING_QUESTION,VIOLENCE,SELF_HARM,ABUSE,MEDICAL_URGENT,POLITICAL,HISTORICAL,OTHER,UNCERTAIN,
"context":one of QUESTION,JOKE,FICTION,QUOTATION,PERSONAL_EXPERIENCE,OPINION,HYPOTHETICAL,POSSIBLE_THREAT,ACTUAL_THREAT,UNKNOWN,"confidence":0-1,"safety":one of none,sensitive,urgent,threat}.
Shocking words alone are not danger: history, quotes, jokes, fiction and politics are not threats. ACTUAL_THREAT needs a real target, intent, specificity, capability and imminence.`;
const GUIDE = {
  urgent: 'SAFETY: possible emergency. Lead with clear advice to get urgent medical care now, then brief calm support.',
  threat: 'SAFETY: possible real threat or self-harm. Respond with empathy, do not give harmful help, prioritise real-world emergency support and trusted people. Be direct, not playful.',
  sensitive: 'This is a sensitive but legitimate topic. Answer plainly and without judgement.' };

// ---------- Helpers ----------
const LOG = path.join(__dirname, 'data', 'events.jsonl');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const log = e => fs.appendFile(LOG, JSON.stringify({ id: crypto.randomUUID(), ts: Date.now(), ...e }) + '\n', () => {});
const readJSON = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 30000) { no(); req.destroy(); } }); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { no(); } }); });
const send = (r, s, o) => { r.writeHead(s, { 'content-type': 'application/json' }); r.end(JSON.stringify(o)); };
const hits = new Map();
const limited = ip => { const k = crypto.createHash('sha256').update(ip).digest('hex'), n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < 60000); a.push(n); hits.set(k, a); return a.length > 15; };

async function orCall(model, messages, json) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), C.timeout);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', signal: ac.signal,
      headers: { Authorization: 'Bearer ' + C.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, ...(json ? { response_format: { type: 'json_object' } } : {}) }) });
    if (!r.ok) { const e = new Error('http'); e.status = r.status; throw e; }
    const j = await r.json();
    return { text: j.choices?.[0]?.message?.content || '', tokens: j.usage?.total_tokens || 0, model };
  } finally { clearTimeout(t); }
}
const ask = async (m, json) => { try { return await orCall(C.model, m, json); } catch (e) { if (C.fallback && e.status !== 429) return orCall(C.fallback, m, json); throw e; } };

function cleanURLs(text, used) { // strip any link not on the allowlist
  return text.replace(/https?:\/\/[^\s)>\]]+/g, u => {
    try { const h = new URL(u).hostname.replace(/^www\./, ''); if (RESOURCES[h]) { used.push(h); return u; } } catch {}
    return '[link removed]'; });
}

// ---------- Routes ----------
async function chat(req, res) {
  if (!configured()) return send(res, 503, { error: 'setup' });
  if (limited(req.socket.remoteAddress || '')) return send(res, 429, { error: 'rate' });
  let b; try { b = await readJSON(req); } catch { return send(res, 400, { error: 'bad' }); }
  const msgs = Array.isArray(b.messages) ? b.messages.slice(-12) : [];
  if (!msgs.length || msgs.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 2000) || msgs[msgs.length - 1].role !== 'user') return send(res, 400, { error: 'bad' });
  const t0 = Date.now(); let cls = { category: 'UNCERTAIN', context: 'UNKNOWN', confidence: 0, safety: 'none' }, tokens = 0, model = C.model;
  try {
    const c = await ask([{ role: 'system', content: CLASSIFY }, ...msgs.slice(-3)], true); tokens += c.tokens;
    cls = { ...cls, ...JSON.parse(c.text.replace(/```json|```/g, '')) };
  } catch {}
  try {
    const sys = SYSTEM + (GUIDE[cls.safety] ? '\n' + GUIDE[cls.safety] : '');
    const a = await ask([{ role: 'system', content: sys }, ...msgs]); tokens += a.tokens; model = a.model;
    const used = [], reply = cleanURLs(a.text, used);
    log({ model, category: cls.category, context: cls.context, confidence: cls.confidence, safety: cls.safety, status: 'ok', latency: Date.now() - t0, tokens, urls: used });
    send(res, 200, { reply, safety: cls.safety });
  } catch (e) {
    log({ model, category: cls.category, context: cls.context, confidence: cls.confidence, safety: cls.safety, status: 'error:' + (e.status || e.name), latency: Date.now() - t0, tokens, urls: [] });
    send(res, e.status === 429 ? 429 : 502, { error: e.status === 429 ? 'rate' : 'down' });
  }
}
function authed(req) {
  if (!C.admin) return false;
  const a = Buffer.from((req.headers.authorization || '').replace('Bearer ', '')), b = Buffer.from(C.admin);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function stats(q) {
  let ev = []; try { ev = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch {}
  const from = q.get('from') ? Date.parse(q.get('from')) : 0, to = q.get('to') ? Date.parse(q.get('to')) + 864e5 : Infinity;
  const cat = q.get('category'), mod = q.get('model');
  const chats = ev.filter(e => e.status && e.ts >= from && e.ts < to && (!cat || e.category === cat) && (!mod || e.model === mod));
  const fb = ev.filter(e => e.feedback && e.ts >= from && e.ts < to);
  const count = f => chats.reduce((o, e) => { [].concat(f(e)).forEach(k => o[k] = (o[k] || 0) + 1); return o; }, {});
  const models = {}; chats.forEach(e => { const m = models[e.model] ||= { n: 0, fail: 0, ms: 0, tokens: 0 }; m.n++; m.ms += e.latency; m.tokens += e.tokens; if (e.status !== 'ok') m.fail++; });
  const ok = chats.filter(e => e.status === 'ok');
  return { total: chats.length, failures: chats.length - ok.length,
    avgLatency: ok.length ? Math.round(ok.reduce((s, e) => s + e.latency, 0) / ok.length) : 0,
    tokens: chats.reduce((s, e) => s + e.tokens, 0), byCategory: count(e => e.category), byDay: count(e => new Date(e.ts).toISOString().slice(0, 10)),
    safety: count(e => e.safety), resources: count(e => e.urls), models,
    feedback: { up: fb.filter(e => e.feedback === 'up').length, down: fb.filter(e => e.feedback === 'down').length } };
}
const FILES = { '/': 'index.html', '/admin': 'admin.html' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'POST' && u.pathname === '/api/chat') return chat(req, res);
  if (req.method === 'GET' && u.pathname === '/api/status') return send(res, 200, { configured: configured() });
  if (req.method === 'POST' && u.pathname === '/api/feedback') { try { const b = await readJSON(req); if (['up', 'down'].includes(b.value)) log({ feedback: b.value }); } catch {} return send(res, 200, {}); }
  if (u.pathname === '/api/admin/stats') return authed(req) ? send(res, 200, stats(u.searchParams)) : send(res, 401, { error: 'auth' });
  const f = FILES[u.pathname];
  if (f) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'public', f))); }
  send(res, 404, { error: 'not found' });
}).listen(C.port, () => console.log(`BRO, WHAT?! on :${C.port} | AI ${configured() ? 'configured' : 'NOT configured (set OPENROUTER_API_KEY and OPENROUTER_MODEL)'} | admin ${C.admin ? 'on' : 'off (set ADMIN_PASSWORD)'}`));
