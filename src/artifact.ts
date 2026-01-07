import * as github from '@actions/github';
import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { BundleStats } from './types';

const ARTIFACT_NAME = 'bundle-stats';
const STATS_FILE = 'bundle-stats.json';
const RETRY_COUNT = 3;
const RETRY_BASE_DELAY_MS = 1000;
const MAX_ARTIFACT_SIZE_MB = 50;
const MAX_ARTIFACT_UNZIPPED_MB = 200;

interface ArtifactItem {
  id: number;
  name: string;
  expired?: boolean;
  workflow_run?: {
    head_branch?: string | null;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryOnFail<T>(
  fn: () => Promise<T>,
  operation: string
): Promise<T> {
  for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      if (attempt === RETRY_COUNT - 1) throw error;
      const waitMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      core.warning(
        `${operation} failed, retrying in ${waitMs}ms (${attempt + 1}/${RETRY_COUNT})`
      );
      await sleep(waitMs);
    }
  }
  throw new Error('unreachable');
}

function extractArtifacts(data: unknown): ArtifactItem[] {
  if (data && typeof data === 'object' && 'artifacts' in data) {
    const artifacts = (data as { artifacts?: unknown }).artifacts;
    return Array.isArray(artifacts) ? (artifacts as ArtifactItem[]) : [];
  }
  return Array.isArray(data) ? (data as ArtifactItem[]) : [];
}

function toBuffer(data: unknown): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data);
  throw new Error('Unsupported artifact download response');
}

export async function saveBaselineArtifact(stats: BundleStats): Promise<void> {
  const { DefaultArtifactClient } = await import('@actions/artifact');
  const client = new DefaultArtifactClient();
  const tempDir = process.env.RUNNER_TEMP || '/tmp';
  const filePath = path.join(tempDir, STATS_FILE);

  fs.writeFileSync(filePath, JSON.stringify(stats, null, 2));

  await client.uploadArtifact(ARTIFACT_NAME, [filePath], tempDir, {
    retentionDays: 90,
  });

  core.info('Baseline stats uploaded as artifact');
}

export async function fetchBaselineArtifact(
  token: string
): Promise<BundleStats | null> {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  try {
    const branches = new Set(['main', 'master']);
    let artifact: ArtifactItem | null = null;
    let fallbackArtifact: ArtifactItem | null = null;

    for await (const response of octokit.paginate.iterator(
      octokit.rest.actions.listArtifactsForRepo,
      {
        owner,
        repo,
        per_page: 100,
      }
    )) {
      const artifacts = extractArtifacts(response.data);
      for (const item of artifacts) {
        if (item.name !== ARTIFACT_NAME || item.expired) continue;
        if (!fallbackArtifact) fallbackArtifact = item;
        const headBranch = item.workflow_run?.head_branch;
        if (headBranch && branches.has(headBranch)) {
          artifact = item;
          break;
        }
      }
      if (artifact) break;
    }

    if (!artifact && fallbackArtifact) {
      artifact = fallbackArtifact;
      core.info(
        'Baseline artifact found, but branch metadata missing; using latest artifact.'
      );
    }

    if (!artifact) {
      core.info('No baseline artifact found');
      return null;
    }

    const { data: downloadData } = await retryOnFail(
      () =>
        octokit.rest.actions.downloadArtifact({
          owner,
          repo,
          artifact_id: artifact.id,
          archive_format: 'zip',
          request: {
            responseType: 'arraybuffer',
          },
        }),
      'downloadArtifact'
    );

    const tempDir = process.env.RUNNER_TEMP || '/tmp';
    const zipPath = path.join(tempDir, 'baseline-artifact.zip');
    const extractDir = path.join(tempDir, 'baseline-extracted');

    const zipBuffer = toBuffer(downloadData);

    if (zipBuffer.length === 0) {
      core.warning('Downloaded artifact is empty');
      return null;
    }
    const maxBytes = MAX_ARTIFACT_SIZE_MB * 1024 * 1024;
    if (zipBuffer.length > maxBytes) {
      throw new Error(
        `Artifact is too large (${Math.round(zipBuffer.length / 1024 / 1024)} MB)`
      );
    }

    fs.writeFileSync(zipPath, zipBuffer);

    let zip: AdmZip;
    try {
      zip = new AdmZip(zipPath);

      const entries = zip.getEntries();
      let unzippedBytes = 0;
      for (const entry of entries) {
        const target = path.resolve(extractDir, entry.entryName);
        if (!target.startsWith(extractDir + path.sep)) {
          core.warning(`Skipping path traversal: ${entry.entryName}`);
          continue;
        }

        if (entry.isDirectory) {
          fs.mkdirSync(target, { recursive: true });
          continue;
        }

        const maxUnzippedBytes = MAX_ARTIFACT_UNZIPPED_MB * 1024 * 1024;
        const declaredSize = entry.header?.size;
        if (
          typeof declaredSize === 'number' &&
          unzippedBytes + declaredSize > maxUnzippedBytes
        ) {
          core.warning(
            `Artifact unzipped size exceeds ${MAX_ARTIFACT_UNZIPPED_MB} MB; aborting extraction.`
          );
          return null;
        }

        const entryData = entry.getData();
        const entrySize = declaredSize ?? entryData.length;
        if (unzippedBytes + entrySize > maxUnzippedBytes) {
          core.warning(
            `Artifact unzipped size exceeds ${MAX_ARTIFACT_UNZIPPED_MB} MB; aborting extraction.`
          );
          return null;
        }

        unzippedBytes += entrySize;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entryData);
      }
    } catch (zipError: unknown) {
      const message =
        zipError instanceof Error ? zipError.message : String(zipError);
      core.warning(`Failed to extract artifact zip: ${message}`);
      return null;
    }

    const statsPath = path.join(extractDir, STATS_FILE);

    if (!fs.existsSync(statsPath)) {
      core.warning('bundle-stats.json not found in artifact');
      return null;
    }

    const content = fs.readFileSync(statsPath, 'utf-8');
    const stats = JSON.parse(content) as BundleStats;

    core.info(
      `Baseline loaded: ${stats.totalGzip} bytes gzip from commit ${stats.commit.slice(0, 7)}`
    );

    return stats;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to download baseline: ${message}`);
    return null;
  }
}
