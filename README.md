# Revoir

Revoir is a self-hosted pull request review assistant.
It receives GitHub webhooks through Cloudflare Workers and Queues.
Reviews run locally on macOS using OpenAI Codex.

## Development

Install dependencies with `pnpm install`.
Start Revoir with `pnpm --filter @revoir/server start`.
See [`docs/setup.md`](docs/setup.md) for deployment and setup instructions.
