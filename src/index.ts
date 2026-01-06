import * as core from '@actions/core';
import { scanDirectory } from './scan';

async function run(): Promise<void> {
  try {
    const distPath = core.getInput('dist-path') || 'dist';
    const gzip = core.getInput('gzip') !== 'false';
    const brotli = core.getInput('brotli') !== 'false';

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
