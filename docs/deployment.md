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

References: [Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/)
and [Wrangler configuration for Pages](https://developers.cloudflare.com/pages/functions/wrangler-configuration/).
