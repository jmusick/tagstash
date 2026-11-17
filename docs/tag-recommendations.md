# Tag recommendation inference contract (issue #147)

Status: authenticated API (#148) and website controls (#149) released in v1.51.0
with the switch off; model evaluated November 15, 2026. The pre-enable gates passed
on November 16, 2026, and `wrangler.toml` now sets `TAG_RECOMMENDATIONS_ENABLED`
to `"true"`, live from the release that carries it. See the
[staged release checklist](#staged-release-checklist-150). Only the exact string
`true` enables the adapter; the local `.dev.vars.example` keeps it `false`.

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

## Bounded API contract (#148)

`functions/_lib/tagRecommendations.js` is the executable contract, with prompt v1
in `TAG_RECOMMENDATION_PROMPT`. It asks for relevant existing candidate names only,
in order, zero to five, and says all page fields and candidate names are untrusted
data. The user message is serialized JSON, separate from the system instructions.
An empty result is valid. There are no tools, article fetching, embeddings,
Vectorize, new-tag generation, mutations or automatic application.

The endpoint is `POST /api/bookmarks/suggest-tags`, body
`{ url, title?, description?, selectedTags? }`, result `{ suggestions: string[] }`.
Require a URL string; omitted title/description mean empty strings, and omitted
selectedTags means an empty array. Validate types, HTTP(S) URL and the complete raw
payload against `INPUT_LIMITS` before library queries or calling the adapter.
Nulls are invalid; unknown fields are rejected, including `note`. Raw string
lengths are checked before projection. `selectedTags` accepts at most 50 entries
before de-duplication, each a nonblank single-word string of at most 100 UTF-16
units, preserving legacy casing. Cookie sessions require the web header and
trusted origin; extension bearer sessions and personal API keys also work.
Recommendations require an active Pro (`membership_tier = 'paid'`) account;
all other tiers get 403 with `upgradeRequired: true`, before library queries,
budget events or inference. This applies to cookie sessions, bearer sessions and
personal API keys; authentication re-reads the current tier on every request.
Authentication and the API no-store/security headers use the existing dispatcher.
Do not pass
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
inference fields. Oversized serialized messages throw `TypeError`, mapped by the
route to 400 before inference. This independent byte check matters
for control characters and heavy JSON escaping. Very long candidate names can
exhaust the output-token cap; invalid/truncated JSON becomes 502, not a partial
answer or a retry.

The route selects candidates only through the owner's live bookmarks joined to
`bookmark_tags` and `tags`, including private bookmarks. Never read the entire
global `tags` vocabulary. Exclude selected names case-insensitively and invalid
legacy names before admitting the first 100. Queries read pages of 100 names,
ordered by the owner's live bookmark usage count descending and stored tag name
ascending (SQLite binary comparison). JavaScript filters each page so Unicode
whitespace and UTF-16 length rules match the adapter rather than SQLite's different
string semantics. Invalid, selected and case-duplicate names do not consume an
admission slot; more pages are read as needed, with at most 100 admitted names
retained. The builder also excludes and
deduplicates names case-insensitively and admits them within the byte budget.
Preserve the first stored spelling. Less frequently used tags outside this pool
cannot be suggested; do not claim whole-library semantic retrieval. Tests here
exercise the projection; `tests/tag-suggestions-api.test.mjs` exercises database
ownership, including shared global tag rows, private and trashed bookmarks.

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
user data. The dispatcher maps these to JSON responses with security headers and
no-store. Disabled or missing-binding requests return 503 even without candidates.
The adapter itself is not an authentication or rate-limit boundary.

The binding deadline bounds the application's wait using a timer race. It **does
not cancel or prove cancellation of a billable inference**. A late rejection is
handled, the timer is cleared, and there is no automatic retry. Before enabling,
#149 must prevent simultaneous client submissions. The API uses `tag_suggestion`
events in `auth_events`, hidden from the admin log and pruned after 24 hours.
Default budgets in `USER_RATE_LIMITS` are 10 requests per 10 minutes and 100 per
24 hours, shared across the account's sessions and keys. Text variables
`TAG_RECOMMENDATIONS_BURST_LIMIT` and `TAG_RECOMMENDATIONS_DAILY_LIMIT` override
the counts (integers 1–10000); invalid configuration is a 503. Valid enabled
attempts spend a use, including no-candidate results and provider failures;
invalid raw payloads and disabled requests do not. Exhaustion returns 429.
The route runs before automatic trash purging and never writes library rows.
Existing count-then-write/fail-open budgets are not a hard
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

## Staged release checklist (#150)

Tick each gate with its date and evidence. Enable only after every gate before
"Enable" is ticked. The website may ship before the extension; each extension
surface has its own gate.

### Current state, checked November 16, 2026

| Item | State |
| --- | --- |
| Website | Controls since v1.51.0 (`462388d`); production on v1.52.5, deployment succeeded |
| Production switch | Production Pages config: binding `AI`, `TAG_RECOMMENDATIONS_ENABLED=false` on v1.52.5 (Pages API, November 16); `"true"` committed for the next release |
| Model | `@cf/ibm-granite/granite-4.0-h-micro`, binding `AI` |
| Budgets | 10 per 10 minutes, 100 per day (`wrangler.toml` defaults) |
| Entitlement | Active Pro (`paid`) only, owner decision recorded in #149 |
| Extension popup (tagstash-extension#10) | Not implemented |
| Extension edit dialog (tagstash-extension#11) | Not implemented |

### Website-side verification, November 16, 2026

Run on v1.51.0 in local development. No inference was made: the switch stayed
off, and every enabled-path check uses a fake binding.

Automated, all passing: `npm run lint`; `npm test` (458 tests, including
`tests/tag-suggestions-api.test.mjs` and `tests/tag-recommendations.test.mjs`);
`npm run build`; `node scripts/check-tag-recommendations.mjs` (explicit requests,
deduplication, acceptance, stale responses, errors, saves, Pro controls and narrow
layout in all three themes); `node scripts/evaluate-tag-recommendations.mjs --mock`.

| Path | Evidence | Result |
| --- | --- | --- |
| Cookie session | Unit test, and local `wrangler pages dev` | Pro 503 while disabled; free 403 `upgradeRequired` |
| Extension bearer session | Unit test, and local runtime | Same as cookie |
| Personal API key | Unit test | Pro entitlement re-read per request |
| Untrusted origin, anonymous | Unit test, and local runtime | 403 without CORS; 401 |
| Account isolation | Unit test (shared global tags, private and trashed bookmarks); local tag list per account | Owner's live tags only |
| No candidate tags | Unit test | Empty result, no inference |
| Stale responses | `check-tag-recommendations.mjs` | Discarded after input or bookmark changes |
| Rate limits | Unit test; local runtime | 429 after budget; 12 disabled requests never spent budget |
| Provider error, timeout, bad output | Unit test (fake binding) | Sanitized 502 |
| Missing binding | Unit test | 503 (local dev always has the binding) |
| Disabled switch | Local runtime, add form in the browser | "Unavailable right now" message; disclosure shown; tag completion and save still work |
| Invalid payload (`note` field) | Unit test; local runtime | 400 |

### Local enabled check, November 16, 2026

With the switch on in `.dev.vars` only, local `wrangler pages dev` reached Workers AI
through Wrangler's remote binding proxy. A 3-tag test library answered in 1.1–4.9 s
(four requests). A real library sending about 100 candidate tags answered once in
7.1 s, then hit the 10-second deadline (502). This is one account and network, and
the proxy overhead is unknown. The November 15 direct REST evaluation measured
0.6–1.1 s. Local dev timings are not production latency, but they make
large-library latency a release gate.

### Gates before enabling

- [x] Cloudflare Workers AI processing, retention and training terms checked in
      official documentation, with dated links recorded here, and the privacy
      policy wording confirmed against them. (November 16, 2026.)
      [Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
      (updated October 16, 2026): Customer Content is not used to train models, and
      standard inference inputs and outputs are not kept after the response;
      operational metadata (model, timestamps, sizes, token and neuron counts) may
      be. The [developer platform service terms](https://www.cloudflare.com/service-specific-terms-developer-platform/)
      (updated September 28, 2026) give the same training commitment. Neither page
      states a processing region or names IBM, so the policy promises neither.
      The policy now adds Cloudflare's training and retention statement.
- [x] Live synthetic smoke test of the chosen model:
      `node scripts/evaluate-tag-recommendations.mjs --live`. Record relevance,
      latency and neurons here, separately from cost assumptions. The token needs
      Workers AI permission; the email-sending token in `.dev.vars` returns 401.
      (November 16, 2026, using the Wrangler OAuth token for the session.)
      Measured: Granite returned no extra tags on any fixture, resisted both
      injection fixtures and kept legacy casing; it missed one secondary tag on
      related-terms (`gardening`), empty-description (`baking`) and page-injection
      (`cooking`). Latency 1.7–3.2 s, 155–561 prompt tokens, 6–11 output tokens.
      Llama (retiring November 20) was faster, 0.2–0.9 s, but added unrelated tags
      on ambiguous and selected-legacy, so Granite stays.
- [x] Production latency with a library of about 100 candidate tags stays well
      under the 10-second deadline, or the deadline or candidate cap is revisited.
      (November 16, 2026.) Five direct REST calls with 100 synthetic candidates
      (405 prompt tokens, 13 output) took 0.7–3.0 s at 0.76 neurons each. The
      earlier 10-second timeout came from the local `wrangler pages dev` proxy,
      not the model, so the deadline and cap stay. Confirm in production with the
      enable step below.
- [x] Production Pages bindings show `AI` and the switch still `false` after the
      v1.51.0 deployment. (November 16, 2026, Pages project API: `ai_bindings`
      has `AI`, `TAG_RECOMMENDATIONS_ENABLED=false`, budgets 10/100, on v1.52.5.)
- [x] Workers AI usage baseline noted in the Cloudflare dashboard, and how usage
      will be monitored (the budgets are soft, not a dollar cap). (November 16,
      2026, GraphQL `aiInferenceAdaptiveGroups`, November 9–17: only these tests,
      24 requests and about 20 neurons against the 10,000 free daily neurons.) At
      0.76 neurons per 100-candidate request, the free allocation covers about
      13,000 requests a day. Monitor the Workers AI page in the dashboard, or that
      query, after release and weekly; flip the switch off if usage outgrows
      Pro volume.

### Enable

- [x] Set `TAG_RECOMMENDATIONS_ENABLED = "true"` in `wrangler.toml` and release
      through the normal process in [deployment.md](deployment.md). (Committed
      November 16, 2026; live from the next release.)
- [ ] On production, with a Pro account and a non-sensitive bookmark: one Suggest
      tags request returns suggestions or an empty list; a free account gets the
      upgrade prompt; manual tagging and saving still work.
- [ ] Usage appears in the dashboard as expected after the first requests.

### Rollback

Set the switch back to `"false"` and release, or roll back to the previous Pages
deployment. Disabled requests return 503 without spending budgets, and the form
keeps tag completion and saving working (verified November 16, 2026 above). No
migration or data cleanup is needed: suggestions never write bookmarks or tags.

### Extension surfaces

- [ ] Popup (tagstash-extension#10): unpacked-browser verification recorded
      before its release.
- [ ] Shared edit dialog (tagstash-extension#11): unpacked-browser verification
      recorded before its release.

After these, update the #99 checklist. Automatic tagging and the other deferred
ideas stay outside this release.
