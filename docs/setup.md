# Set up Revoir

Revoir is a personal macOS review service with two runtime parts:

- an embedded Cloudflare Worker that verifies GitHub webhooks and enqueues review jobs;
- a macOS service that pulls authorized jobs, runs Pi, and publishes GitHub reviews.

The CLI owns the complete greenfield setup. Do not create a relay `.dev.vars` file,
copy numeric GitHub IDs, edit repository JSON in an environment variable, deploy the
Worker by hand, or hand-author the LaunchAgent.

Revoir intentionally has no legacy configuration migration. If an old installation
exists, retire its service, local files, GitHub App, and Cloudflare resources manually.
The CLI never discovers or deletes those resources for you.

## Security boundary

Reviews run repository-provided verification commands through your login shell. They
inherit your user credentials, network access, tool caches, and local service access.
Authorize only repositories whose pull-request code you trust to execute on this Mac.

Repository authorization has three independent gates:

1. the protected local `policy.json` read by the Mac before every job;
2. the protected policy mirrored to Cloudflare KV and read by the relay on every webhook;
3. the repository selection on the relevant GitHub App installation.

A repository is effective only when every gate allows it. Revoir can automatically
propagate a revocation across local and KV policy, but it never silently expands trust
to repair drift. Adding trust always requires `revoir repository add`.

## Prerequisites

- macOS on the review machine;
- Git, GitHub CLI (`gh`), and Cloudflare Wrangler 4 (`wrangler`) on `PATH`;
- a free Cloudflare account;
- ChatGPT Plus or Pro;
- `mise` for building the standalone executable from this repository.

The target Mac needs only the standalone `revoir` executable and the command-line
prerequisites above. Pi and its OpenAI Codex OAuth flow are embedded in Revoir; a
separate global `pi` executable is not required.

Install dependencies and build the standalone executable from a clean checkout on the
same architecture as the target Mac:

```bash
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm --filter cli release:macos
mise exec -- pnpm --filter cli release:macos:install
~/.local/bin/revoir --version
```

For repositories that use mise, trust Revoir's temporary checkout tree:

```bash
mise settings trusted_config_paths='["~/.cache/revoir/checkouts"]'
```

## Run the end-to-end setup

```bash
~/.local/bin/revoir setup
```

Setup is interactive and resumable. It performs these stages in order:

1. verifies GitHub CLI authentication and opens `gh auth login --web` when needed;
2. verifies Wrangler authentication and opens `wrangler login` when needed;
3. verifies the configured Pi model and opens the embedded OpenAI Codex OAuth flow when needed;
4. creates one KV namespace, one Queue, its HTTP pull consumer, and one Worker;
5. deploys the Worker bundled inside the executable;
6. opens GitHub's App Manifest flow and creates one **Any account** GitHub App;
7. opens a Cloudflare token template pre-scoped to the configured account and only
   `Account > Queues > Edit`, then privately prompts for the once-shown token;
8. writes an empty repository policy locally and to KV;
9. installs and starts the per-user LaunchAgent;
10. verifies the relay webhook route, LaunchAgent process health, App/installation
    grants, Queue acknowledgement scope, and local/KV policy equality.

On a new Cloudflare account, Wrangler cannot create the required `workers.dev`
subdomain noninteractively. Revoir opens that account's exact Workers onboarding page;
complete the subdomain setup there, then rerun `revoir setup` to resume at relay deployment.

The GitHub callback listener binds only to a random `127.0.0.1` port and validates a
one-time state value. The generated GitHub private key and webhook secret are persisted
before the browser flow can be considered complete. The webhook secret is an encrypted
Worker secret; it is not stored in Worker variables.

If setup stops, rerun the same command. Its protected checkpoint records completed
stages and created immutable IDs, so it resumes rather than intentionally creating a
second resource. Once setup completes, later `revoir setup` runs reconcile the embedded
Worker, GitHub webhook, local service, and policy without creating another App, KV
namespace, or Queue. Policy reconciliation takes the local/cloud intersection, so it
can preserve revocations but cannot silently authorize a repository.

Setup starts with zero repositories. That is a valid, healthy installation.

## Add a repository

From a checkout with a canonical GitHub `origin`:

```bash
~/.local/bin/revoir repository add
```

Or name it explicitly:

```bash
~/.local/bin/revoir repository add OWNER/REPOSITORY
```

The CLI resolves and stores GitHub's immutable repository and installation IDs. Never
look them up or edit them manually. It supports repositories in your personal account
and organizations that you belong to.

When the App is not installed for the owner, the CLI opens the App installation page
first and waits for GitHub to confirm both the installation and selected repository.
It then writes local policy, writes and verifies KV policy, and finally opens the
existing installation settings if repository access still needs approval.

Cloudflare KV changes are eventually consistent. Revoir keeps the repository
unauthorized while it polls for the exact cloud policy and may wait up to 65 seconds
before either enabling GitHub access or reporting an activation timeout. Rerun the same
command after a timeout; it does not broaden trust from a stale KV read.

Organization approval may outlive the bounded terminal wait. In that case the command
reports `pending`, saves only a protected local pending-operation record, and exits
without claiming authorization. Complete the owner approval in GitHub and rerun the
same `repository add` command.

## Inspect authorization

```bash
~/.local/bin/revoir repository list
~/.local/bin/revoir diagnose
```

`repository list` compares local policy, Cloudflare KV, GitHub installation access, and
pending approvals. Each repository is classified as `authorized`, `pending`,
`drifted`, `inaccessible`, or `github-access-only`.

`diagnose` verifies the runtime, Git, Pi OAuth, GitHub App identity and permissions,
installation repository identities, Queue identity and HTTP pull consumer, Queue token
write access, local/KV policy equality, LaunchAgent, and XDG path safety.

## Remove a repository

```bash
~/.local/bin/revoir repository remove OWNER/REPOSITORY
```

Removal revokes local policy first and KV policy second. Revoir never restores local
trust if the cloud write fails. After both policy gates are revoked, the CLI opens the
GitHub installation settings and waits for repository access to be removed. An
organization-owner delay is reported as pending while Revoir remains revoked.

To revoke Revoir authorization but intentionally retain GitHub App access:

```bash
~/.local/bin/revoir repository remove OWNER/REPOSITORY --keep-github-access
```

## Local files

With default XDG locations, setup writes:

- `~/.config/revoir/config.json`: static GitHub App credentials, Cloudflare immutable
  resource IDs, Queue token, relay URL, model, timeouts, and runtime paths;
- `~/.config/revoir/policy.json`: mutable repository policy mirrored to KV;
- `~/.config/revoir/setup-checkpoint.json`: resumable setup state, removed only
  after setup succeeds;
- `~/.local/state/revoir/pending-repositories.json`: pending GitHub owner approvals;
- `~/.local/state/revoir/`: service logs, locks, and durable review state;
- `~/.cache/revoir/`: temporary review checkouts;
- `~/Library/LaunchAgents/io.github.sadiksaifi.revoir.plist`: generated user service definition.

Configuration, policy, checkpoints, and pending state use protected directories and
`0600` files. Unsafe modes and symlinks are rejected rather than repaired.

## Operations

```bash
~/.local/bin/revoir status
~/.local/bin/revoir logs
~/.local/bin/revoir diagnose
~/.local/bin/revoir stop
~/.local/bin/revoir start
```

`stop` and `uninstall` preserve configuration and XDG data. Revoir does not include a
destructive reset command. Removing old or current local state, uninstalling a GitHub
App, deleting Cloudflare resources, and revoking tokens are deliberate manual actions.
