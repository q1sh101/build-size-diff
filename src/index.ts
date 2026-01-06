import * as core from '@actions/core';
import { executeBuild, installDeps } from './build';
import { scanDirectory } from './scan';

async function run(): Promise<void> {
  try {
    const distPath = core.getInput('dist-path') || 'dist';
    const gzip = core.getInput('gzip') !== 'false';
    const brotli = core.getInput('brotli') !== 'false';
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

    core.setOutput('total-size', current.totalSize);
    core.setOutput('total-gzip', current.totalGzip);
    core.setOutput('total-brotli', current.totalBrotli);
    core.setOutput('status', 'pass');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  }
}

run();
