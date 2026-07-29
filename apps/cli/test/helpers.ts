import { generateKeyPairSync } from "node:crypto";

import type { ApplicationPaths } from "../src/config/paths.js";
import {
  configuredRepositories,
  createConfiguration,
  type RevoirConfiguration,
} from "../src/config/schema.js";
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
): RevoirConfiguration {
  return createConfiguration({
    github: {
      userId: 42,
      appId: 7,
      privateKey: overrides.privateKey ?? TEST_PRIVATE_KEY,
      installations: [
        {
          id: 8,
          repositories: [{ id: 99, owner: "owner", name: "repository" }],
        },
      ],
    },
    cloudflare: {
      accountId: "account",
      queueId: "queue",
      apiToken: overrides.apiToken ?? "cloudflare-secret-token",
    },
    paths: {
      cacheDir: paths.cacheDir,
      stateDir: paths.stateDir,
      dataDir: paths.dataDir,
    },
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
    async checkGitHub(configuration) {
      return {
        app: `test-app, author test-user (${configuration.userId})`,
        repositories: configuredRepositories(configuration)
          .map((repository) => `${repository.owner}/${repository.name}`)
          .join(", "),
      };
    },
    async checkCloudflare() {
      return "queue test-queue";
    },
  };
}
