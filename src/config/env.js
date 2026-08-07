require('dotenv').config();

function required(name, fallback) {
  const val = process.env[name] ?? fallback;
  if (val === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

module.exports = {
  port: parseInt(process.env.PORT || '8080', 10),
  databaseUrl: required('DATABASE_URL'),
  demoToken: required('DEMO_TOKEN', 'demo-token-123'),
  mockWorldUrl: process.env.MOCK_WORLD_URL || 'http://localhost:9210',
  aiProvider: process.env.AI_PROVIDER || 'mock',
  mockProviderUrl: process.env.MOCK_PROVIDER_URL || 'http://localhost:9211',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  openaiApiKey: process.env.OPENAI_API_KEY || null,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  workerPollMs: parseInt(process.env.WORKER_POLL_MS || '500', 10),
  defaultTimeoutMs: parseInt(process.env.DEFAULT_TIMEOUT_MS || '8000', 10),
};
