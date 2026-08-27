import { randomBytes } from "node:crypto";

import { intersectPolicies, type RevoirPolicy } from "../config/policy.js";
import type { RevoirConfiguration } from "../config/schema.js";
import { SETUP_STAGES, type SetupCheckpoint, type SetupStage } from "../config/setup-checkpoint.js";

export interface SetupCloudflareResources {
  accountId: string;
  kvNamespaceId: string;
  queueId: string;
  queueName: string;
  relayUrl?: string;
  workerName: string;
}

export interface SetupGitHubApp {
  appId: number;
  appSlug: string;
  privateKey: string;
}

export interface SetupPlatform {
  ensureGitHubAuthentication(): Promise<{ userId: number; login: string }>;
  ensureWranglerAuthentication(): Promise<{ accountId: string }>;
  ensurePiAuthentication(modelId: string, reasoning: string): Promise<void>;
  ensureCloudflareResources(
    accountId: string,
    existing: SetupCheckpoint["resources"]["cloudflare"],
  ): Promise<SetupCloudflareResources>;
  deployRelay(resources: SetupCloudflareResources, webhookSecret: string): Promise<string>;
  createGitHubApp(input: {
    relayUrl: string;
    state: string;
    webhookSecret: string;
  }): Promise<SetupGitHubApp>;
  reconcileGitHubApp(configuration: RevoirConfiguration, policy: RevoirPolicy): Promise<void>;
  requestQueueApiToken(resources: SetupCloudflareResources): Promise<string>;
  validateQueueApiToken(resources: SetupCloudflareResources, token: string): Promise<void>;
  putCloudPolicy(resources: SetupCloudflareResources, policy: RevoirPolicy): Promise<void>;
  getCloudPolicy(resources: SetupCloudflareResources): Promise<RevoirPolicy>;
  verifyCloudPolicy(resources: SetupCloudflareResources, policy: RevoirPolicy): Promise<void>;
  installService(configuration: RevoirConfiguration): Promise<void>;
  runDiagnostics(configuration: RevoirConfiguration, policy: RevoirPolicy): Promise<void>;
}

export interface SetupStateStore {
  load(): Promise<SetupCheckpoint | undefined>;
  loadFinal?(): Promise<{ configuration: RevoirConfiguration; policy: RevoirPolicy } | undefined>;
  write(checkpoint: SetupCheckpoint): Promise<void>;
  remove(): Promise<void>;
  writeFinal(configuration: RevoirConfiguration, policy: RevoirPolicy): Promise<void>;
}

export interface SetupResult {
  configuration: RevoirConfiguration;
  policy: RevoirPolicy;
  resumed: boolean;
}

export class SetupStageError extends Error {
  readonly checkpoint: SetupCheckpoint;
  readonly stage: SetupStage;

  constructor(stage: SetupStage, checkpoint: SetupCheckpoint, options?: ErrorOptions) {
    const cloudflare = checkpoint.resources.cloudflare;
    const github = checkpoint.resources.github;
    const resources = [
      cloudflare === undefined
        ? undefined
        : `Cloudflare account=${cloudflare.accountId}, KV=${cloudflare.kvNamespaceId}, Queue=${cloudflare.queueId}, Worker=${cloudflare.workerName}`,
      github === undefined ? undefined : `GitHub App=${github.appId} (${github.appSlug})`,
    ].filter((value): value is string => value !== undefined);
    super(
      `Setup stopped during ${stage}.${resources.length === 0 ? "" : ` Created resources: ${resources.join("; ")}.`} Rerun "revoir setup" to resume.`,
      options,
    );
    this.name = "SetupStageError";
    this.stage = stage;
    this.checkpoint = checkpoint;
  }
}

function hasStage(checkpoint: SetupCheckpoint, stage: SetupStage): boolean {
  return checkpoint.completedStages.includes(stage);
}

function markStage(checkpoint: SetupCheckpoint, stage: SetupStage): SetupCheckpoint {
  return {
    ...checkpoint,
    completedStages: [...checkpoint.completedStages, stage],
  };
}

function initialCheckpoint(): SetupCheckpoint {
  return {
    version: 1,
    completedStages: [],
    resources: {},
    secrets: {
      githubWebhookSecret: randomBytes(32).toString("hex"),
    },
  };
}

function assertCheckpointValue<T>(
  value: T | undefined,
  label: string,
  completedStage: SetupStage,
): T {
  if (value === undefined) {
    throw new Error(
      `Setup checkpoint marks ${completedStage} complete but does not contain ${label}. Remove only this incomplete greenfield checkpoint and rerun setup.`,
    );
  }
  return value;
}

export class EndToEndSetup {
  readonly #platform: SetupPlatform;
  readonly #state: SetupStateStore;
  readonly #defaults: Pick<RevoirConfiguration, "model" | "timeouts" | "paths">;

  constructor(input: {
    platform: SetupPlatform;
    state: SetupStateStore;
    defaults: Pick<RevoirConfiguration, "model" | "timeouts" | "paths">;
  }) {
    this.#platform = input.platform;
    this.#state = input.state;
    this.#defaults = input.defaults;
  }

  async run(): Promise<SetupResult> {
    const loaded = await this.#state.load();
    const finalState = loaded === undefined ? await this.#state.loadFinal?.() : undefined;
    if (finalState !== undefined) {
      const resources = finalState.configuration.cloudflare;
      const reconciliationCheckpoint: SetupCheckpoint = {
        version: 1,
        completedStages: SETUP_STAGES.slice(),
        resources: {
          identity: { userId: finalState.policy.userId, login: "configured-user" },
          cloudflareAccountId: resources.accountId,
          cloudflare: resources,
          github: {
            appId: finalState.configuration.github.appId,
            appSlug: finalState.configuration.github.appSlug,
          },
        },
        secrets: {},
      };
      const reconcile = async <T>(stage: SetupStage, operation: () => Promise<T>): Promise<T> => {
        try {
          return await operation();
        } catch (error) {
          throw new SetupStageError(stage, reconciliationCheckpoint, { cause: error });
        }
      };
      const relayUrl = await reconcile("relay-deployed", () =>
        this.#platform.deployRelay(resources, finalState.configuration.github.webhookSecret),
      );
      const configuration = {
        ...finalState.configuration,
        cloudflare: { ...resources, relayUrl },
      };
      await reconcile("github-app", () =>
        this.#platform.reconcileGitHubApp(configuration, finalState.policy),
      );
      const cloudPolicy = await reconcile("local-state", () =>
        this.#platform.getCloudPolicy(configuration.cloudflare),
      );
      const effectivePolicy = intersectPolicies(finalState.policy, cloudPolicy);
      await reconcile("local-state", async () => {
        await this.#state.writeFinal(configuration, effectivePolicy);
        await this.#platform.putCloudPolicy(configuration.cloudflare, effectivePolicy);
        await this.#platform.verifyCloudPolicy(configuration.cloudflare, effectivePolicy);
      });
      await reconcile("service-installed", () => this.#platform.installService(configuration));
      await reconcile("diagnostics", () =>
        this.#platform.runDiagnostics(configuration, effectivePolicy),
      );
      return { configuration, policy: effectivePolicy, resumed: true };
    }
    const resumed = loaded !== undefined;
    let checkpoint = loaded ?? initialCheckpoint();
    if (loaded === undefined) {
      // Persist generated webhook material before the first external effect.
      await this.#state.write(checkpoint);
    }

    const execute = async (stage: SetupStage, operation: () => Promise<void>): Promise<void> => {
      if (hasStage(checkpoint, stage)) {
        return;
      }
      try {
        await operation();
        checkpoint = markStage(checkpoint, stage);
        await this.#state.write(checkpoint);
      } catch (error) {
        throw new SetupStageError(stage, checkpoint, { cause: error });
      }
    };

    let identity: { userId: number; login: string } | undefined;
    let account: { accountId: string } | undefined;
    await execute("prerequisites", async () => {
      const [githubIdentity, cloudflareAccount] = await Promise.all([
        this.#platform.ensureGitHubAuthentication(),
        this.#platform.ensureWranglerAuthentication(),
        this.#platform.ensurePiAuthentication(
          this.#defaults.model.id,
          this.#defaults.model.reasoning,
        ),
      ]);
      identity = githubIdentity;
      account = cloudflareAccount;
      checkpoint = {
        ...checkpoint,
        resources: {
          ...checkpoint.resources,
          identity: githubIdentity,
          cloudflareAccountId: cloudflareAccount.accountId,
        },
      };
      await this.#state.write(checkpoint);
    });
    identity ??= assertCheckpointValue(
      checkpoint.resources.identity,
      "the immutable GitHub identity",
      "prerequisites",
    );
    account ??= {
      accountId: assertCheckpointValue(
        checkpoint.resources.cloudflareAccountId,
        "the Cloudflare account id",
        "prerequisites",
      ),
    };

    let cloudflare: SetupCloudflareResources | undefined;
    await execute("cloudflare-resources", async () => {
      cloudflare = await this.#platform.ensureCloudflareResources(
        account!.accountId,
        checkpoint.resources.cloudflare,
      );
      checkpoint = {
        ...checkpoint,
        resources: { ...checkpoint.resources, cloudflare },
      };
      await this.#state.write(checkpoint);
    });
    cloudflare ??= assertCheckpointValue(
      checkpoint.resources.cloudflare,
      "Cloudflare resource identifiers",
      "cloudflare-resources",
    );

    const webhookSecret = assertCheckpointValue(
      checkpoint.secrets.githubWebhookSecret,
      "the generated webhook secret",
      "relay-deployed",
    );
    await execute("relay-deployed", async () => {
      const relayUrl = await this.#platform.deployRelay(cloudflare!, webhookSecret);
      cloudflare = { ...cloudflare!, relayUrl };
      checkpoint = {
        ...checkpoint,
        resources: { ...checkpoint.resources, cloudflare },
      };
      await this.#state.write(checkpoint);
    });
    cloudflare = assertCheckpointValue(
      checkpoint.resources.cloudflare,
      "the deployed relay URL",
      "relay-deployed",
    );
    const relayUrl = assertCheckpointValue(
      cloudflare.relayUrl,
      "the deployed relay URL",
      "relay-deployed",
    );

    let github: SetupGitHubApp | undefined;
    await execute("github-app", async () => {
      github = await this.#platform.createGitHubApp({
        relayUrl,
        state: randomBytes(32).toString("base64url"),
        webhookSecret,
      });
      checkpoint = {
        ...checkpoint,
        resources: {
          ...checkpoint.resources,
          github: { appId: github.appId, appSlug: github.appSlug },
        },
        secrets: { ...checkpoint.secrets, githubPrivateKey: github.privateKey },
      };
      // The one-time manifest private key is durable before the stage completes.
      await this.#state.write(checkpoint);
    });
    const githubResource = assertCheckpointValue(
      checkpoint.resources.github,
      "GitHub App identifiers",
      "github-app",
    );
    const githubPrivateKey = assertCheckpointValue(
      github?.privateKey ?? checkpoint.secrets.githubPrivateKey,
      "the GitHub App private key",
      "github-app",
    );

    let queueToken: string | undefined;
    await execute("queue-token", async () => {
      queueToken = await this.#platform.requestQueueApiToken(cloudflare!);
      await this.#platform.validateQueueApiToken(cloudflare!, queueToken);
      checkpoint = {
        ...checkpoint,
        secrets: { ...checkpoint.secrets, cloudflareQueueApiToken: queueToken },
      };
      await this.#state.write(checkpoint);
    });
    queueToken ??= assertCheckpointValue(
      checkpoint.secrets.cloudflareQueueApiToken,
      "the Cloudflare Queue API token",
      "queue-token",
    );

    const configuration = {
      version: 1,
      model: this.#defaults.model,
      timeouts: this.#defaults.timeouts,
      paths: this.#defaults.paths,
      github: {
        appId: githubResource.appId,
        appSlug: githubResource.appSlug,
        privateKey: githubPrivateKey,
        webhookSecret,
      },
      cloudflare: {
        ...cloudflare,
        relayUrl,
        apiToken: queueToken,
      },
    } as RevoirConfiguration;
    const policy = {
      version: 1,
      revision: 0,
      userId: identity.userId,
      installations: [],
    } as RevoirPolicy;

    await execute("local-state", async () => {
      await this.#platform.putCloudPolicy(cloudflare!, policy);
      await this.#platform.verifyCloudPolicy(cloudflare!, policy);
      await this.#state.writeFinal(configuration, policy);
    });
    await execute("service-installed", () => this.#platform.installService(configuration));
    await execute("diagnostics", () => this.#platform.runDiagnostics(configuration, policy));
    await this.#state.remove();
    return { configuration, policy, resumed };
  }
}
