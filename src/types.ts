export interface FileStats {
  path: string;
  name: string;
  size: number;
  gzip: number;
  brotli: number;
}

export interface BundleStats {
  files: FileStats[];
  totalSize: number;
  totalGzip: number;
  totalBrotli: number;
  timestamp: string;
  commit: string;
}

export interface DiffResult {
  baseline: BundleStats | null;
  current: BundleStats;
  diffSize: number;
  diffGzip: number;
  diffBrotli: number;
  diffMetric: number;
  diffPercent: number;
  diffPercentGzip: number;
  diffPercentBrotli: number;
  diffPercentSize: number;
  topChanges: Array<{
    file: string;
    before: number;
    after: number;
    diff: number;
  }>;
  compareMetric: 'brotli' | 'gzip' | 'size';
  status: 'pass' | 'fail' | 'no-baseline' | 'baseline-updated';
  worstDeltaKb: number;
  thresholdStatus: 'ok' | 'warn' | 'fail';
  thresholdMessage: string | null;
  budgetMaxIncreaseKb: number | null;
  warnAboveKb: number | null;
  failAboveKb: number | null;
}

export interface ActionInputs {
  buildCommand: string;
  buildTimeoutMs: number;
  allowUnsafeBuild: boolean;
  failOnStderr: boolean;
  distPath: string;
  gzip: boolean;
  brotli: boolean;
  budgetMaxIncreaseKb: number | null;
  warnAboveKb: number | null;
  failAboveKb: number | null;
  commentMode: 'always' | 'on-increase' | 'never';
  failOnCommentError: boolean;
  githubToken: string;
}
