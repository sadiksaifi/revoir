export interface CompletedCheckEvidence {
  name: string;
  conclusion: string;
  detailsUrl?: string;
  title?: string;
  summary?: string;
  failedActionsLog?: string;
  failedActionsLogUnavailable?: string;
}

export interface GitHubReviewEvidence {
  completedChecks: readonly CompletedCheckEvidence[];
}
