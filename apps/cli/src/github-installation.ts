export interface GitHubInstallationIdentity {
  id: number;
  accountLogin: string;
  targetType: "organization" | "user";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response.`);
  }
  return value as Record<string, unknown>;
}

export function parseGitHubInstallation(value: unknown): GitHubInstallationIdentity {
  const parsed = record(value, "GitHub installation");
  const account = record(parsed.account, "GitHub installation account");
  const targetType =
    typeof parsed.target_type === "string" ? parsed.target_type.toLowerCase() : undefined;
  if (
    !Number.isSafeInteger(parsed.id) ||
    (parsed.id as number) <= 0 ||
    typeof account.login !== "string" ||
    account.login === "" ||
    (targetType !== "organization" && targetType !== "user")
  ) {
    throw new Error("GitHub installation response omitted its immutable identity.");
  }
  return {
    id: parsed.id as number,
    accountLogin: account.login,
    targetType,
  };
}

export function githubInstallationSettingsUrl(candidate: GitHubInstallationIdentity): string {
  return candidate.targetType === "organization"
    ? `https://github.com/organizations/${encodeURIComponent(candidate.accountLogin)}/settings/installations/${candidate.id}`
    : `https://github.com/settings/installations/${candidate.id}`;
}
