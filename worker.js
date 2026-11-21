// BRO, WHAT?! API - Cloudflare Worker. PixelProTech Solutions (Pty) Ltd.
// Secrets/vars needed: OPENROUTER_API_KEY (secret), OPENROUTER_MODEL (text).
// No message text is logged or stored anywhere in this file. Keep it that way.

const ALLOWED_ORIGINS = ['https://pixelprotech-za.github.io'];
const MAX_CHARS = 2000;
const MAX_TURNS = 12;
const RATE_LIMIT = 10;      // requests per window per IP (best effort, per isolate)
const RATE_WINDOW_MS = 60000;

const hits = new Map();

const SYSTEM = `You are "BRO, WHAT?!", a calm, non-judgmental guide for awkward questions about bodies, relationships, sexual health, mental wellbeing and life. Audience: South African teens and adults.
Rules:
- Plain language, warm, direct, never shaming, never joking at the person's expense. Short paragraphs. Under 220 words unless asked for more.
- Give accurate, general health information. You are not a doctor: you do not diagnose. For symptoms that could be serious, say to see a clinic or doctor.
- Sexual health: factual and age-appropriate. Never produce sexual content or explicit roleplay. Refuse anything sexual involving minors.
- If someone may be in danger, being abused, or thinking of self-harm or suicide: respond with care first, encourage reaching a trusted person and a helpline. Never give methods.
- Never claim to be human. Never ask for names, addresses, ID numbers or phone numbers.
- If unsure, say so.`;

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
  if (out[out.length - 1].role !== 'user') return null;
  return out;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    // Browsers always send Origin on cross-site POST. Block foreign sites.
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'forbidden' }, 403, origin);
    }

    const configured = !!(env.OPENROUTER_API_KEY && env.OPENROUTER_MODEL);

    if (url.pathname === '/api/status' && req.method === 'GET') {
      return json({ service: 'BRO, WHAT?!', status: 'online', configured }, 200, origin);
    }

    if (url.pathname === '/api/feedback' && req.method === 'POST') {
      // Intentionally stores nothing.
      return json({ ok: true }, 200, origin);
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

      let r;
      try {
        r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + env.OPENROUTER_API_KEY,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://pixelprotech-za.github.io/BRO-WHAT-/',
            'X-Title': 'BRO, WHAT?!',
          },
          body: JSON.stringify({
            model: env.OPENROUTER_MODEL,
            max_tokens: 600,
            messages: [{ role: 'system', content: SYSTEM }, ...messages],
          }),
        });
      } catch {
        return json({ error: 'down' }, 502, origin);
      }
      if (!r.ok) return json({ error: 'down' }, 502, origin);

      let data;
      try { data = await r.json(); } catch { return json({ error: 'down' }, 502, origin); }
      let reply = data && data.choices && data.choices[0] && data.choices[0].message
        && data.choices[0].message.content;
      if (typeof reply !== 'string' || !reply.trim()) return json({ error: 'down' }, 502, origin);

      reply = reply.trim();
      if (safety !== 'ok') reply += HELP_BLOCK;
      return json({ reply, safety }, 200, origin);
    }

    return json({ error: 'not_found' }, 404, origin);
  },
};
