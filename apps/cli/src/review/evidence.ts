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

export interface LinkedIssueEvidence {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  comments: readonly DiscussionCommentEvidence[];
}

export interface PullRequestDiscussionEvidence {
  comments: readonly DiscussionCommentEvidence[];
  reviews: readonly PullRequestReviewEvidence[];
  threads: readonly ReviewThreadEvidence[];
  linkedIssues: readonly LinkedIssueEvidence[];
}

export interface GitHubReviewEvidence {
  completedChecks: readonly CompletedCheckEvidence[];
  discussion?: PullRequestDiscussionEvidence;
}
