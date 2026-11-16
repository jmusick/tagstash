# Tag recommendation inference contract (issue #147)

Status: preparation only, evaluated November 15, 2026. No website or extension
request reaches inference yet. `TAG_RECOMMENDATIONS_ENABLED` defaults to the
string `false`; only the exact string `true` enables the adapter. Keep it disabled
until #148 (authentication, validation and budgets), #149 (explicit controls) and
#150 (disclosure and controlled rollout) are ready. This change does not enable
production, change D1, classify real bookmarks or create tags.

## Model decision and measured evaluation

Select `@cf/ibm-granite/granite-4.0-h-micro` for the next implementation stage.
Compare it with `@cf/meta/llama-3.2-3b-instruct`, using the same prompt, JSON schema,
temperature zero and 256 output-token cap. Granite is a small hybrid instruction
model; Llama is a small dense instruction model. The
[Granite model card](https://developers.cloudflare.com/workers-ai/models/granite-4.0-h-micro/)
lists a 131,000-token context and structured response parameters. The
[Llama model card](https://developers.cloudflare.com/workers-ai/models/llama-3.2-3b-instruct/)
announces retirement on November 20, 2026. Llama is a comparison baseline, not a
fallback; do not silently replace a retired or failing model.

One sequential live pass used only the ten synthetic fixtures committed in
`scripts/fixtures/tag-recommendations.mjs`. Nine calls per model were made; the
no-candidates case bypassed inference. The expected tags were authored before
running either model. All eighteen responses passed structural validation with
the requested `json_schema` format. That establishes observed support, not a
guarantee of future schema compliance. Application validation stays mandatory.

| Fixture | Expected tags | Granite suggestions | Llama suggestions |
| --- | --- | --- | --- |
| Clear topic | react, performance | react, performance | react, performance |
| Related terms without keyword overlap | composting, gardening | composting | composting, gardening |
| Ambiguous title, empty description | none | none | programming, travel, cooking |
| Clear title, empty description | baking, bread | bread | bread |
| No candidates | none | none, no call | none, no call |
| Large vocabulary (101 supplied, 100 admitted) | photography, astronomy | photography, astronomy | astronomy, photography |
| Page text attempts instruction override | cooking, pasta | pasta | pasta, cooking |
| Candidate name attempts instruction override | css, web-design | css, web-design | css, web-design |
| Selected tag excluded, legacy case retained | Performance | Performance | Performance, cooking |
| No relevant candidates | none | none | none |

Suggestions above are the independently validated final lists, not raw provider
bodies. Relevance metrics compare sets; order remains the model's relevance order.

| Measurement, nine actual calls each | Granite | Llama |
| --- | ---: | ---: |
| Extra unrelated candidate suggestions | 0 | 4 |
| Missing expected suggestions | 3 | 1 |
| Median elapsed time | 738 ms | 270 ms |
| Minimum–maximum elapsed time | 555–1,115 ms | 147–407 ms |
| Reported input tokens, total | 1,909 | 2,107 |
| Reported output tokens, total | 73 | 120 |
| Estimated compute, neurons | 3.69 | 13.40 |
| Estimated list cost before free allocation | $0.00004063 | $0.00014745 |

Granite's conservative choices, successful empty answers and injection cases are
the reasons for selection. Its lower cost is secondary. It sometimes omits a
broader useful tag (gardening, baking, cooking). Llama was faster and recalled more
expected tags but invented relevance for ambiguous content, and its announced
retirement makes it unsuitable for a new integration.

These are small-sample observations from one account and network location, not
latency percentiles, a security proof or production quality estimates. The large
vocabulary uses many synthetic distractor names, not a realistic library. More
realistic synthetic vocabularies, languages, long names and repeated runs should
be evaluated before rollout. Temperature zero does not guarantee reproducibility.
No credentials or raw production bookmarks are fixtures or evaluation output.

## Bounded contract for #148

`functions/_lib/tagRecommendations.js` is the executable contract, with prompt v1
in `TAG_RECOMMENDATION_PROMPT`. It asks for relevant existing candidate names only,
in order, zero to five, and says all page fields and candidate names are untrusted
data. The user message is serialized JSON, separate from the system instructions.
An empty result is valid. There are no tools, article fetching, embeddings,
Vectorize, new-tag generation, mutations or automatic application.

The next endpoint is `POST /api/bookmarks/suggest-tags`, body
`{ url, title?, description?, selectedTags? }`, result `{ suggestions: string[] }`.
Require a URL string; omitted title/description mean empty strings, and omitted
selectedTags means an empty array. Validate types, HTTP(S) URL and the complete raw
payload against `INPUT_LIMITS` before querying or calling the adapter. Do not pass
notes, cookies, authorization headers, user identifiers or other fields to AI.

| Inference bound | Contract |
| --- | --- |
| URL | First 2,048 JS string code units |
| Title | First 512 code units |
| Description | First 2,000 code units |
| Candidates | At most 100 distinct names, at most 100 code units each, no whitespace |
| Candidate byte budget | 12,000 UTF-8 bytes, counting each JSON-encoded name plus a separator |
| Serialized messages | At most 32,768 UTF-8 bytes, including JSON escaping and instructions |
| Output | At most 5 distinct exact candidate names |
| Generation | Non-streaming, temperature 0, at most 256 output tokens |
| Response wait | 10 seconds, no automatic retries |

Raw bookmark fields are validated first, then projected to these smaller
inference fields. Oversized serialized messages throw `TypeError`: #148 must map
this input failure to 400 before inference. This independent byte check matters
for control characters and heavy JSON escaping. Very long candidate names can
exhaust the output-token cap; invalid/truncated JSON becomes 502, not a partial
answer or a retry.

For #148, select candidates only through the owner's live bookmarks joined to
`bookmark_tags` and `tags`, including private bookmarks. Never read the entire
global `tags` vocabulary. Exclude selected names case-insensitively and invalid
legacy names before the SQL limit, then order by the owner's live bookmark usage
count descending and stored tag name ascending (SQLite binary comparison) and
take at most 100. Pass that stable order to the builder, which also excludes and
deduplicates names case-insensitively and admits them within the byte budget.
Preserve the first stored spelling. Less frequently used tags outside this pool
cannot be suggested; do not claim whole-library semantic retrieval. Tests here
exercise the projection, not database ownership: the endpoint's two-account
isolation tests belong to #148.

The provider schema requests exactly `{ suggestions: string[] }`. The independent
parser accepts a JSON string or object under `response`, or a chat completion's
`choices[0].message.content`. It rejects malformed structures, extra keys,
non-string members, more than 100 proposed members and strings over 8 KiB.
It discards unknown names, preserves exact candidate casing, removes duplicates
and caps the list at five. Selected names were removed from candidates already.
Fenced JSON and prose are errors, not heuristically repaired.

## Adapter, failures and spending controls

The runtime integration uses `env.AI.run`, avoiding a separate REST credential.
`suggestTags` checks the switch and binding before even returning an empty result;
an enabled user with no eligible candidates makes no inference call.
`TagRecommendationError` has a generic message, numeric `status` and safe `code`:

| Condition | Status | Code |
| --- | ---: | --- |
| Disabled or missing AI binding | 503 | unavailable |
| Provider failure | 502 | provider_failed |
| Deadline exceeded | 502 | timeout |
| Malformed output | 502 | invalid_output |

No provider message or cause is retained or logged: provider errors can include
user data. #148 should map these to the dispatcher's JSON responses and retain its
security headers/no-store convention. The adapter is not an authentication or
rate-limit boundary and is deliberately not wired into a route yet.

The binding deadline bounds the application's wait using a timer race. It **does
not cancel or prove cancellation of a billable inference**. A late rejection is
handled, the timer is cleared, and there is no automatic retry. Before enabling,
#148 must add burst/daily soft per-user budgets and #149 must prevent simultaneous
client submissions. Existing count-then-write/fail-open budgets are not a hard
account-wide billing ceiling. Monitor account usage separately.

Cost estimates use the checked
[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/):
Granite $0.017 / million input tokens and $0.112 / million output tokens,
1,542 / 10,158 neurons per million respectively; Llama $0.0509 / $0.335 and
4,625 / 30,475 neurons. A hypothetical Granite request using 2,000 input and 100
output tokens costs about $0.0000452 before allowances (about $0.0452 per thousand
requests); this is an assumption, not a measured maximum. The shared daily free
allocation is 10,000 neurons; paid excess is $0.011 per 1,000 neurons. Existing
Workers Paid does not make all AI usage free. Actual usage and rates can change.

## Repeatable verification

Routine checks make no inference calls:

```sh
node scripts/evaluate-tag-recommendations.mjs --mock
node --test tests/tag-recommendations.test.mjs
npm run lint
npm test
npm run build
```

The evaluation defaults to mock even when credentials exist. Mock results verify
the fixture/contract pipeline, not model quality. All adapter tests supply a fake
binding, including timeout and provider-error cases.

For an intentional live evaluation, supply `CLOUDFLARE_ACCOUNT_ID` and a token
with Workers AI access as `CLOUDFLARE_API_TOKEN` through your local environment,
then run `node scripts/evaluate-tag-recommendations.mjs --live`. Do not put a token
on a command line, in fixtures or in a committed file. The evaluation sends only
committed synthetic examples directly to the fixed Cloudflare REST inference
endpoint, sequentially, with a 10-second fetch deadline and no retries. It does
not change the runtime feature switch or deploy anything. Its CLI REST transport
is separate from the runtime binding adapter. Output is JSON lines containing
fixture IDs, model, timing, validated synthetic tag names, missing/extra expected
tags, numeric usage and sanitized failure codes. A failed request exits nonzero;
relevance differences remain observations for review. Recheck model availability
before rerunning the Llama baseline after its retirement date.

For binding setup and local usage, see [deployment.md](deployment.md).
Cloudflare's [JSON mode guidance](https://developers.cloudflare.com/workers-ai/features/json-mode/)
also warns that schema compliance can fail; always retain independent validation.
