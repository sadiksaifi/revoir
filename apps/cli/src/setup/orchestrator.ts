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

export type SetupCloudflareCheckpoint = NonNullable<SetupCheckpoint["resources"]["cloudflare"]>;

export interface SetupGitHubApp {
  appId: number;
  appSlug: string;
  privateKey: string;
  webhookSecret: string;
}

export type SetupGitHubAppIdentity = Pick<SetupGitHubApp, "appId" | "appSlug">;

export interface SetupPlatform {
  ensureGitHubAuthentication(): Promise<{ userId: number; login: string }>;
  ensureWranglerAuthentication(options?: {
    accountId?: string;
    persist?(account: { accountId: string }): Promise<void>;
  }): Promise<{ accountId: string }>;
  ensurePiAuthentication(modelId: string, reasoning: string): Promise<void>;
  ensureCloudflareResources(
    accountId: string,
    setupId: string,
    existing: SetupCloudflareCheckpoint | undefined,
    persist: (resources: SetupCloudflareCheckpoint) => Promise<void>,
  ): Promise<SetupCloudflareResources>;
  deployRelay(resources: SetupCloudflareResources): Promise<string>;
  relayIsCurrent(resources: SetupCloudflareResources, webhookSecret: string): Promise<boolean>;
  configureRelaySecret(resources: SetupCloudflareResources, webhookSecret: string): Promise<void>;
  createGitHubApp(input: {
    conversionCode?: string;
    relayUrl: string;
    state: string;
    persistConversionCode: (code: string) => Promise<void>;
    persist: (app: SetupGitHubApp) => Promise<void>;
  }): Promise<SetupGitHubApp>;
  reconcileGitHubApp(
    configuration: RevoirConfiguration,
    policy: RevoirPolicy,
    persistIdentity?: (identity: SetupGitHubAppIdentity) => Promise<void>,
  ): Promise<SetupGitHubAppIdentity>;
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
        : `Cloudflare account=${cloudflare.accountId}${cloudflare.kvNamespaceId === undefined ? "" : `, KV=${cloudflare.kvNamespaceId}`}${cloudflare.queueId === undefined ? "" : `, Queue=${cloudflare.queueId}`}, Worker=${cloudflare.workerName}`,
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

function samePolicy(left: RevoirPolicy, right: RevoirPolicy): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
    resources: { setupId: randomBytes(8).toString("hex") },
    secrets: {},
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

function assertCloudflareResources(
  value: SetupCloudflareCheckpoint | undefined,
  stage: SetupStage,
): SetupCloudflareResources {
  const resources = assertCheckpointValue(value, "Cloudflare resource identifiers", stage);
  return {
    ...resources,
    kvNamespaceId: assertCheckpointValue(resources.kvNamespaceId, "the KV namespace id", stage),
    queueId: assertCheckpointValue(resources.queueId, "the Queue id", stage),
  };
}

export class EndToEndSetup {
  readonly #platform: SetupPlatform;
  readonly #state: SetupStateStore;
  readonly #defaults: Pick<RevoirConfiguration, "model" | "service" | "timeouts" | "paths">;

  constructor(input: {
    platform: SetupPlatform;
    state: SetupStateStore;
    defaults: Pick<RevoirConfiguration, "model" | "service" | "timeouts" | "paths">;
  }) {
    this.#platform = input.platform;
    this.#state = input.state;
    this.#defaults = input.defaults;
  }

  async run(): Promise<SetupResult> {
    const writeCheckpoint = async (value: SetupCheckpoint): Promise<void> => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await this.#state.write(value);
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    };
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
      const [authenticatedGitHubIdentity, cloudflareIdentity] = await reconcile(
        "prerequisites",
        () =>
          Promise.all([
            this.#platform.ensureGitHubAuthentication(),
            this.#platform.ensureWranglerAuthentication({ accountId: resources.accountId }),
            this.#platform.ensurePiAuthentication(
              finalState.configuration.model.id,
              finalState.configuration.model.reasoning,
            ),
          ]).then(([github, cloudflare]) => [github, cloudflare] as const),
      );
      if (
        authenticatedGitHubIdentity.userId !== finalState.policy.userId ||
        cloudflareIdentity.accountId !== resources.accountId
      ) {
        throw new SetupStageError("prerequisites", reconciliationCheckpoint, {
          cause: new Error("Authenticated GitHub or Cloudflare identity differs from this setup."),
        });
      }
      const relayUrl = await reconcile("relay-deployed", async () => {
        const webhookSecret = finalState.configuration.github.webhookSecret;
        if (!(await this.#platform.relayIsCurrent(resources, webhookSecret))) {
          await this.#platform.configureRelaySecret(resources, webhookSecret);
        }
        return resources.relayUrl;
      });
      let configuration = {
        ...finalState.configuration,
        cloudflare: { ...resources, relayUrl },
      };
      const persistGitHubIdentity = async (identity: SetupGitHubAppIdentity): Promise<void> => {
        if (identity.appId !== configuration.github.appId) {
          throw new Error("GitHub App reconciliation returned a different immutable App id.");
        }
        if (identity.appSlug === configuration.github.appSlug) return;
        configuration = {
          ...configuration,
          github: { ...configuration.github, appSlug: identity.appSlug },
        };
        await this.#state.writeFinal(configuration, finalState.policy);
      };
      const githubIdentity = await reconcile("github-app", () =>
        this.#platform.reconcileGitHubApp(configuration, finalState.policy, persistGitHubIdentity),
      );
      await reconcile("github-app", () => persistGitHubIdentity(githubIdentity));
      const cloudPolicy = await reconcile("local-state", () =>
        this.#platform.getCloudPolicy(configuration.cloudflare),
      );
      const effectivePolicy = intersectPolicies(finalState.policy, cloudPolicy);
      await reconcile("local-state", async () => {
        await this.#state.writeFinal(configuration, effectivePolicy);
        if (!samePolicy(cloudPolicy, effectivePolicy)) {
          await this.#platform.putCloudPolicy(configuration.cloudflare, effectivePolicy);
          await this.#platform.verifyCloudPolicy(configuration.cloudflare, effectivePolicy);
        }
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
      // Persist the setup identity before the first external effect.
      await writeCheckpoint(checkpoint);
    }

    const execute = async (stage: SetupStage, operation: () => Promise<void>): Promise<void> => {
      if (hasStage(checkpoint, stage)) {
        return;
      }
      try {
        await operation();
        checkpoint = markStage(checkpoint, stage);
        await writeCheckpoint(checkpoint);
      } catch (error) {
        throw new SetupStageError(stage, checkpoint, { cause: error });
      }
    };

    let identity: { userId: number; login: string } | undefined;
    let account: { accountId: string } | undefined;
    const prerequisitesCompletedAtStart = hasStage(checkpoint, "prerequisites");
    await execute("prerequisites", async () => {
      const githubIdentity = await this.#platform.ensureGitHubAuthentication();
      const cloudflareAccount = await this.#platform.ensureWranglerAuthentication({
        ...(checkpoint.resources.cloudflareAccountId === undefined
          ? {}
          : { accountId: checkpoint.resources.cloudflareAccountId }),
        async persist(selected) {
          checkpoint = {
            ...checkpoint,
            resources: {
              ...checkpoint.resources,
              cloudflareAccountId: selected.accountId,
            },
          };
          await writeCheckpoint(checkpoint);
        },
      });
      await this.#platform.ensurePiAuthentication(
        this.#defaults.model.id,
        this.#defaults.model.reasoning,
      );
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
      await writeCheckpoint(checkpoint);
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
    if (prerequisitesCompletedAtStart) {
      const [verifiedGitHub, verifiedCloudflare] = await Promise.all([
        this.#platform.ensureGitHubAuthentication(),
        this.#platform.ensureWranglerAuthentication({ accountId: account.accountId }),
        this.#platform.ensurePiAuthentication(
          this.#defaults.model.id,
          this.#defaults.model.reasoning,
        ),
      ]).then(([github, cloudflare]) => [github, cloudflare] as const);
      if (
        verifiedGitHub.userId !== identity.userId ||
        verifiedCloudflare.accountId !== account.accountId
      ) {
        throw new SetupStageError("prerequisites", checkpoint, {
          cause: new Error(
            "Authenticated GitHub or Cloudflare identity differs from the checkpoint.",
          ),
        });
      }
    }

    let cloudflare: SetupCloudflareResources | undefined;
    await execute("cloudflare-resources", async () => {
      const setupId = assertCheckpointValue(
        checkpoint.resources.setupId,
        "the greenfield setup id",
        "cloudflare-resources",
      );
      cloudflare = await this.#platform.ensureCloudflareResources(
        account!.accountId,
        setupId,
        checkpoint.resources.cloudflare,
        async (partial) => {
          checkpoint = {
            ...checkpoint,
            resources: { ...checkpoint.resources, cloudflare: partial },
          };
          await writeCheckpoint(checkpoint);
        },
      );
      checkpoint = {
        ...checkpoint,
        resources: { ...checkpoint.resources, cloudflare },
      };
      await writeCheckpoint(checkpoint);
    });
    cloudflare ??= assertCloudflareResources(
      checkpoint.resources.cloudflare,
      "cloudflare-resources",
    );

    await execute("relay-deployed", async () => {
      const relayUrl = await this.#platform.deployRelay(cloudflare!);
      cloudflare = { ...cloudflare!, relayUrl };
      checkpoint = {
        ...checkpoint,
        resources: { ...checkpoint.resources, cloudflare },
      };
      await writeCheckpoint(checkpoint);
    });
    cloudflare = assertCloudflareResources(checkpoint.resources.cloudflare, "relay-deployed");
    const relayUrl = assertCheckpointValue(
      cloudflare.relayUrl,
      "the deployed relay URL",
      "relay-deployed",
    );

    let github: SetupGitHubApp | undefined;
    await execute("github-app", async () => {
      const persistedGitHub = checkpoint.resources.github;
      const persistedPrivateKey = checkpoint.secrets.githubPrivateKey;
      const persistedWebhookSecret = checkpoint.secrets.githubWebhookSecret;
      if (
        persistedGitHub !== undefined ||
        persistedPrivateKey !== undefined ||
        persistedWebhookSecret !== undefined
      ) {
        github = {
          ...assertCheckpointValue(persistedGitHub, "GitHub App identifiers", "github-app"),
          privateKey: assertCheckpointValue(
            persistedPrivateKey,
            "the GitHub App private key",
            "github-app",
          ),
          webhookSecret: assertCheckpointValue(
            persistedWebhookSecret,
            "the GitHub-generated webhook secret",
            "github-app",
          ),
        };
      } else {
        github = await this.#platform.createGitHubApp({
          ...(checkpoint.secrets.githubManifestCode === undefined
            ? {}
            : { conversionCode: checkpoint.secrets.githubManifestCode }),
          relayUrl,
          state: randomBytes(32).toString("base64url"),
          persistConversionCode: async (code) => {
            checkpoint = {
              ...checkpoint,
              secrets: { ...checkpoint.secrets, githubManifestCode: code },
            };
            await writeCheckpoint(checkpoint);
          },
          persist: async (created) => {
            const { githubManifestCode: _githubManifestCode, ...persistedSecrets } =
              checkpoint.secrets;
            checkpoint = {
              ...checkpoint,
              resources: {
                ...checkpoint.resources,
                github: { appId: created.appId, appSlug: created.appSlug },
              },
              secrets: {
                ...persistedSecrets,
                githubPrivateKey: created.privateKey,
                githubWebhookSecret: created.webhookSecret,
              },
            };
            await writeCheckpoint(checkpoint);
          },
        });
      }
      await this.#platform.configureRelaySecret(cloudflare!, github.webhookSecret);
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
    const webhookSecret = assertCheckpointValue(
      github?.webhookSecret ?? checkpoint.secrets.githubWebhookSecret,
      "the GitHub-generated webhook secret",
      "github-app",
    );

    let queueToken: string | undefined;
    await execute("queue-token", async () => {
      const persisted = checkpoint.secrets.cloudflareQueueApiToken;
      queueToken = persisted ?? (await this.#platform.requestQueueApiToken(cloudflare!));
      if (persisted === undefined) {
        checkpoint = {
          ...checkpoint,
          secrets: { ...checkpoint.secrets, cloudflareQueueApiToken: queueToken },
        };
        await writeCheckpoint(checkpoint);
      }
      try {
        await this.#platform.validateQueueApiToken(cloudflare!, queueToken);
      } catch (error) {
        if (persisted === undefined) throw error;
        queueToken = await this.#platform.requestQueueApiToken(cloudflare!);
        checkpoint = {
          ...checkpoint,
          secrets: { ...checkpoint.secrets, cloudflareQueueApiToken: queueToken },
        };
        await writeCheckpoint(checkpoint);
        await this.#platform.validateQueueApiToken(cloudflare!, queueToken);
      }
    });
    queueToken ??= assertCheckpointValue(
      checkpoint.secrets.cloudflareQueueApiToken,
      "the Cloudflare Queue API token",
      "queue-token",
    );

    const configuration = {
      version: 1,
      model: this.#defaults.model,
      service: this.#defaults.service,
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
