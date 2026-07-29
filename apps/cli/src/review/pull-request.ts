import {
  configuredRepositories,
  type RepositoryIdentity,
  type RevoirConfiguration,
} from "../config/schema.js";

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]+$/u;
const SHA = /^[0-9a-f]{40}$/u;

export interface PullRequestReference {
  owner: string;
  repository: string;
  number: number;
  url: string;
}

export interface PullRequestRepository {
  id: number;
  fullName: string;
  cloneUrl: string;
}

export interface PullRequestSnapshot {
  number: number;
  description?: string;
  state: string;
  draft: boolean;
  authorId: number;
  baseSha: string;
  headSha: string;
  baseRepository: PullRequestRepository;
  headRepository: PullRequestRepository;
}

export class PullRequestUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestUrlError";
  }
}

export class PullRequestEligibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestEligibilityError";
  }
}

export function parsePullRequestUrl(value: string): PullRequestReference {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PullRequestUrlError(
      'Pull request URL must use the canonical form "https://github.com/<owner>/<repository>/pull/<number>".',
    );
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new PullRequestUrlError(
      'Pull request URL must use the canonical form "https://github.com/<owner>/<repository>/pull/<number>".',
    );
  }

  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/u.exec(url.pathname);
  if (match === null) {
    throw new PullRequestUrlError(
      'Pull request URL must use the canonical form "https://github.com/<owner>/<repository>/pull/<number>".',
    );
  }
  const [, owner, repository, number] = match;
  if (
    owner === undefined ||
    repository === undefined ||
    number === undefined ||
    !GITHUB_OWNER.test(owner) ||
    !GITHUB_REPOSITORY.test(repository)
  ) {
    throw new PullRequestUrlError("Pull request URL contains an invalid owner or repository name.");
  }
  const parsedNumber = Number(number);
  if (!Number.isSafeInteger(parsedNumber)) {
    throw new PullRequestUrlError("Pull request number is too large.");
  }

  return {
    owner,
    repository,
    number: parsedNumber,
    url: `https://github.com/${owner}/${repository}/pull/${parsedNumber}`,
  };
}

function configuredRepository(
  reference: PullRequestReference,
  repositories: readonly RepositoryIdentity[],
): RepositoryIdentity | undefined {
  return repositories.find(
    (repository) =>
      repository.owner.toLowerCase() === reference.owner.toLowerCase() &&
      repository.name.toLowerCase() === reference.repository.toLowerCase(),
  );
}

export function assertPullRequestEligible(
  reference: PullRequestReference,
  snapshot: PullRequestSnapshot,
  configuration: RevoirConfiguration["github"],
): RepositoryIdentity {
  const repository = configuredRepository(reference, configuredRepositories(configuration));
  if (repository === undefined) {
    throw new PullRequestEligibilityError(
      `${reference.owner}/${reference.repository} is not in the configured repository allowlist.`,
    );
  }
  if (snapshot.number !== reference.number) {
    throw new PullRequestEligibilityError("GitHub returned a different pull request number.");
  }
  if (snapshot.baseRepository.id !== repository.id) {
    throw new PullRequestEligibilityError(
      "The pull request repository does not match the configured immutable repository identity.",
    );
  }
  if (
    snapshot.baseRepository.fullName.toLowerCase() !==
    `${repository.owner}/${repository.name}`.toLowerCase()
  ) {
    throw new PullRequestEligibilityError(
      "The pull request repository name does not match the configured allowlist.",
    );
  }
  if (snapshot.authorId !== configuration.userId) {
    throw new PullRequestEligibilityError(
      "The pull request author does not match the configured immutable GitHub user.",
    );
  }
  if (snapshot.state !== "open") {
    throw new PullRequestEligibilityError("The pull request is not open.");
  }
  if (snapshot.draft) {
    throw new PullRequestEligibilityError("Draft pull requests are not eligible for review.");
  }
  if (
    snapshot.headRepository.id !== snapshot.baseRepository.id ||
    snapshot.headRepository.fullName.toLowerCase() !==
      snapshot.baseRepository.fullName.toLowerCase()
  ) {
    throw new PullRequestEligibilityError("Fork pull requests are not eligible for review.");
  }
  if (!SHA.test(snapshot.baseSha) || !SHA.test(snapshot.headSha)) {
    throw new PullRequestEligibilityError("GitHub returned an invalid base or head revision.");
  }
  return repository;
}
