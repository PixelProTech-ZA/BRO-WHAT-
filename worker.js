// BRO, WHAT?! API - Cloudflare Worker. PixelProTech Solutions (Pty) Ltd.
// Secrets/vars: OPENROUTER_API_KEY (secret), OPENROUTER_MODEL (comma-separated model IDs, tried in order).
// No message text is logged or stored anywhere in this file. Keep it that way.

const ALLOWED_ORIGINS = ['https://pixelprotech-za.github.io'];
const MAX_CHARS = 2000;
const MAX_TURNS = 12;
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60000;
const MODEL_TIMEOUT_MS = 20000;

const hits = new Map();

const SYSTEM = `You are "BRO, WHAT?!", a calm, non-judgmental guide for awkward questions about bodies, relationships, sexual health, mental wellbeing and life. Audience: South African teens and adults.
Rules:
- Plain language, warm, direct, never shaming, never joking at the person's expense. Short paragraphs. Under 220 words unless asked for more.
- Give accurate, general health information. You are not a doctor: you do not diagnose. For symptoms that could be serious, say to see a clinic or doctor.
- Sexual health: factual and age-appropriate. Never produce sexual content or explicit roleplay. Refuse anything sexual involving minors.
- If someone may be in danger, being abused, or thinking of self-harm or suicide: respond with care first, encourage reaching a trusted person and a helpline. Never give methods.
- Never claim to be human. Never ask for names, addresses, ID numbers or phone numbers.
- If unsure, say so.
- Reply with the answer only. Do not show your reasoning or notes.`;

const URGENT_RE = /(kill(ing)? myself|suicid|end my life|want to die|don'?t want to (live|be here)|self.?harm|cut(ting)? myself|hurt myself|raped|rape me|molest|sexually abus|abus(es|ed|ing) me|hits me|beat(s|ing) me|forced me)/i;
const THREAT_RE = /(going to (kill|hurt|shoot|stab)|want to (kill|hurt) (him|her|them|someone|people))/i;

const HELP_BLOCK = `\n\nIf you or someone near you is in danger right now, call 112 (from a cell phone) or 10111. You are not alone:\n- SADAG suicide crisis line: 0800 567 567 (free, 24 hours)\n- Childline: 116 (free)\n- GBV Command Centre: 0800 428 428 (free, 24 hours)`;

function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': ok,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(origin), 'content-type': 'application/json' },
  });
}

function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.some(t => now - t < RATE_WINDOW_MS)) hits.delete(k);
  }
  return arr.length > RATE_LIMIT;
}

function cleanMessages(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out = [];
  for (const m of raw.slice(-MAX_TURNS)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
    if (typeof m.content !== 'string') return null;
    const c = m.content.trim();
    if (!c || c.length > MAX_CHARS) return null;
    out.push({ role: m.role, content: c });
  }
  if (out[0].role !== 'user') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') return null;
  return out;
}

// Some free models reject a "system" role, so the rules ride inside the first user turn.
function withRules(messages) {
  const copy = messages.map(m => ({ ...m }));
  copy[0].content = SYSTEM + '\n\n---\nUser:\n' + copy[0].content;
  return copy;
}

async function askModel(model, messages, key) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODEL_TIMEOUT_MS);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://pixelprotech-za.github.io/BRO-WHAT-/',
        'X-Title': 'BRO, WHAT?!',
      },
      body: JSON.stringify({ model, max_tokens: 600, messages }),
    });
    if (!r.ok) return { ok: false, status: r.status };
    const data = await r.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message
      && data.choices[0].message.content;
    if (typeof text !== 'string' || !text.trim()) return { ok: false, status: 0 };
    return { ok: true, text: text.trim() };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'forbidden' }, 403, origin);
    }

    const models = String(env.OPENROUTER_MODEL || '').split(',').map(s => s.trim()).filter(Boolean);
    const configured = !!(env.OPENROUTER_API_KEY && models.length);

    if (url.pathname === '/api/status' && req.method === 'GET') {
      return json({ service: 'BRO, WHAT?!', status: 'online', configured }, 200, origin);
    }

    if (url.pathname === '/api/feedback' && req.method === 'POST') {
      return json({ ok: true }, 200, origin); // stores nothing
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      if (!configured) return json({ error: 'setup' }, 503, origin);

      const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
      if (limited(ip)) return json({ error: 'rate' }, 429, origin);

      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad' }, 400, origin); }
      const messages = cleanMessages(body && body.messages);
      if (!messages) return json({ error: 'bad' }, 400, origin);

      const last = messages[messages.length - 1].content;
      let safety = 'ok';
      if (THREAT_RE.test(last)) safety = 'threat';
      else if (URGENT_RE.test(last)) safety = 'urgent';

      const payload = withRules(messages);
      for (const model of models) {
        const res = await askModel(model, payload, env.OPENROUTER_API_KEY);
        if (res.ok) {
          let reply = res.text;
          if (safety !== 'ok') reply += HELP_BLOCK;
          return json({ reply, safety }, 200, origin);
        }
        if (res.status === 401 || res.status === 402) break; // key/credit problem: other models won't help
      }
      return json({ error: 'down' }, 502, origin);
    }

    return json({ error: 'not_found' }, 404, origin);
  },
};
