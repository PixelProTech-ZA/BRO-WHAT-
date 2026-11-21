// BRO, WHAT?! API — Cloudflare Worker version of server.js (no dependencies).
// Secrets/vars: OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_FALLBACK_MODEL (optional),
//               ADMIN_PASSWORD, ALLOWED_ORIGIN (e.g. https://pixelprotech-za.github.io)
// Optional KV binding: STATS  (anonymous counts only, never message text)

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
const hits = new Map();
const limited = ip => { const n = Date.now(), a = (hits.get(ip) || []).filter(t => n - t < 60000); a.push(n); hits.set(ip, a);
  if (hits.size > 5000) hits.clear(); return a.length > 12; };

async function log(env, e) {
  if (!env.STATS) return;
  const ev = { ts: Date.now(), ...e };
  try { await env.STATS.put('ev:' + String(ev.ts).padStart(15, '0') + ':' + crypto.randomUUID().slice(0, 8), '1',
    { metadata: ev, expirationTtl: 60 * 60 * 24 * 90 }); } catch {}
}

async function orCall(env, model, messages, json) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), +env.TIMEOUT_MS || 25000);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', signal: ac.signal,
      headers: { Authorization: 'Bearer ' + env.OPENROUTER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, ...(json ? { response_format: { type: 'json_object' } } : {}) }) });
    if (!r.ok) { const e = new Error('http'); e.status = r.status; throw e; }
    const j = await r.json();
    return { text: j.choices?.[0]?.message?.content || '', tokens: j.usage?.total_tokens || 0, model };
  } finally { clearTimeout(t); }
}
const ask = async (env, m, json) => { try { return await orCall(env, env.OPENROUTER_MODEL, m, json); }
  catch (e) { if (env.OPENROUTER_FALLBACK_MODEL && e.status !== 429) return orCall(env, env.OPENROUTER_FALLBACK_MODEL, m, json); throw e; } };

function cleanURLs(text, used) {
  return text.replace(/https?:\/\/[^\s)>\]]+/g, u => {
    try { const h = new URL(u).hostname.replace(/^www\./, ''); if (RESOURCES[h]) { used.push(h); return u; } } catch {}
    return '[link removed]'; });
}

async function chat(req, env, ctx, send) {
  if (!(env.OPENROUTER_API_KEY && env.OPENROUTER_MODEL)) return send(503, { error: 'setup' });
  if (limited(req.headers.get('CF-Connecting-IP') || 'x')) return send(429, { error: 'rate' });
  let b; try { b = await req.json(); } catch { return send(400, { error: 'bad' }); }
  const msgs = Array.isArray(b.messages) ? b.messages.slice(-12) : [];
  if (!msgs.length || msgs.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 2000) || msgs[msgs.length - 1].role !== 'user') return send(400, { error: 'bad' });
  const t0 = Date.now(); let cls = { category: 'UNCERTAIN', context: 'UNKNOWN', confidence: 0, safety: 'none' }, tokens = 0, model = env.OPENROUTER_MODEL;
  try {
    const c = await ask(env, [{ role: 'system', content: CLASSIFY }, ...msgs.slice(-3)], true); tokens += c.tokens;
    cls = { ...cls, ...JSON.parse(c.text.replace(/```json|```/g, '')) };
  } catch {}
  try {
    const sys = SYSTEM + (GUIDE[cls.safety] ? '\n' + GUIDE[cls.safety] : '');
    const a = await ask(env, [{ role: 'system', content: sys }, ...msgs]); tokens += a.tokens; model = a.model;
    const used = [], reply = cleanURLs(a.text, used);
    ctx.waitUntil(log(env, { model, category: cls.category, context: cls.context, confidence: cls.confidence, safety: cls.safety, status: 'ok', latency: Date.now() - t0, tokens, urls: used }));
    return send(200, { reply, safety: cls.safety });
  } catch (e) {
    ctx.waitUntil(log(env, { model, category: cls.category, context: cls.context, confidence: cls.confidence, safety: cls.safety, status: 'error:' + (e.status || e.name), latency: Date.now() - t0, tokens, urls: [] }));
    return send(e.status === 429 ? 429 : 502, { error: e.status === 429 ? 'rate' : 'down' });
  }
}

function authed(req, env) {
  const a = (req.headers.get('authorization') || '').replace('Bearer ', ''), b = env.ADMIN_PASSWORD || '';
  if (!b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}
async function stats(env, q) {
  let ev = [], cursor;
  if (env.STATS) for (let i = 0; i < 10; i++) {
    const r = await env.STATS.list({ prefix: 'ev:', cursor, limit: 1000 });
    ev.push(...r.keys.map(k => k.metadata).filter(Boolean)); if (r.list_complete) break; cursor = r.cursor;
  }
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

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url), origin = req.headers.get('Origin');
    const h = { 'content-type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    if (origin && origin === env.ALLOWED_ORIGIN) Object.assign(h, { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin',
      'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    const send = (s, o) => new Response(JSON.stringify(o), { status: s, headers: h });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (req.method === 'POST' && u.pathname === '/api/chat') return chat(req, env, ctx, send);
    if (req.method === 'GET' && u.pathname === '/api/status') return send(200, { configured: !!(env.OPENROUTER_API_KEY && env.OPENROUTER_MODEL) });
    if (req.method === 'POST' && u.pathname === '/api/feedback') {
      try { const b = await req.json(); if (['up', 'down'].includes(b.value)) ctx.waitUntil(log(env, { feedback: b.value })); } catch {}
      return send(200, {});
    }
    if (u.pathname === '/api/admin/stats') return authed(req, env) ? send(200, await stats(env, u.searchParams)) : send(401, { error: 'auth' });
    return send(404, { error: 'not found' });
  }
};
