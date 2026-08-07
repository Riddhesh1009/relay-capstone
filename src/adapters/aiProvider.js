/**
 * AI provider adapter interface. Every implementation exposes:
 *   generate({ prompt, timeoutMs }) -> { text, tokensPrompt, tokensCompletion }
 *
 * The engine (engine/nodes/ai.js) is written only against this interface, so
 * engine tests can inject a stub/fake without any network calls, and swapping
 * providers (mock -> real model) never touches orchestration code.
 */

const config = require('../config/env');
const { fetchWithTimeout } = require('../lib/timeout');

class MockAiProvider {
  // Talks to scripts/mock_provider.py, an OpenAI-compatible mock LLM.
  async generate({ prompt, timeoutMs }) {
    const res = await fetchWithTimeout(
      `${config.mockProviderUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer mock-local-key',
        },
        body: JSON.stringify({
          model: 'mock-model',
          messages: [{ role: 'user', content: prompt }],
        }),
      },
      timeoutMs,
      'ai provider call'
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`AI provider returned ${res.status}: ${body}`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    return {
      text,
      tokensPrompt: data.usage?.prompt_tokens ?? 0,
      tokensCompletion: data.usage?.completion_tokens ?? 0,
    };
  }
}

class AnthropicProvider {
  async generate({ prompt, timeoutMs }) {
    if (!config.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY not set; cannot use AI_PROVIDER=anthropic');
    }
    const res = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }],
        }),
      },
      timeoutMs,
      'ai provider call'
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`AI provider returned ${res.status}: ${body}`);
    }
    const data = await res.json();
    const text = (data.content || []).map((b) => b.text || '').join('');
    return {
      text,
      tokensPrompt: data.usage?.input_tokens ?? 0,
      tokensCompletion: data.usage?.output_tokens ?? 0,
    };
  }
}

class OpenAiProvider {
  // Uses the standard Chat Completions API (works with gpt-4o-mini, gpt-4o, etc.)
  async generate({ prompt, timeoutMs }) {
    if (!config.openaiApiKey) {
      throw new Error('OPENAI_API_KEY not set; cannot use AI_PROVIDER=openai');
    }
    const res = await fetchWithTimeout(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.openaiApiKey}`,
        },
        body: JSON.stringify({
          model: config.openaiModel,
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }],
        }),
      },
      timeoutMs,
      'ai provider call'
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`AI provider returned ${res.status}: ${body}`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    return {
      text,
      tokensPrompt: data.usage?.prompt_tokens ?? 0,
      tokensCompletion: data.usage?.completion_tokens ?? 0,
    };
  }
}

/** Simple in-memory fake for unit tests - no network at all. */
class FakeAiProvider {
  constructor(responses) {
    // responses: array of strings (JSON-encoded) returned in sequence, or a function(prompt) -> string
    this.responses = responses;
    this.calls = [];
  }
  async generate({ prompt }) {
    this.calls.push(prompt);
    const next = typeof this.responses === 'function'
      ? this.responses(prompt, this.calls.length)
      : this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)];
    return { text: next, tokensPrompt: prompt.length, tokensCompletion: next.length };
  }
}

/**
 * HeuristicProvider: a genuine local classifier, not a canned stub. Reads the
 * *original customer message* out of the prompt (between the "---" fences the
 * seed workflows use) and scores it against small keyword lexicons to fill in
 * whatever the output_schema asks for. It ignores instructions embedded in
 * that message entirely - it never executes text as commands, only scores
 * words against fixed lexicons - which is itself a legitimate (if simple)
 * defense against prompt injection at the classification layer.
 *
 * Why this exists: scripts/mock_provider.py is a generic OpenAI-compatible
 * mock shared with a different capstone (gateway routing/failover testing).
 * It always returns free-text prose ("[alpha:model] Here's a concise
 * answer...") regardless of instructions, so it can never satisfy a JSON
 * output_schema - useful for exercising timeouts/retries/auth, useless for
 * demoing AI branching. This provider fills that gap for demos; AI_PROVIDER
 * still supports 'mock' (mock_provider.py) and 'anthropic' (a real model).
 */
class HeuristicProvider {
  async generate({ prompt, schema }) {
    const message = extractCustomerMessage(prompt);
    const output = fillSchema(schema, message);
    const text = JSON.stringify(output);
    return {
      text,
      tokensPrompt: prompt.split(/\s+/).length,
      tokensCompletion: text.split(/\s+/).length,
    };
  }
}

function extractCustomerMessage(prompt) {
  const match = prompt.match(/---\s*([\s\S]*?)\s*---/);
  return match ? match[1] : prompt;
}

const REFUND_WORDS = ['refund', 'money back', 'return it', "don't want it", 'want my money', 'reimburse'];
const COMPLAINT_WORDS = ['disappointed', 'broken', 'cracked', 'damaged', 'poor', 'unhappy', 'terrible', 'defective'];
// Deliberately NOT scored against these - generic phrasing markers ('?', 'can i',
// 'how do') appear in almost every sentence, including refund requests phrased
// as questions ("Can I get a refund?"). If category detection were symmetric
// max-score voting across all three lists, a message like that would lose to
// "question" 2-1 on marker count alone, even though "refund" is the far more
// decisive word. Since under-classifying a refund request is the exact failure
// this approval gate exists to catch, refund/complaint intent is checked FIRST
// and wins on any match; "question" is only ever the fallback.
const PRIORITY_LEXICON = { high: ['urgent', 'immediately', 'asap', 'angry', 'furious', 'demand'], low: ['just wondering', 'no rush', 'whenever'] };

function classifyCategory(message, enumValues) {
  const lower = message.toLowerCase();
  if (enumValues.includes('refund_request') && REFUND_WORDS.some((w) => lower.includes(w))) return 'refund_request';
  if (enumValues.includes('complaint') && COMPLAINT_WORDS.some((w) => lower.includes(w))) return 'complaint';
  return enumValues.includes('question') ? 'question' : enumValues[0];
}

function scoreLexicon(text, lexicon, fallback) {
  const lower = text.toLowerCase();
  let best = fallback;
  let bestScore = 0;
  for (const [label, words] of Object.entries(lexicon)) {
    const score = words.filter((w) => lower.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = label;
    }
  }
  return best;
}

/** Fills a JSON-schema object with plausible values derived from `message`. */
function fillSchema(schema, message) {
  if (!schema || schema.type !== 'object') return {};
  const out = {};
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    out[key] = fillField(key, spec, message);
  }
  return out;
}

function fillField(key, spec, message) {
  if (spec.enum) {
    if (/categor/i.test(key)) return classifyCategory(message, spec.enum);
    if (/priorit/i.test(key)) return scoreLexicon(message, PRIORITY_LEXICON, 'medium');
    return spec.enum[0];
  }
  if (spec.type === 'string') {
    const maxLen = spec.maxLength || 200;
    const summary = message.trim().replace(/\s+/g, ' ').slice(0, maxLen - 3);
    return summary.length < message.trim().length ? `${summary}...` : summary;
  }
  if (spec.type === 'number' || spec.type === 'integer') return 0;
  if (spec.type === 'boolean') return false;
  if (spec.type === 'array') return [];
  if (spec.type === 'object') return fillSchema(spec, message);
  return null;
}

function getProvider() {
  if (config.aiProvider === 'anthropic') return new AnthropicProvider();
  if (config.aiProvider === 'openai') return new OpenAiProvider();
  if (config.aiProvider === 'mock') return new MockAiProvider();
  return new HeuristicProvider();
}

module.exports = { getProvider, MockAiProvider, AnthropicProvider, OpenAiProvider, HeuristicProvider, FakeAiProvider };