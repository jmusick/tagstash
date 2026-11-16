// Default is a deterministic mock. --live is an explicit, billable synthetic evaluation.
import { buildTagRecommendationInput, parseTagRecommendations, TAG_RECOMMENDATION_MODEL } from '../functions/_lib/tagRecommendations.js';
import { recommendationFixtures } from './fixtures/tag-recommendations.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--live', '--mock'].includes(arg)) || (args.includes('--live') && args.includes('--mock'))) {
  throw new Error('Use --mock (default) or --live');
}
const live = args.includes('--live');
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (live && (!/^[a-f0-9]{32}$/.test(account || '') || !token)) {
  throw new Error('Live evaluation requires CLOUDFLARE_ACCOUNT_ID and a Workers AI token in CLOUDFLARE_API_TOKEN');
}
const models = [TAG_RECOMMENDATION_MODEL, '@cf/meta/llama-3.2-3b-instruct'];
console.log(JSON.stringify({ mode: live ? 'live-synthetic' : 'mock', promptVersion: 1 }));
for (const model of models) {
  for (const fixture of recommendationFixtures) {
    const input = buildTagRecommendationInput(fixture.bookmark, fixture.candidates);
    const start = performance.now();
    let result;
    try {
      if (!input.candidates.length) {
        result = { response: { suggestions: [] } };
      } else if (live) {
        // Evaluation CLI only; runtime uses the AI binding adapter, not REST.
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(input.parameters), signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error(`http_${response.status}`);
        const envelope = await response.json();
        if (!envelope.success) throw new Error('provider_failed');
        result = envelope.result;
      } else {
        result = { response: JSON.stringify({ suggestions: fixture.expected }) };
      }
      const suggestions = parseTagRecommendations(result, input.candidates);
      const usage = result?.usage;
      console.log(JSON.stringify({
        model, fixture: fixture.id, ms: Math.round(performance.now() - start),
        skipped: !input.candidates.length, suggestions,
        missing: fixture.expected.filter(name => !suggestions.includes(name)),
        extra: suggestions.filter(name => !fixture.expected.includes(name)),
        // Never print the provider object: only numeric usage fields and synthetic names.
        usage: usage ? Object.fromEntries(Object.entries(usage).filter(([key, value]) =>
          ['prompt_tokens', 'completion_tokens', 'total_tokens'].includes(key) && Number.isFinite(value))) : null,
      }));
    } catch (error) {
      const code = /^http_\d{3}$/.test(error.message) ? error.message
        : error.code || (error.name === 'TimeoutError' ? 'timeout' : 'provider_failed');
      console.log(JSON.stringify({ model, fixture: fixture.id, ms: Math.round(performance.now() - start), error: code }));
      process.exitCode = 1;
    }
  }
}
