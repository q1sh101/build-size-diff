import * as core from '@actions/core';
import * as github from '@actions/github';
import { ActionInputs, BundleStats, DiffResult } from './types';
import { executeBuild, installDeps } from './build';
import { scanDirectory } from './scan';
import { diffBundles } from './compare';
import { saveBaselineArtifact, fetchBaselineArtifact } from './artifact';
import { updatePRComment, writeJobSummary } from './comment';
import { locateBuildOutput } from './autodetect';

async function run(): Promise<void> {
  try {
    const inputs = readActionInputs();

    const eventName = github.context.eventName;
    if (eventName === 'pull_request_target') {
      core.warning(
        'Running on pull_request_target. Workflow runs from base branch but checks out PR code. ' +
          'Ensure build-command does not execute untrusted scripts from PR. ' +
          'See: https://securitylab.github.com/research/github-actions-preventing-pwn-requests/'
      );
    }
    if (eventName === 'workflow_run') {
      core.warning(
        'Running on workflow_run event. This may have unexpected artifact access permissions. ' +
          'Recommended: Use pull_request trigger for PR workflows.'
      );
    }

    const isPR = !!github.context.payload.pull_request;

    if (isPR && github.context.payload.pull_request) {
      const pr = github.context.payload.pull_request;
      const headRepo = pr.head.repo?.full_name;
      const baseRepo = pr.base.repo?.full_name;

      if (headRepo && baseRepo && headRepo !== baseRepo) {
        core.setFailed(
          'Fork PRs not supported. This action requires "actions: read" permission on base repo. ' +
            'See README for limitations.'
        );
        return;
      }
    }

    const ref = github.context.ref;
    const isMain = getDefaultBranchRefs().includes(ref);

    if (eventName === 'pull_request_target' && !inputs.allowUnsafeBuild) {
      core.setFailed(
        'pull_request_target is disabled by default for safety. ' +
          'Set allow-unsafe-build: true to override if you understand the risks.'
      );
      return;
    }
    if (eventName === 'pull_request_target' && inputs.allowUnsafeBuild) {
      core.warning(
        'allow-unsafe-build is enabled on pull_request_target. ' +
          'Build commands will execute untrusted PR code.'
      );
    }

    await installDeps();
    await executeBuild(
      inputs.buildCommand,
      inputs.buildTimeoutMs,
      inputs.failOnStderr,
      inputs.allowUnsafeBuild
    );

    const current = await scanDirectory(
      inputs.distPath,
      inputs.gzip,
      inputs.brotli
    );
    core.info(`Scanned ${current.files.length} files`);

    if (isMain && !isPR) {
      const baseline = await fetchBaselineArtifact(
        inputs.githubToken,
        getBaselineBranches()
      );
      await saveBaselineArtifact(current);
      await writeJobSummary(current, baseline);
      core.info('Baseline updated');
      publishOutputs(current, null, 'baseline-updated');
      return;
    }

    if (isPR) {
      const baseline = await fetchBaselineArtifact(
        inputs.githubToken,
        getBaselineBranches()
      );
      const diff = diffBundles(
        baseline,
        current,
        inputs.budgetMaxIncreaseKb,
        inputs.warnAboveKb,
        inputs.failAboveKb,
        inputs.gzip,
        inputs.brotli
      );

      await updatePRComment(
        inputs.githubToken,
        diff,
        inputs.commentMode,
        inputs.failOnCommentError
      );
      publishOutputs(current, diff, diff.status);

      if (diff.status === 'fail') {
        if (diff.thresholdStatus === 'fail') {
          core.setFailed(diff.thresholdMessage || 'Size threshold exceeded');
        } else {
          core.setFailed('Bundle size budget exceeded');
        }
      }
      return;
    }

    publishOutputs(current, null, 'pass');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  }
}

function readNumberInput(key: string, errorMessage: string): number | null {
  const value = core.getInput(key);
  if (!value) return null;
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) throw new Error(errorMessage);
  return parsed;
}

function sanitizeNonNegative(value: number | null, key: string): number | null {
  if (value === null) return null;
  if (value < 0) {
    core.warning(`${key} cannot be negative; ignoring.`);
    return null;
  }
  return value;
}

function readActionInputs(): ActionInputs {
  const budgetRaw = readNumberInput(
    'budget-max-increase-kb',
    'budget-max-increase-kb must be a number (e.g., 10 or 0.5)'
  );
  const warnRaw = readNumberInput(
    'warn-above-kb',
    'warn-above-kb must be a number (e.g., 50)'
  );
  const failRaw = readNumberInput(
    'fail-above-kb',
    'fail-above-kb must be a number (e.g., 100)'
  );
  const budget = sanitizeNonNegative(budgetRaw, 'budget-max-increase-kb');
  const warn = sanitizeNonNegative(warnRaw, 'warn-above-kb');
  const fail = sanitizeNonNegative(failRaw, 'fail-above-kb');

  const commentMode = core.getInput('comment-mode') || 'always';
  if (!['always', 'on-increase', 'never'].includes(commentMode)) {
    throw new Error('comment-mode must be: always, on-increase, or never');
  }

  const userProvidedPath = core.getInput('dist-path');
  const outputPath = locateBuildOutput(userProvidedPath);

  if (!outputPath) {
    throw new Error(
      'Could not auto-detect output directory. ' +
        'Please specify dist-path input (e.g., dist, build, out).'
    );
  }

  core.info(`Using output path: ${outputPath.path} (mode: ${outputPath.mode})`);
  if (outputPath.mode === 'auto') {
    core.info(`Auto-detection: ${outputPath.reason}`);
  }

  const timeoutStr = core.getInput('build-timeout-minutes') || '15';
  const timeoutMinutes = parseInt(timeoutStr, 10);
  if (isNaN(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error(
      'build-timeout-minutes must be a positive integer (e.g., 30)'
    );
  }

  const allowUnsafeBuild = core.getInput('allow-unsafe-build') === 'true';
  const failOnStderr = core.getInput('fail-on-stderr') === 'true';
  const failOnCommentError = core.getInput('fail-on-comment-error') === 'true';
  return {
    buildCommand: core.getInput('build-command') || 'npm run build',
    buildTimeoutMs: timeoutMinutes * 60 * 1000,
    allowUnsafeBuild,
    failOnStderr,
    distPath: outputPath.path,
    gzip: core.getInput('gzip') !== 'false',
    brotli: core.getInput('brotli') !== 'false',
    budgetMaxIncreaseKb: budget,
    warnAboveKb: warn,
    failAboveKb: fail,
    commentMode: commentMode as ActionInputs['commentMode'],
    failOnCommentError,
    githubToken: core.getInput('github-token', { required: true }),
  };
}

function getBaselineBranches(): string[] {
  const prBaseRef = github.context.payload.pull_request?.base?.ref;
  if (prBaseRef) return [prBaseRef];
  return getDefaultBranchNames();
}

function getDefaultBranchNames(): string[] {
  const defaultBranch = github.context.payload.repository?.default_branch;
  if (defaultBranch) return [defaultBranch];
  return ['main', 'master'];
}

function getDefaultBranchRefs(): string[] {
  return getDefaultBranchNames().map((name) => `refs/heads/${name}`);
}

function publishOutputs(
  current: BundleStats,
  diff: DiffResult | null,
  status: string
): void {
  core.setOutput('total-size', current.totalSize);
  core.setOutput('total-gzip', current.totalGzip);
  core.setOutput('total-brotli', current.totalBrotli);
  core.setOutput('status', status);
  core.setOutput('diff-size', diff?.diffSize ?? 0);
  core.setOutput('diff-gzip', diff?.diffGzip ?? 0);
  core.setOutput('diff-brotli', diff?.diffBrotli ?? 0);
}

run();
