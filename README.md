# Revoir

Revoir is a personal, single-user code-review service for repositories in your GitHub
account and organizations you belong to. A macOS service receives eligible pull-request
jobs through Cloudflare, runs an embedded Pi agent with OpenAI Codex, and publishes a
GitHub check plus review findings—or a clean result.

It is intentionally not a hosted multi-user product. One installation trusts one
immutable GitHub user identity while allowing that user to opt multiple personal and
organization repositories in or out.

## How it works

```text
GitHub App webhook
        |
        v
Cloudflare Worker -- reads --> Cloudflare KV policy
        |
        v
Cloudflare Queue (HTTP pull)
        |
        v
macOS LaunchAgent -- intersects --> local policy + GitHub installation access
        |
        v
temporary checkout -> Pi / OpenAI Codex -> GitHub check and review
```

The standalone `revoir` executable contains the CLI, the long-running Queue consumer,
the review engine, Pi, and the Worker source used during setup. The per-user macOS
LaunchAgent pulls one Queue message at a time, prepares an isolated temporary checkout,
runs the review, validates the model's structured findings against the authoritative
diff, and reconciles the result on GitHub.

Authorization is deliberately fail-closed. A repository is effective only when all
three gates agree on its immutable repository and installation identity:

1. the protected policy on the Mac;
2. the policy mirrored to Cloudflare KV and checked for every webhook;
3. the repository selected in the corresponding GitHub App installation.

The relay and the Mac both re-check authorization. Missing, stale, malformed, or
disagreeing state does not expand trust. Revocations can narrow local trust
automatically; additions always require an explicit `revoir repository add`.

> [!WARNING]
> Revoir runs repository-provided verification commands through your login shell.
> Reviewed code inherits your user permissions, credentials, network access, tool
> caches, and access to local services. Authorize only repositories and pull-request
> code you trust to execute on this Mac.

## Requirements

For the review machine:

- an Apple-silicon Mac for the documented arm64 standalone build;
- System Git, GitHub CLI (`gh`), and Cloudflare Wrangler 4 (`wrangler`) on `PATH`;
- a GitHub account and permission to install an App in each target owner;
- a Cloudflare account—the free plan is sufficient for the intended personal use;
- ChatGPT Plus or Pro for the embedded OpenAI Codex OAuth flow;
- a browser for GitHub, Cloudflare, and Codex authorization.

For building from source, install `mise`. The standalone executable embeds its Node and
Pi runtime, so the installed service does not require a separate global `node` or `pi`
binary.

## Build and install on macOS arm64

Start from a clean checkout of `main`. The release build deliberately refuses a dirty
worktree and uses the Node and pnpm versions pinned in `.mise.toml`.

```bash
git switch main
git pull --ff-only
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm --filter cli release:macos
mise exec -- pnpm --filter cli release:macos:install
~/.local/bin/revoir --version
```

The build produces a signed, host-native artifact and metadata under
`artifacts/revoir-macos-arm64/`, smoke-tests the standalone Pi runtime, and dry-runs the
embedded Worker bundle. The install step places the executable at
`~/.local/bin/revoir`.

If reviewed repositories use mise, trust Revoir's temporary checkout root:

```bash
mise settings trusted_config_paths='["~/.cache/revoir/checkouts"]'
```

Add `~/.local/bin` to your shell `PATH` if necessary. The remaining examples assume
`revoir` resolves to that executable.

## Greenfield setup

Revoir setup creates a fresh personal installation and starts with zero authorized
repositories:

```bash
revoir setup
```

Setup is interactive, browser-assisted, and resumable. It:

1. verifies `gh` authentication, Wrangler authentication, and embedded Codex OAuth;
2. lets you select the Cloudflare account when Wrangler exposes more than one;
3. creates one KV namespace, one Queue with an HTTP pull consumer, and one Worker;
4. deploys the Worker embedded in the executable;
5. creates a personal **Any account** GitHub App through GitHub's App Manifest flow;
6. opens the App settings so you can confirm that its webhook is active;
7. opens a Cloudflare API-token template limited to the selected account and
   `Account > Queues > Edit`, then privately prompts for that Queue token;
8. writes an empty local/KV repository policy;
9. installs and starts the per-user LaunchAgent;
10. runs end-to-end diagnostics.

The Queue token is intentionally separate from Wrangler authentication. It grants only
the read/write access needed by the local HTTP pull consumer. Do not broaden its scope.

On a brand-new Cloudflare account, Wrangler cannot create the `workers.dev` subdomain
noninteractively. Revoir opens the account's Workers onboarding page. Complete that
page, then run `revoir setup` again; the protected checkpoint resumes at relay
deployment and reuses already-created resource IDs.

The GitHub Manifest callback listens only on a random `127.0.0.1` port and expires after
five minutes. Complete the browser flow while setup is waiting. If setup is interrupted
or an owner approval takes longer, rerun the same command. Once setup succeeds, the
checkpoint is removed; future `revoir setup` runs reconcile the existing installation.

Setup never reads a repository until you authorize one. An empty policy is healthy and
leaves the service inert.

## Authorize repositories

Install the GitHub App with **Only select repositories**, not **All repositories**. Let
`revoir repository add` open the correct personal or organization installation page and
select only the repository you intend to review.

From a checkout with a canonical GitHub `origin`:

```bash
revoir repository add
```

Or provide the owner and repository explicitly:

```bash
revoir repository add OWNER/REPOSITORY
```

The command resolves immutable GitHub IDs; do not look them up or edit policy JSON by
hand. Personal repositories and organization repositories use the same command. An
organization may require an owner to approve installation or repository access. Revoir
saves that operation as `pending`, exits without claiming authorization, and resumes
when you rerun the same command after approval.

Cloudflare KV is eventually consistent. After a policy write, Revoir waits for the
exact policy to remain visible for a 60-second activation window, with a 65-second
deadline. A repository is not reported as authorized before that verification passes.
If the deadline expires, rerun the same add command.

Inspect all three gates with:

```bash
revoir repository list
```

The reported states are:

| Status               | Meaning                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `authorized`         | Local policy, KV policy, GitHub installation, immutable repository identity, and installation ID all agree. |
| `pending`            | A resumable add or removal approval is still recorded.                                                      |
| `drifted`            | Local and cloud identity/policy state do not agree exactly.                                                 |
| `inaccessible`       | Local and KV policy agree, but the configured GitHub installation cannot access the repository.             |
| `github-access-only` | GitHub grants App access, but neither local nor KV policy authorizes reviews.                               |

### Remove a repository

```bash
revoir repository remove OWNER/REPOSITORY
```

Removal durably revokes local authorization first, then KV authorization, before asking
GitHub to remove repository access. A delayed organization approval may remain pending,
but review execution stays revoked.

To revoke Revoir policy while intentionally leaving the App's selected-repository
access unchanged:

```bash
revoir repository remove OWNER/REPOSITORY --keep-github-access
```

## Run reviews

The LaunchAgent normally handles reviews in the background. Automatic review jobs are
accepted for these pull-request actions:

- opened;
- reopened;
- marked ready for review;
- synchronized with a new head commit.

The repository must pass all authorization gates, the pull request must be open and
non-draft, its base and head must be the same repository (fork pull requests are not
eligible), and its author and event sender must match the configured GitHub user.

To request another review, add this exact standalone comment to an eligible pull
request:

```text
@revoirapp review
```

The configured user must author the comment. Extra words do not match the command.

You can also run one review directly:

```bash
revoir review https://github.com/OWNER/REPOSITORY/pull/NUMBER
```

Manual reviews enforce the same repository, author, open/non-draft, and no-fork rules.
Revoir publishes a completed GitHub check and either non-blocking review findings or a
clean result. If the pull-request head changes during review, the stale result is
discarded.

## Operations and diagnostics

```bash
revoir status
revoir diagnose
revoir diagnose --json
revoir logs
revoir stop
revoir start
```

`revoir status` inspects the configuration, executable, generated plist, and LaunchAgent
state, then reports one of:

| State         | Meaning                                                                         |
| ------------- | ------------------------------------------------------------------------------- |
| `healthy`     | launchd reports a running process ID.                                           |
| `starting`    | the job is loaded and launchd is preparing to start it.                         |
| `stopped`     | the generated plist exists, but no worker is running.                           |
| `uninstalled` | the generated plist is absent.                                                  |
| `failed`      | the plist, executable, configuration, exit status, or launchd state is invalid. |

`healthy` and `starting` return success; the other states return a nonzero exit code with
a specific recovery message.

`revoir diagnose` is the complete noninteractive health check. It validates the
standalone runtime, System Git, Codex OAuth, GitHub App identity/events/permissions,
immutable installation and repository identities, Cloudflare Queue and HTTP pull
consumer, Queue-token acknowledgement scope, signed relay path, local/KV policy
equality, repository authorization states, and LaunchAgent health. Every check must
pass for a zero exit code. `--json` provides the same redacted result for scripts.

`revoir logs` prints the structured, redacted service log together with launchd output.
Use `--verbose` on commands for redacted stack traces; secrets remain filtered.

## Configuration and state

Default paths follow XDG conventions:

| Path                                                       | Purpose                                                                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `~/.config/revoir/config.json`                             | GitHub App credentials, Cloudflare resource identities and Queue token, relay URL, model, timeouts, and runtime paths. |
| `~/.config/revoir/policy.json`                             | Repository policy mirrored to Cloudflare KV.                                                                           |
| `~/.config/revoir/setup-checkpoint.json`                   | Temporary resumable setup state; removed after success.                                                                |
| `~/.local/state/revoir/pending-repositories.json`          | Resumable repository approval operations.                                                                              |
| `~/.local/state/revoir/`                                   | Redacted logs, review locks, retry state, and completed request markers.                                               |
| `~/.cache/revoir/checkouts/`                               | Temporary review worktrees.                                                                                            |
| `~/.local/share/revoir/`                                   | Reserved application data directory.                                                                                   |
| `~/Library/LaunchAgents/io.github.sadiksaifi.revoir.plist` | Generated per-user service definition.                                                                                 |

Configuration, policy, checkpoints, and mutable state are private files in private
directories. Revoir rejects unexpected owners, modes, file types, and symlinks rather
than following or repairing them. `config.json` contains credentials: never print it,
commit it, copy it into the repository, or include it in bug reports.

Setup and repository mutations share a command lock. Review execution uses a separate
local process lock so the daemon and a manual review cannot publish concurrently.

## Troubleshooting

- **Setup browser approval expired:** rerun `revoir setup`. Completed stages and resource
  identities are resumed from the checkpoint.
- **Fresh Cloudflare account cannot deploy:** finish the opened Workers onboarding page,
  then rerun `revoir setup`.
- **Repository remains pending:** finish the personal or organization installation
  approval, then rerun the identical `revoir repository add OWNER/REPOSITORY` command.
- **Repository add takes about a minute:** this is the expected KV activation window.
  Let it finish; rerun the command only after an explicit timeout or error.
- **Repository status is drifted or inaccessible:** run `revoir diagnose` for the exact
  failing gate. Revoke or explicitly re-add; do not edit policy files directly.
- **Service is stopped or failed:** run `revoir logs`, correct the reported problem, then
  run `revoir start`. Reinstall the LaunchAgent only when `status` asks for it.
- **A review does not start:** confirm that the repository is `authorized`, the service
  is `healthy`, the PR is open, non-draft, same-repository, and authored by the configured
  user.

## Teardown

Revoir intentionally has no destructive reset command. `revoir uninstall` unloads the
service and removes only its generated LaunchAgent plist; it preserves configuration,
credentials, policies, cache, and state.

For a complete manual teardown:

1. run `revoir uninstall`;
2. verify and remove the personal GitHub App and its personal/organization installations
   in GitHub;
3. verify and remove the Revoir Worker, Queue, HTTP pull consumer, and KV namespace in
   the selected Cloudflare account;
4. revoke the dedicated Queue API token;
5. remove the standalone executable and the Revoir config, state, cache, and data
   directories.

Confirm each target from your own installation before deleting it. Cloudflare and
GitHub resources are not removed by the local uninstall command.

## Development

```bash
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm check
mise exec -- pnpm test
mise exec -- pnpm build
```

Useful focused commands:

```bash
mise exec -- pnpm --filter cli test
mise exec -- pnpm --filter @revoir/relay test
mise exec -- pnpm --filter @revoir/contracts test
mise exec -- pnpm --filter cli release:macos
```

Repository layout:

- `apps/cli`: CLI, setup orchestration, LaunchAgent service, Queue consumer, and review
  engine;
- `apps/relay`: Cloudflare Worker webhook relay;
- `packages/contracts`: strict policy, Queue-job, and finding contracts shared by both
  runtimes;
- `docs`: operational setup documentation;
- `artifacts`: ignored host-native release output.

Before committing, run `pnpm check`, `pnpm test`, and `pnpm build`. The release command
adds standalone packaging, native-architecture validation, smoke tests, and an embedded
Worker dry-run.

## License

[MIT](LICENSE)
