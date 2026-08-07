const Ajv = require('ajv');
const config = require('../../config/env');

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * ai: calls the provider, parses the response as JSON, validates against
 * params.output_schema. On failure, retries ONCE with the validation error
 * appended to the prompt (per node_catalog.json). Still invalid -> step fails.
 *
 * `provider` is injected (see adapters/aiProvider.js) so engine tests can
 * pass a FakeAiProvider with canned responses - no network in unit tests.
 */
async function execute({ params, provider, timeoutMs }) {
  const { prompt, output_schema: schema } = params;
  const validate = ajv.compile(schema);

  let lastText = null;
  let lastErrors = null;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const fullPrompt =
      attempt === 1
        ? withJsonInstruction(prompt, schema)
        : withRetryInstruction(prompt, schema, lastText, lastErrors);

    const { text, tokensPrompt, tokensCompletion } = await provider.generate({
      prompt: fullPrompt,
      schema,
      timeoutMs: timeoutMs || config.defaultTimeoutMs,
    });
    totalPromptTokens += tokensPrompt || 0;
    totalCompletionTokens += tokensCompletion || 0;
    lastText = text;

    let parsed;
    try {
      parsed = extractJson(text);
    } catch (err) {
      lastErrors = [`response was not valid JSON: ${err.message}`];
      continue;
    }

    if (validate(parsed)) {
      return {
        output: parsed,
        tokensPrompt: totalPromptTokens,
        tokensCompletion: totalCompletionTokens,
      };
    }
    lastErrors = (validate.errors || []).map((e) => `${e.instancePath || '(root)'} ${e.message}`);
  }

  const err = new Error(
    `AI output failed schema validation after retry: ${JSON.stringify(lastErrors)}. Last raw response: ${lastText}`
  );
  err.tokensPrompt = totalPromptTokens;
  err.tokensCompletion = totalCompletionTokens;
  throw err;
}

function withJsonInstruction(prompt, schema) {
  return `${prompt}\n\nRespond with ONLY a JSON object matching this schema (no prose, no markdown fences):\n${JSON.stringify(schema)}`;
}

function withRetryInstruction(prompt, schema, lastText, errors) {
  return `${withJsonInstruction(prompt, schema)}\n\nYour previous response was invalid.\nPrevious response: ${lastText}\nValidation errors: ${JSON.stringify(errors)}\nFix these issues and respond with ONLY the corrected JSON object.`;
}

function extractJson(text) {
  const trimmed = text.trim();
  // Strip markdown fences if the model wrapped its answer despite instructions.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(candidate);
}

module.exports = { execute };
