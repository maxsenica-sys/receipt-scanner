// Reads one receipt with Claude. Same request as the Google back end: Sonnet 5.5 at low effort
// (fast), a strict record_receipt tool, server-side fallback if the model declines.
'use strict';
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const { prompt, toolSchema } = require('./logic');

const MODEL = 'claude-sonnet-5-5';

class Retryable extends Error { constructor(m) { super(m); this.retryable = true; } }

function client(apiKey) {
  // The SDK itself retries 429 / 5xx / connection errors twice with backoff.
  return new Anthropic({ apiKey: apiKey, baseURL: process.env.ANTHROPIC_BASE_URL || undefined, maxRetries: 2, timeout: 50000 });
}

// media: { type: 'image'|'document', source: { type: 'base64', media_type, data } }
async function readReceipt(apiKey, media, cats, today) {
  const c = client(apiKey);
  const tool = toolSchema(cats);
  const body = {
    model: MODEL, max_tokens: 8000,
    output_config: { effort: 'low' },
    tools: [tool], tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: [media, { type: 'text', text: prompt(cats, today) }] }]
  };
  // Optional extras: if the API ever rejects one, it is dropped and the call repeated, so a
  // request-format change never loses a receipt.
  let fallbacks = true;
  const optional = { strict: () => { delete tool.strict; }, fallbacks: () => { fallbacks = false; }, output_config: () => { delete body.output_config; } };
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    let out;
    try {
      out = fallbacks
        ? await c.beta.messages.create(Object.assign({}, body, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }))
        : await c.messages.create(body);
    } catch (e) {
      const status = e && e.status;
      if (status === 400) {
        const text = String(e.message || '');
        const named = Object.keys(optional).filter(k => text.indexOf(k) > -1 ||
          (k === 'strict' && /schema/i.test(text)) || (k === 'fallbacks' && /beta/i.test(text)));
        const drop = named.length ? named : Object.keys(optional);
        if (drop.length) { drop.forEach(k => { optional[k](); delete optional[k]; }); last = 'API 400, dropped ' + drop.join(', '); continue; }
        throw new Error('Claude rejected the request: ' + text.slice(0, 200));
      }
      if (status === 401 || status === 403) throw new Error('The Anthropic API key was refused (' + status + '). Check ANTHROPIC_API_KEY in Vercel.');
      // anything else (overloaded, rate limited, network, timeout) is temporary
      throw new Retryable('Claude is unavailable right now (' + (status || (e && e.name) || 'network') + ')');
    }
    if (out.stop_reason === 'refusal') throw new Error('Claude declined to read this image');
    const tu = (out.content || []).find(b => b.type === 'tool_use' && b.name === 'record_receipt');
    if (tu) return tu.input;
    if (out.stop_reason === 'max_tokens') throw new Error('Receipt too long to read in one go - scan it as a long receipt');
    last = 'no receipt data in the reply';
  }
  throw new Retryable('Claude did not return the receipt (' + last + ')');
}

module.exports = { readReceipt, Retryable, MODEL };
