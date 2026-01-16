import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import { isAssetFile } from './utils';

export interface OutputPathResult {
  path: string;
  mode: 'override' | 'auto';
  reason: string;
}

function directoryHasAssets(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Skipping unreadable directory "${dir}": ${message}`);
    return false;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (directoryHasAssets(fullPath)) return true;
    } else if (entry.isFile() && isAssetFile(entry.name)) {
      return true;
    }
  }

  return false;
}

export function locateBuildOutput(
  userProvidedPath: string | undefined,
  repoRoot: string = process.cwd()
): OutputPathResult | null {
  if (userProvidedPath) {
    return {
      path: userProvidedPath,
      mode: 'override',
      reason: 'user specified',
    };
  }

  core.info('No dist-path provided, attempting auto-detection...');

  const commonPaths = ['dist', 'build', 'out', '.next', '.output/public'];
  for (const dirName of commonPaths) {
    const fullPath = path.join(repoRoot, dirName);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      if (!directoryHasAssets(fullPath)) continue;
      return {
        path: dirName,
        mode: 'auto',
        reason: `found existing ${dirName}/ directory`,
      };
    }
  }

  const toolConfigs = [
    { pattern: /^vite\.config\.(js|ts|mjs|cjs)$/, candidate: 'dist' },
    { pattern: /^webpack\.config\.(js|ts|mjs|cjs)$/, candidate: 'dist' },
    { pattern: /^next\.config\.(js|ts|mjs|cjs)$/, candidate: '.next' },
    { pattern: /^nuxt\.config\.(js|ts|mjs|cjs)$/, candidate: '.output/public' },
    { pattern: /^svelte\.config\.(js|ts|mjs|cjs)$/, candidate: 'dist' },
    { pattern: /^astro\.config\.(js|ts|mjs|cjs)$/, candidate: 'dist' },
  ];

  const rootFiles = fs.readdirSync(repoRoot);
  for (const config of toolConfigs) {
    const hasConfig = rootFiles.some((f) => config.pattern.test(f));
    if (hasConfig) {
      const candidatePath = path.join(repoRoot, config.candidate);
      if (
        fs.existsSync(candidatePath) &&
        fs.statSync(candidatePath).isDirectory()
      ) {
        if (!directoryHasAssets(candidatePath)) continue;
        return {
          path: config.candidate,
          mode: 'auto',
          reason: `detected ${config.pattern.source.split('\\.')[0]} project`,
        };
      }
    }
  }

  const monoRepoPaths = ['apps', 'packages'];
  const candidates: string[] = [];

  const safeStatDir = (target: string): fs.Stats | null => {
    try {
      const stat = fs.statSync(target);
      return stat.isDirectory() ? stat : null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(`Skipping unreadable path "${target}": ${message}`);
      return null;
    }
  };

  for (const monoDir of monoRepoPaths) {
    const monoPath = path.join(repoRoot, monoDir);
    if (safeStatDir(monoPath)) {
      let subDirs: string[];
      try {
        subDirs = fs.readdirSync(monoPath);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Skipping unreadable directory "${monoPath}": ${message}`);
        continue;
      }
      for (const subDir of subDirs) {
        const subPath = path.join(monoPath, subDir);
        if (safeStatDir(subPath)) {
          for (const outDir of [
            'dist',
            'build',
            'out',
            '.next',
            '.output/public',
          ]) {
            const outputPath = path.join(subPath, outDir);
            if (safeStatDir(outputPath)) {
              if (!directoryHasAssets(outputPath)) continue;
              candidates.push(path.join(monoDir, subDir, outDir));
            }
          }
        }
      }
    }
  }

  if (candidates.length === 1) {
    return {
      path: candidates[0],
      mode: 'auto',
      reason: 'found single monorepo output directory',
    };
  }

  if (candidates.length > 1) {
    core.warning(
      `Multiple output directories detected: ${candidates.join(', ')}. ` +
        'Please specify dist-path input to choose one.'
    );
    return null;
  }

  core.warning(
    'Could not auto-detect output directory. ' +
      'Please specify dist-path input (e.g., dist, build, out).'
  );
  return null;
}
