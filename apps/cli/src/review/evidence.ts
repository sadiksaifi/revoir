export interface CompletedCheckEvidence {
  name: string;
  conclusion: string;
  detailsUrl?: string;
  title?: string;
  summary?: string;
  failedActionsLog?: string;
  failedActionsLogUnavailable?: string;
}

export interface DiscussionCommentEvidence {
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface PullRequestReviewEvidence {
  author: string;
  body: string;
  state: string;
  submittedAt?: string;
  url: string;
}

export interface ReviewThreadEvidence {
  id: string;
  isResolved: boolean;
  path: string;
  line?: number;
  originalLine?: number;
  side: string;
  comments: readonly DiscussionCommentEvidence[];
}

export type LinkedArtifactKind = "issue" | "pull-request";

export interface LinkedArtifactEvidence {
  kind: LinkedArtifactKind;
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  comments: readonly DiscussionCommentEvidence[];
  depth: 1 | 2;
  directClosing: boolean;
}

export interface PullRequestDiscussionEvidence {
  comments: readonly DiscussionCommentEvidence[];
  reviews: readonly PullRequestReviewEvidence[];
  threads: readonly ReviewThreadEvidence[];
  linkedArtifacts: readonly LinkedArtifactEvidence[];
}

export interface GitHubReviewEvidence {
  completedChecks: readonly CompletedCheckEvidence[];
  discussion?: PullRequestDiscussionEvidence;
}
