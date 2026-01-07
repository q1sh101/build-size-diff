import * as core from '@actions/core';
import * as github from '@actions/github';
import { executeBuild, installDeps } from './build';
import { diffBundles } from './compare';
import { fetchBaselineArtifact, saveBaselineArtifact } from './artifact';
import { scanDirectory } from './scan';
import { BundleStats, DiffResult } from './types';

async function run(): Promise<void> {
  try {
    const distPath = core.getInput('dist-path') || 'dist';
    const gzip = core.getInput('gzip') !== 'false';
    const brotli = core.getInput('brotli') !== 'false';
    const budgetMaxIncreaseKb = readNumberInput('budget-max-increase-kb');
    const warnAboveKb = readNumberInput('warn-above-kb');
    const failAboveKb = readNumberInput('fail-above-kb');
    const buildCommand = core.getInput('build-command') || 'npm run build';
    const timeoutStr = core.getInput('build-timeout-minutes') || '15';
    const timeoutMinutes = parseInt(timeoutStr, 10);
    if (isNaN(timeoutMinutes) || timeoutMinutes <= 0) {
      throw new Error(
        'build-timeout-minutes must be a positive integer (e.g., 30)'
      );
    }
    const allowUnsafeBuild = core.getInput('allow-unsafe-build') === 'true';
    const failOnStderr = core.getInput('fail-on-stderr') === 'true';

    await installDeps();
    await executeBuild(
      buildCommand,
      timeoutMinutes * 60 * 1000,
      failOnStderr,
      allowUnsafeBuild
    );

    const current = await scanDirectory(distPath, gzip, brotli);
    core.info(`Scanned ${current.files.length} files`);

    const githubToken = core.getInput('github-token', { required: true });
    const isPR = !!github.context.payload.pull_request;
    const ref = github.context.ref;
    const isMain = ref === 'refs/heads/main' || ref === 'refs/heads/master';

    if (isMain && !isPR) {
      const baseline = await fetchBaselineArtifact(githubToken);
      await saveBaselineArtifact(current);
      core.info('Baseline updated');
      publishOutputs(current, null, 'baseline-updated');
      return;
    }

    const baseline = await fetchBaselineArtifact(githubToken);
    const diff = diffBundles(
      baseline,
      current,
      budgetMaxIncreaseKb,
      warnAboveKb,
      failAboveKb,
      gzip,
      brotli
    );

    publishOutputs(current, diff, diff.status);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  }
}

function readNumberInput(key: string): number | null {
  const value = core.getInput(key);
  if (!value) return null;
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a number (e.g., 10 or 0.5)`);
  }
  return parsed;
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
