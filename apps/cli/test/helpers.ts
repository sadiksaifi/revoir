import { generateKeyPairSync } from "node:crypto";

import type { ApplicationPaths } from "../src/config/paths.js";
import { configuredRepositories, withRepository, type RevoirPolicy } from "../src/config/policy.js";
import { createConfiguration, type RevoirConfiguration } from "../src/config/schema.js";
import type { DiagnosticGateway } from "../src/diagnostics.js";

export const TEST_PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
})
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

export function createTestConfiguration(
  paths: Pick<ApplicationPaths, "cacheDir" | "stateDir" | "dataDir">,
  overrides: {
    privateKey?: string;
    apiToken?: string;
  } = {},
): RevoirConfiguration & { policy: RevoirPolicy } {
  const configuration = createConfiguration({
    github: {
      appId: 7,
      appSlug: "test-app",
      privateKey: overrides.privateKey ?? TEST_PRIVATE_KEY,
      webhookSecret: "test-webhook-secret",
    },
    cloudflare: {
      accountId: "account",
      queueId: "queue",
      queueName: "revoir-review-jobs",
      kvNamespaceId: "kv-namespace",
      workerName: "revoir-relay",
      relayUrl: "https://revoir-relay.example.workers.dev/webhook",
      apiToken: overrides.apiToken ?? "cloudflare-secret-token",
    },
    paths: {
      cacheDir: paths.cacheDir,
      stateDir: paths.stateDir,
      dataDir: paths.dataDir,
    },
  });
  return Object.assign(configuration, {
    policy: withRepository({ version: 1, revision: 0, userId: 42, installations: [] }, 8, {
      id: 99,
      owner: "owner",
      name: "repository",
    }),
  });
}

export function passingGateway(): DiagnosticGateway {
  return {
    async checkRuntime() {
      return "Node.js 24.16.0";
    },
    async checkGit() {
      return "git version 2.50.0";
    },
    async checkPi(model, reasoning) {
      return `${model} (${reasoning}), OpenAI Codex OAuth`;
    },
    async checkGitHub(_configuration, policy) {
      return {
        app: `test-app, author test-user (${policy.userId})`,
        repositories: configuredRepositories(policy)
          .map((repository) => `${repository.owner}/${repository.name}`)
          .join(", "),
      };
    },
    async checkCloudflare() {
      return "queue test-queue";
    },
    async checkPolicy() {
      return "policy revision 1";
    },
  };
}
