# Set up Revoir

Revoir has two parts:

- a Cloudflare Worker that receives GitHub webhooks and writes jobs to a Queue;
- a macOS CLI that pulls jobs, reviews pull requests, and publishes results.

Use a test repository first. Run all Mac commands as the same non-root user.

## Prerequisites

- macOS on the review machine
- Git and GitHub CLI (`gh`)
- a Cloudflare account
- ChatGPT Plus or Pro
- `mise` for the pinned Node.js and pnpm versions

Authenticate GitHub:

```bash
gh auth login
gh auth status
```

Install the repository tools:

```bash
mise install
mise exec -- pnpm install --frozen-lockfile
```

## 1. Create the local relay configuration

Copy the ignored example:

```bash
cp apps/relay/.dev.vars.example apps/relay/.dev.vars
```

Get your numeric GitHub user ID:

```bash
gh api user --jq '.id'
```

Get the current repository in Revoir's required format:

```bash
gh api 'repos/{owner}/{repo}' \
  --jq '[{id: .id, owner: .owner.login, name: .name}]'
```

For another repository, replace `OWNER/REPOSITORY`:

```bash
gh api repos/OWNER/REPOSITORY \
  --jq '[{id: .id, owner: .owner.login, name: .name}]'
```

Generate a webhook secret:

```bash
openssl rand -hex 32
```

Put the results in `apps/relay/.dev.vars`:

```dotenv
GITHUB_USER_ID="12345678"
GITHUB_REPOSITORIES='[{"id":123456789,"owner":"OWNER","name":"REPOSITORY"}]'
GITHUB_WEBHOOK_SECRET="generated-webhook-secret"
```

Do not commit this file.

## 2. Create and deploy the Cloudflare relay

Authenticate Wrangler and create the Queue:

```bash
pnpm --filter @revoir/relay exec wrangler login
pnpm --filter @revoir/relay exec wrangler queues create revoir-review-jobs
pnpm --filter @revoir/relay exec wrangler queues consumer http add revoir-review-jobs
```

Deploy the user and repository IDs as plain Worker variables, then upload the
webhook secret as an encrypted Worker secret:

```bash
(
  set -a
  source apps/relay/.dev.vars
  set +a

  pnpm --filter @revoir/relay exec wrangler deploy \
    --var "GITHUB_USER_ID:$GITHUB_USER_ID" \
    --var "GITHUB_REPOSITORIES:$GITHUB_REPOSITORIES"

  printf '%s' "$GITHUB_WEBHOOK_SECRET" |
    pnpm --filter @revoir/relay exec wrangler secret put GITHUB_WEBHOOK_SECRET
)
```

Keep the deployment URL printed by Wrangler. The GitHub webhook endpoint is:

```text
https://YOUR-WORKER.workers.dev/github/webhook
```

`keep_vars` in `apps/relay/wrangler.jsonc` preserves the uploaded plain
variables during later deployments.

Create an account-scoped Cloudflare API token for the Mac with:

```text
Account > Queues > Edit
```

Save the token in a local file with mode `0600`. Record the Cloudflare account
ID and Queue ID shown by Wrangler or the Cloudflare API.

## 3. Create the GitHub App

Create a private GitHub App with webhooks enabled.

Set the webhook URL to the Worker endpoint and use the same
`GITHUB_WEBHOOK_SECRET`.

Grant these repository permissions:

- Metadata: read
- Contents: read
- Checks: read
- Actions: read
- Pull requests: read and write

Subscribe only to the **Pull request** event. Install the App only on the
repositories listed in `GITHUB_REPOSITORIES`.

Generate and download a private key for the App. Record:

- GitHub App ID
- GitHub App installation ID
- path to the downloaded private-key PEM

Protect the PEM with mode `0600`.

## 4. Sign in to Pi with OpenAI Codex

Run Pi as the same macOS user that will run Revoir:

```bash
pnpm dlx @earendil-works/pi-coding-agent@0.82.1
```

Inside Pi, run `/login` and select **ChatGPT Plus/Pro (Codex)**. Credentials are
stored in `~/.pi/agent/auth.json`; Revoir must be able to update this file when
OAuth tokens refresh.

## 5. Build and install Revoir

Build from a clean checkout on the same Mac architecture as the target machine:

```bash
mise exec -- pnpm --filter cli release:macos
mise exec -- pnpm --filter cli release:macos:install
```

The executable is installed at:

```text
~/.local/bin/revoir
```

Verify it:

```bash
~/.local/bin/revoir --version
```

## 6. Configure and start the Mac service

Run the guided setup:

```bash
~/.local/bin/revoir setup
```

Provide the GitHub user, repository, App, and installation IDs; the GitHub
private-key file; and the Cloudflare account, Queue, and API-token details.
Accept the default model and timeouts unless you need to change them.

Verify the installation:

```bash
~/.local/bin/revoir diagnose
```

Install and start the per-user LaunchAgent:

```bash
~/.local/bin/revoir install
~/.local/bin/revoir status
~/.local/bin/revoir logs
```

No inbound port, tunnel, or router configuration is required.

## 7. Try a review

Create a non-draft pull request in an allowed repository. It must be authored
from the same repository, not a fork.

Test it manually:

```bash
~/.local/bin/revoir review https://github.com/OWNER/REPOSITORY/pull/NUMBER
```

A clean review adds 👀 while running, then 👍 without posting review text.
Opening, reopening, marking ready, or pushing a new commit also triggers the
automatic webhook flow.
