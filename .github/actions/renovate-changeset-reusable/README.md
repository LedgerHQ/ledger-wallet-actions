# Renovate changeset

Renovate bumps dependencies but does not write [changesets](https://github.com/changesets/changesets), so a
Renovate PR on a pnpm + changesets monorepo would release nothing. This generates the missing changeset from
the `pnpm-lock.yaml` diff and pushes it back to the Renovate branch.

## Reusable workflow (recommended)

`.github/workflows/renovate-sync-reusable.yml` runs it on Renovate PRs, split for safety:

| Job        | Token                  | Runs branch code                       |
| ---------- | ---------------------- | -------------------------------------- |
| `changes`  | read                   | no: only decides whether to sync       |
| `generate` | read (+ OIDC for JFrog) | yes: mise tools, `install-command` and `command`, after the JFrog login, never with the OIDC variables; the registry credential exists only until `install-command` ends, for the tools that run it |
| `push`     | GitHub App, write      | no: copies expected files, signed commit via GraphQL |

Make it the first job of the PR workflow and gate the rest on `dirty`, since the pushed commit
re-triggers the workflow:

```yaml
jobs:
  renovate-sync:
    if: ${{ !github.event.pull_request.head.repo.fork }}
    permissions:
      contents: read
      id-token: write
    uses: LedgerHQ/ledger-wallet-actions/.github/workflows/renovate-sync-reusable.yml@main
    secrets:
      GH_BOT_APP_ID: ${{ secrets.GH_BOT_APP_ID }}
      GH_BOT_PRIVATE_KEY: ${{ secrets.GH_BOT_PRIVATE_KEY }}

  checks:
    needs: renovate-sync
    # Runs when sync is skipped (forks, pushes), not when it pushed a fix.
    if: ${{ !cancelled() && needs.renovate-sync.outputs.dirty != 'true' }}
    steps:
      # A skipped required check counts as passed, so a failed sync must fail the check instead.
      - if: needs.renovate-sync.result == 'failure'
        run: exit 1
```

The changeset alone needs only git and Node.js: no install, no mise, no dependency code. Repositories with more to
regenerate plug it in through inputs, e.g. ledger-live's Podfile.lock:

```yaml
    with:
      runs-on: ledger-wallet-2cpu-aws-public
      minor-packages: |
        ledger-live-desktop
        live-mobile
      bundled-paths: apps/
      registry: ${{ vars.ARTIFACTORY_URL }}
      install-command: pnpm i --frozen-lockfile --filter="live-mobile..." --ignore-scripts
      command: tools/scripts/renovate-pod-lockfile.sh # sets up Ruby and a fake xcodebuild on Linux
      files: apps/ledger-live-mobile/ios/Podfile.lock
```

`registry` logs in to JFrog, which only accepts Ledger runners: set `runs-on` to one when using it.

## Bump rules

- A workspace package is bumped (`patch`) when its `dependencies` or `optionalDependencies` resolve to a new
  version. `devDependencies` only count for packages under `bundled-paths` (apps ship them).
- `minor-packages` get `minor` instead.
- The root package and packages without `name` + `version` are skipped. `renovate/lock-file-maintenance` gets
  no changeset.

## Action

`.github/actions/renovate-changeset-reusable` only writes `.changeset/<name>.md`, for repositories that wire their own workflow.
See [action.yml](action.yml) for its inputs.
