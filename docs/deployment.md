# Cloudflare Pages deployment

Configuration checked October 10, 2026 through the authenticated Cloudflare Pages
API, Wrangler, and the GitHub check for the deployed commit. This is a dated check.

| Setting | Expected value |
| --- | --- |
| Git repository | `jmusick/tagstash` (repository ID `1194713067`) |
| Pages project | `tagstash` |
| Production branch | `master` |
| Automatic production deployment | Enabled |
| Build root | Repository root |
| Build command | `npm run build` |
| Build output | `dist` |
| Domains | `tagsta.sh`, `tagstash.pages.dev` |
| D1 binding | `DB` → `tagstash-db`, ID `8ed8b994-49cd-42aa-9175-90c98df15307` |
| Compatibility date | `2026-03-31` |
| Automatic branch previews | Disabled |

The source configuration still records the repository spelling `Tagstash`;
GitHub resolves it to `tagstash`, with the same repository ID. The latest successful
Git push deployment was commit `1416e12769ff81d884e72a3977f397f7943d208a`,
completed October 7, 2026. Its GitHub Cloudflare Pages check succeeded. Local
`master` and `origin/master` matched that commit during this check.

`wrangler.toml` defines the output directory, runtime compatibility date, and D1
binding. Build command, Git branch controls, and domains are managed in Pages.
Production has the expected auth, Stripe, email, and Turnstile variable names;
secret values were not inspected or exported. `SUPPORT_EMAIL` is unset and uses
the code's `support@tagsta.sh` default. Preview has no configured database or
variables and is disabled; configure isolated preview resources before enabling it.

## Before a production release

1. Run `npm run build`, `npm run lint`, and `npm test` on the proposed change.
2. Review D1 migrations separately. Pages deployment does not apply them. Apply
   required migrations in the reviewed order, preserving new-column guards.
3. Push the reviewed release to `master`; verify the Cloudflare Pages check and
   deployed commit hash. There is no separate GitHub Actions website deploy job.
4. Check `/`, `/features`, `/privacy`, `/support`, `/api/health`, `/sitemap.xml`,
   `/robots.txt`, and `/llms.txt`. All returned 200 on October 10.
5. Exercise affected authenticated behavior using the established release workflow.
   Public HTTP checks do not establish email delivery, billing correctness, or
   migration completeness.

Migration `0013_email_token_hashes.sql` invalidates outstanding verification/reset
links; its earlier release record reports application to local and production D1
on October 2. That historical claim was not rechecked against database contents
in this organizational pass.

## Account deletion change (issue #11)

Apply `0018_account_deletion.sql` before using the revised admin delete action.
It adds one nullable `users.deletion_started_at` column without changing existing
accounts. A Worker deployed before the migration refuses deletion with `503`;
ordinary login and checkout continue to work. No production migration or Stripe
operation is performed by the automated tests.

Deletion marks the account pending, blocks its sessions and logins, and removes
its Stripe customer before deleting D1 data. The customer's active subscriptions
stop immediately. A legacy row with only a subscription ID uses immediate
cancellation without proration or a final invoice. This does not issue a refund.
Stripe customer deletion also removes its payment details and prevents new
operations on that customer; historical Stripe records remain retrievable.
See [Stripe customer deletion](https://docs.stripe.com/api/customers/delete)
and [subscription cancellation](https://docs.stripe.com/api/subscriptions/cancel)
(checked October 14, 2026).

If Stripe fails or the D1 cleanup transaction rolls back, retain the pending row
and retry the same admin delete. Billing may already be stopped even when the
request timed out. Do not clear the marker to restore access while that state is
uncertain. Finish pending deletions before rolling back to a Worker without the
session/checkout guards; keep the additive column in place. Public profile cache
purging still runs after successful cleanup and remains best effort with the
existing 60-second staleness bound.

Release verification: run build, lint, and the full test suite. The deletion
regressions mock Stripe and use isolated in-memory D1; they cover billing errors,
timeouts, repeated deletion, cleanup rollback, shared tags, session rejection,
missing migrations, and checkout racing deletion. Self-service deletion and
account reset are outside this change.

Local verification on October 14, 2026: all 193 tests, lint, and production build
passed. The Admin view passed three axe scans (slate, midnight, light) with no
violations; three incomplete results still require human review. A Chromium check
accepted the updated confirmation, deleted the seeded free account through the
real API against isolated local D1, verified the refreshed admin list, and
confirmed that its public profile API returned 404. No live Stripe calls or
production migrations were performed.

Release prerequisite for v1.33.2: applied migration `0018_account_deletion.sql`
to production D1 `tagstash-db` on October 14, 2026, verified the new nullable
`deletion_started_at` column, and confirmed there were no pending migrations.
The migration changes schema only; no live customer or subscription was deleted
as part of verification. Self-service deletion and account reset are tracked
separately in [#153](https://github.com/jmusick/tagstash/issues/153) and
[#154](https://github.com/jmusick/tagstash/issues/154).

References: [Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/)
and [Wrangler configuration for Pages](https://developers.cloudflare.com/pages/functions/wrangler-configuration/).
