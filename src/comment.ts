import * as github from '@actions/github';
import * as core from '@actions/core';
import { DiffResult, BundleStats } from './types';
import { formatBytes } from './scan';

const COMMENT_MARKER = '<!-- build-size-diff -->';

interface DiffMetrics {
  diffSize: number;
  diffGzip: number;
  diffBrotli: number;
  diffPercentSize: number;
  diffPercentGzip: number;
  diffPercentBrotli: number;
  sizeEmoji: string;
  gzipEmoji: string;
  brotliEmoji: string;
}

function getChangeEmoji(value: number): string {
  if (value > 0) return ':arrow_up_small:';
  if (value < 0) return ':arrow_down_small:';
  return ':white_circle:';
}

function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function calculateDiffMetrics(
  current: BundleStats,
  baseline: BundleStats
): DiffMetrics {
  const diffSize = current.totalSize - baseline.totalSize;
  const diffGzip = current.totalGzip - baseline.totalGzip;
  const diffBrotli = current.totalBrotli - baseline.totalBrotli;
  const diffPercentSize =
    baseline.totalSize > 0 ? (diffSize / baseline.totalSize) * 100 : 0;
  const diffPercentGzip =
    baseline.totalGzip > 0 ? (diffGzip / baseline.totalGzip) * 100 : 0;
  const diffPercentBrotli =
    baseline.totalBrotli > 0 ? (diffBrotli / baseline.totalBrotli) * 100 : 0;

  return {
    diffSize,
    diffGzip,
    diffBrotli,
    diffPercentSize,
    diffPercentGzip,
    diffPercentBrotli,
    sizeEmoji: getChangeEmoji(diffSize),
    gzipEmoji: getChangeEmoji(diffGzip),
    brotliEmoji: getChangeEmoji(diffBrotli),
  };
}

export async function updatePRComment(
  token: string,
  diff: DiffResult,
  mode: 'always' | 'on-increase' | 'never',
  failOnError: boolean
): Promise<void> {
  if (mode === 'never') return;
  if (mode === 'on-increase' && diff.diffMetric <= 0) return;

  const octokit = github.getOctokit(token);
  const context = github.context;

  if (!context.payload.pull_request) {
    core.info('Not a PR, skipping comment');
    return;
  }

  const prNumber = context.payload.pull_request.number;
  const body = buildCommentMarkdown(diff);

  const existingComment = await findOurComment(octokit, context, prNumber);

  try {
    if (existingComment) {
      await octokit.rest.issues.updateComment({
        ...context.repo,
        comment_id: existingComment.id,
        body,
      });
      core.info('Updated existing comment');
    } else {
      await octokit.rest.issues.createComment({
        ...context.repo,
        issue_number: prNumber,
        body,
      });
      core.info('Created new comment');
    }
  } catch (error: unknown) {
    if (failOnError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to post comment: ${message}`);
  }
}

async function findOurComment(
  octokit: ReturnType<typeof github.getOctokit>,
  context: typeof github.context,
  prNumber: number
): Promise<{ id: number } | null> {
  try {
    for await (const response of octokit.paginate.iterator(
      octokit.rest.issues.listComments,
      {
        ...context.repo,
        issue_number: prNumber,
        per_page: 100,
        direction: 'desc',
      }
    )) {
      const existing = response.data.find((c) =>
        c.body?.includes(COMMENT_MARKER)
      );
      if (existing) {
        return { id: existing.id };
      }
    }
    return null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to list comments: ${message}`);
    return null;
  }
}

function buildCommentMarkdown(diff: DiffResult): string {
  const statusEmoji = {
    pass: ':white_check_mark: PASS',
    fail: ':x: FAIL',
    'no-baseline': ':information_source: NO BASELINE',
    'baseline-updated': ':white_check_mark: UPDATED',
  }[diff.status];

  const diffSizeEmoji = getChangeEmoji(diff.diffSize);
  const diffEmoji = getChangeEmoji(diff.diffGzip);
  const diffBrotliEmoji = getChangeEmoji(diff.diffBrotli);

  let body = `${COMMENT_MARKER}
## Bundle Size Report ${statusEmoji}

| Metric | Size | Gzip | Brotli |
|--------|------|------|--------|
| **Total** | ${formatBytes(diff.current.totalSize)} | ${formatBytes(diff.current.totalGzip)} | ${formatBytes(diff.current.totalBrotli)} |
| **Diff** | ${diff.diffSize >= 0 ? '+' : ''}${formatBytes(diff.diffSize)} ${diffSizeEmoji} | ${diff.diffGzip >= 0 ? '+' : ''}${formatBytes(diff.diffGzip)} ${diffEmoji} | ${diff.diffBrotli >= 0 ? '+' : ''}${formatBytes(diff.diffBrotli)} ${diffBrotliEmoji} |
| **Change** | ${formatPercent(diff.diffPercentSize)} | ${formatPercent(diff.diffPercentGzip)} | ${formatPercent(diff.diffPercentBrotli)} |`;

  if (diff.budgetMaxIncreaseKb !== null) {
    const budgetBytes = diff.budgetMaxIncreaseKb * 1024;
    const budgetEmoji =
      diff.diffMetric > budgetBytes ? ':x:' : ':white_check_mark:';
    const sizeCell =
      diff.compareMetric === 'size'
        ? `${formatBytes(budgetBytes)} ${budgetEmoji}`
        : '-';
    const gzipCell =
      diff.compareMetric === 'gzip'
        ? `${formatBytes(budgetBytes)} ${budgetEmoji}`
        : '-';
    const brotliCell =
      diff.compareMetric === 'brotli'
        ? `${formatBytes(budgetBytes)} ${budgetEmoji}`
        : '-';
    body += `\n| **Budget Limit** | ${sizeCell} | ${gzipCell} | ${brotliCell} |`;
  }

  body += '\n';

  if (diff.topChanges.length > 0) {
    body += `
### Top Changes

| File | Before | After | Diff |
|------|--------|-------|------|
`;
    for (const change of diff.topChanges) {
      const changeEmoji = getChangeEmoji(change.diff);
      body += `| \`${change.file}\` | ${formatBytes(change.before)} | ${formatBytes(change.after)} | ${change.diff >= 0 ? '+' : ''}${formatBytes(change.diff)} ${changeEmoji} |\n`;
    }
  }

  if (diff.thresholdMessage) {
    const label =
      diff.thresholdStatus === 'fail' ? ':x: FAIL' : ':warning: WARN';
    body += `\n> ${label} **Threshold:** ${diff.thresholdMessage}\n`;
  }

  if (diff.status === 'fail' && !diff.thresholdMessage) {
    body +=
      '\n> :warning: WARN **Budget exceeded!** Bundle size increased more than the allowed limit.\n';
  }

  if (diff.status === 'no-baseline') {
    body +=
      '\n> :information_source: INFO **No baseline found.** Push to main branch first to create a baseline. Future PRs will show comparisons.\n';
  }

  body += `\n<sub>Generated by build-size-diff Commit: ${diff.current.commit.slice(0, 7)}</sub>`;

  return body;
}

export async function writeJobSummary(
  current: BundleStats,
  baseline: BundleStats | null
): Promise<void> {
  const summary = core.summary;

  summary.addHeading('Bundle Size Report', 2);

  if (!baseline) {
    summary.addRaw(`Baseline created for commit ${current.commit.slice(0, 7)}`);
    summary.addTable([
      [
        { data: 'Metric', header: true },
        { data: 'Size', header: true },
        { data: 'Gzip', header: true },
        { data: 'Brotli', header: true },
      ],
      [
        'Total',
        formatBytes(current.totalSize),
        formatBytes(current.totalGzip),
        formatBytes(current.totalBrotli),
      ],
    ]);
  } else {
    const {
      diffSize,
      diffGzip,
      diffBrotli,
      diffPercentSize,
      diffPercentGzip,
      diffPercentBrotli,
      sizeEmoji,
      gzipEmoji,
      brotliEmoji,
    } = calculateDiffMetrics(current, baseline);

    summary.addTable([
      [
        { data: 'Metric', header: true },
        { data: 'Size', header: true },
        { data: 'Gzip', header: true },
        { data: 'Brotli', header: true },
      ],
      [
        'Total',
        formatBytes(current.totalSize),
        formatBytes(current.totalGzip),
        formatBytes(current.totalBrotli),
      ],
      [
        'Diff',
        `${diffSize >= 0 ? '+' : ''}${formatBytes(diffSize)} ${sizeEmoji}`,
        `${diffGzip >= 0 ? '+' : ''}${formatBytes(diffGzip)} ${gzipEmoji}`,
        `${diffBrotli >= 0 ? '+' : ''}${formatBytes(diffBrotli)} ${brotliEmoji}`,
      ],
      [
        'Change',
        formatPercent(diffPercentSize),
        formatPercent(diffPercentGzip),
        formatPercent(diffPercentBrotli),
      ],
    ]);
  }

  await summary.write();
  core.info('Job summary written');
}
