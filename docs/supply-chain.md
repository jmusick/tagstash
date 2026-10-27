# Dependency supply-chain safeguards

Settings live in `.npmrc` and `package.json`. They need **npm 11.19 or newer**
(`npm --version`; Node 24.20 ships it). Older npm ignores the `.npmrc` policy keys and
`allowScripts` (npm 10.9.2 printed no warning for them; it warns `EBADDEVENGINES` for
`devEngines`) and still installs correctly from the lockfile.

## What is enforced

| Safeguard | Setting | Behavior verified on npm 11.19.0 |
| --- | --- | --- |
| 7-day resolution cooldown | `.npmrc`: `min-release-age=7` | When npm resolves versions (`install <pkg>`, `update`, `audit fix`), anything published under 7 days ago is skipped. `npm install concurrently@9.2.5` (4 days old) failed with `ETARGET ... date before <today-7d>`; `concurrently@^9` resolved to the older 9.2.4. |
| Reviewed lifecycle scripts | `package.json`: `allowScripts`; `.npmrc`: `strict-allow-scripts=true` | npm blocks dependency install scripts unless listed in `allowScripts`. With strict mode, an unreviewed one fails the install (`ESTRICTALLOWSCRIPTS`, nothing installed) instead of warning. |
| Deterministic installs | `npm ci` | Installs exactly what `package-lock.json` records (with integrity hashes); fails if `package.json` and the lockfile disagree. The cooldown does not re-resolve locked versions. |
| Supported toolchain | `engines.node`, `devEngines` | Node >= 22.13 (built-in SQLite for tests) and npm >= 11.19. `devEngines` uses `onFail: "warn"`, so a mismatch prints a warning and never fails an install. |

## Reviewed script permissions

Both packages with install scripts are explicitly denied (`"esbuild": false`, `"workerd": false`
in `allowScripts`; `fsevents` and `sharp` have none in the current tree). Neither script is
needed:

- `esbuild`'s `postinstall` only swaps the JS launcher for the native binary as a startup
  optimization. The binary arrives through the platform `@esbuild/*` optional dependency,
  so `npm run build` works without it.
- `workerd`'s `postinstall` only validates/relocates the binary. `npm run dev:api` (wrangler)
  starts and serves `/api/health` without it.

Name-only denials apply to every version, so upgrades need no re-review unless the denial
is removed.

## Everyday workflow

```bash
npm ci                 # clean checkout, CI, or after pulling lockfile changes
npm install <pkg>      # add/upgrade (cooldown applies); commit package.json + lockfile
npm audit              # the cooldown does not make already-pinned versions safe
```

Never run `npm install` on a clean checkout just to get dependencies; use `npm ci`.

### CI and automated updates

`.github/workflows/ci.yml` calls SHA-pinned `jmusick/ci` reusable workflows. The baseline
enforces the npm floor and lockfile integrity (public npm registry URLs, SHA-512 hashes
and reviewed `allowScripts` entries), installs without scripts, runs `npm audit`
at the high severity threshold and verifies registry signatures. It also scans the full
Git history with Gitleaks; public pull requests get dependency review, which rejects
moderate-or-higher runtime advisories. The web-app workflow installs normally under
the script policy before running the project checks. **CI gate** requires both to pass.

`.github/dependabot.yml` checks npm and GitHub Actions weekly on Mondays at 06:00 UTC,
including the shared workflow SHA pins. Ordinary updates cool down for seven days
(fourteen for npm majors); security updates are separate. React packages move as one
group, other npm minor/patch updates as another, and actions as one group.

### A new dependency has an install script

`npm install` (strict mode) fails and lists the package. Inspect its script and source in an
isolated place (below), then either `npm deny-scripts <pkg>` (preferred, if the package works
without it) or `npm approve-scripts <pkg>` (writes a version-pinned entry) and commit the
`package.json` change. If an approved package is upgraded, re-review and re-approve.

### A security fix is newer than 7 days

`npm audit fix` keeps the vulnerable version and exits non-zero when the fix is inside the
cooldown. After reading the advisory and the release, either wait, or exempt only that package:

```bash
npm audit fix --min-release-age-exclude=<pkg>
```

(Do not add the exclusion to `.npmrc` permanently.) Record the reason in the PR.

### Rare bypass: inspect a candidate without running its code

Use this when you must look at a very new or suspicious version, or a cooldown/script policy
blocks something you have a reason to proceed with:

```bash
mkdir /tmp/inspect && cd /tmp/inspect   # outside the repo, no secrets in env
npm pack <pkg>@<version> --ignore-scripts
tar -xzf *.tgz                          # read package/package.json "scripts" and the code
# or: npm install <pkg>@<version> --ignore-scripts --min-release-age=0 --no-audit
```

`--ignore-scripts` prevents all lifecycle scripts, and `--min-release-age=0` lifts the cooldown for
that command only. Only after review, make the change in the repo through the normal flow above.
`--dangerously-allow-all-scripts` is not part of this project's workflow.

## Cloudflare Pages

Pages (build image v3) uses Node 22.16 and the npm bundled with it, 10.9.2, per the
[build image docs](https://developers.cloudflare.com/pages/configuration/build-image/). It installs from the
lockfile, then runs `npm run build`. That npm does not know `min-release-age`,
`strict-allow-scripts` or `allowScripts`, so those keys are ignored and
dependency scripts run as they did before. It does not read `engines`/`devEngines` to select
tooling and nothing here sets `engine-strict`, so the npm 11.19 requirement cannot fail the build.
The lockfile is the production control: review lockfile diffs in PRs.
