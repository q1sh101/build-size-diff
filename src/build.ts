import * as core from '@actions/core';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function requiresShell(command: string): boolean {
  return /[&|;<>`]|(\$\()|["']/.test(command);
}

export async function executeBuild(
  command: string,
  timeoutMs: number,
  failOnStderr: boolean,
  allowUnsafeShell: boolean
): Promise<void> {
  core.info(`Running build: ${command}`);
  core.info(`Build timeout: ${Math.round(timeoutMs / 60000)} minutes`);

  try {
    const trimmed = command.trim();
    if (!trimmed) {
      throw new Error('Build command is empty');
    }
    if (requiresShell(trimmed)) {
      if (!allowUnsafeShell) {
        throw new Error(
          'Build command requires a shell. Enable allow-unsafe-build to run this command.'
        );
      }
      const { stdout, stderr } = await execAsync(trimmed, {
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, CI: 'true' },
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
      });
      if (stdout) core.info(stdout);
      if (stderr) {
        if (failOnStderr) {
          core.setFailed(
            'Build produced stderr output and fail-on-stderr is enabled.'
          );
          throw new Error('Build produced stderr output');
        }
        core.warning(stderr);
      }
      return;
    }
    const [file, ...args] = trimmed.split(/\s+/);
    const { stdout, stderr } = await execFileAsync(file, args, {
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, CI: 'true' },
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    });

    if (stdout) core.info(stdout);
    if (stderr) {
      if (failOnStderr) {
        core.setFailed(
          'Build produced stderr output and fail-on-stderr is enabled.'
        );
        throw new Error('Build produced stderr output');
      }
      core.warning(stderr);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`Build failed: ${message}`);
    throw error;
  }
}

export async function installDeps(): Promise<void> {
  core.info('Installing dependencies...');

  try {
    const manager = findPackageManager();
    if (manager === 'pnpm') {
      core.info('Detected pnpm, running pnpm install');
      await execFileAsync('pnpm', ['install', '--frozen-lockfile']);
      return;
    }
    if (manager === 'yarn') {
      core.info('Detected yarn, running yarn install');
      await execFileAsync('yarn', ['install', '--frozen-lockfile']);
      return;
    }
    if (manager === 'npm-ci') {
      core.info('Detected npm, running npm ci');
      await execFileAsync('npm', ['ci']);
      return;
    }
    core.info('No lockfile found, running npm install');
    await execFileAsync('npm', ['install']);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`Dependency installation failed: ${message}`);
    throw error;
  }
}

function findPackageManager(): 'pnpm' | 'yarn' | 'npm-ci' | 'npm-install' {
  if (fs.existsSync('pnpm-lock.yaml')) return 'pnpm';
  if (fs.existsSync('yarn.lock')) return 'yarn';
  if (fs.existsSync('package-lock.json')) return 'npm-ci';
  return 'npm-install';
}
