// ParentFirst — model layer.
//
// Three tiers, each configurable by environment variable:
//   extract  — reads report/prescription images and PDFs      (Sonnet: strong vision, sensible cost)
//   analyse  — deep reasoning: report analysis, second-read     (Opus: where accuracy matters most)
//              verification, whole-person health summary
//   fast     — short explanations, medicine info               (Haiku: quick and cheap)
//
// If a tier's model isn't available on the account, the call falls back to the
// extract model instead of failing, and retries transient errors (429/5xx).

export const MODELS = {
  get extract() { return process.env.AI_MODEL_EXTRACT || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'; },
  get analyse() { return process.env.AI_MODEL_ANALYSE || 'claude-opus-5-5'; },
  get fast() { return process.env.AI_MODEL_FAST || 'claude-haiku-4-5-20251001'; },
};

export function aiEnabled() { return !!process.env.ANTHROPIC_API_KEY; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One model call. Returns the text of the reply.
 * @param {{tier?:'extract'|'analyse'|'fast', content:string|object[], maxTokens?:number, system?:string}} opts
 */
export async function callModel({ tier = 'extract', content, maxTokens = 1024, system } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { const e = new Error('ANTHROPIC_API_KEY is not set'); e.statusCode = 503; throw e; }
  let model = MODELS[tier] || MODELS.extract;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: [{ role: 'user', content: blocks }] }),
    });
    if (res.ok) {
      const data = await res.json();
      return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    }
    const body = (await res.text()).slice(0, 300);
    // model not available on this account → use the extract model rather than fail
    if ((res.status === 404 || (res.status === 400 && /model/i.test(body))) && model !== MODELS.extract) {
      model = MODELS.extract; continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(800 * 2 ** attempt); continue; }
    const e = new Error(`model call failed (${res.status}): ${body}`); e.statusCode = 502; throw e;
  }
  const e = new Error('model call failed after retries'); e.statusCode = 502; throw e;
}

// Pull a JSON object out of a model reply, tolerating code fences and stray prose.
export function parseJSON(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  const e = new Error('model reply was not valid JSON'); e.statusCode = 502; throw e;
}

// A call that must return JSON: one retry with a firmer instruction if it doesn't.
export async function callJSON(opts, call = callModel) {
  const first = await call(opts);
  try { return parseJSON(first); } catch {
    const content = typeof opts.content === 'string'
      ? opts.content + '\n\nReturn ONLY one valid JSON object. No prose, no code fences.'
      : [...opts.content, { type: 'text', text: 'Return ONLY one valid JSON object. No prose, no code fences.' }];
    return parseJSON(await call({ ...opts, content }));
  }
}
