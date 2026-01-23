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
  token: string,
  branches: string[],
  maxPages: number = 10
): Promise<BundleStats | null> {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  try {
    let workflowArtifact: ArtifactItem | null = null;
    try {
      workflowArtifact = await findBaselineArtifactFromWorkflowRuns(
        octokit,
        owner,
        repo,
        branches
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(`Workflow-run lookup failed: ${message}`);
    }
    if (workflowArtifact) {
      const stats = await downloadBaselineArtifact(
        octokit,
        owner,
        repo,
        workflowArtifact.id,
        'workflow-run'
      );
      if (stats) return stats;
      core.warning(
        'Workflow-run baseline download failed; falling back to repo search.'
      );
    }

    const branchSet = new Set(branches);
    let artifact: ArtifactItem | null = null;
    let pageCount = 0;
    let totalArtifactsChecked = 0;

    core.info(
      `Searching for baseline artifact (max ${maxPages} pages, ${maxPages * 100} artifacts)`
    );

    for await (const response of octokit.paginate.iterator(
      octokit.rest.actions.listArtifactsForRepo,
      {
        owner,
        repo,
        per_page: 100,
      }
    )) {
      pageCount++;
      const artifacts = extractArtifacts(response.data);
      totalArtifactsChecked += artifacts.length;

      for (const item of artifacts) {
        if (item.name !== ARTIFACT_NAME || item.expired) continue;
        const headBranch = item.workflow_run?.head_branch;
        if (headBranch && branchSet.has(headBranch)) {
          artifact = item;
          break;
        }
      }

      if (artifact) {
        core.info(
          `Found baseline artifact after checking ${totalArtifactsChecked} artifacts (${pageCount} pages)`
        );
        break;
      }

      if (pageCount >= maxPages) {
        core.warning(
          `Reached max artifact search limit (${maxPages} pages, ${totalArtifactsChecked} artifacts checked). ` +
            `No baseline found for branches: ${branches.join(', ')}. ` +
            `Increase max-artifact-pages if your baseline is older. ` +
            `Current repository has at least ${totalArtifactsChecked} artifacts - consider reducing artifact retention.`
        );
        return null;
      }
    }

    if (!artifact) {
      core.info(
        `No baseline artifact found for ${branches.join(', ')} after checking ${totalArtifactsChecked} artifacts (${pageCount} pages)`
      );
      return null;
    }

    return await downloadBaselineArtifact(
      octokit,
      owner,
      repo,
      artifact.id,
      'repo-pagination'
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to download baseline: ${message}`);
    return null;
  }
}

async function findBaselineArtifactFromWorkflowRuns(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  branches: string[]
): Promise<ArtifactItem | null> {
  const workflowId = await resolveWorkflowId(octokit, owner, repo);
  if (!workflowId) return null;

  for (const branch of branches) {
    const runs = await retryOnFail(
      () =>
        octokit.rest.actions.listWorkflowRuns({
          owner,
          repo,
          workflow_id: workflowId,
          branch,
          per_page: 20,
        }),
      'listWorkflowRuns'
    );
    const workflowRuns = runs.data.workflow_runs ?? [];
    if (workflowRuns.length === 0) continue;

    for (const run of workflowRuns) {
      const artifactsResponse = await retryOnFail(
        () =>
          octokit.rest.actions.listWorkflowRunArtifacts({
            owner,
            repo,
            run_id: run.id,
            per_page: 100,
          }),
        'listWorkflowRunArtifacts'
      );
      const artifacts = extractArtifacts(artifactsResponse.data);
      for (const item of artifacts) {
        if (item.name === ARTIFACT_NAME && !item.expired) {
          core.info(
            `Found baseline artifact in workflow run ${run.id} (${branch})`
          );
          return item;
        }
      }
    }
  }

  return null;
}

async function resolveWorkflowId(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string
): Promise<number | null> {
  const workflowFile = getWorkflowFileFromRef();
  if (workflowFile) {
    try {
      const workflow = await retryOnFail(
        () =>
          octokit.rest.actions.getWorkflow({
            owner,
            repo,
            workflow_id: workflowFile,
          }),
        'getWorkflow'
      );
      return workflow.data.id;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(`Failed to resolve workflow from ref: ${message}`);
    }
  }

  const workflows = await retryOnFail(
    () =>
      octokit.rest.actions.listRepoWorkflows({
        owner,
        repo,
      }),
    'listRepoWorkflows'
  );
  const workflowName = github.context.workflow;
  const matches = workflows.data.workflows.filter(
    (workflow) => workflow.name === workflowName
  );
  if (matches.length === 0) {
    core.warning('Could not resolve workflow id for baseline lookup.');
    return null;
  }
  if (matches.length > 1) {
    core.warning(
      `Multiple workflows named "${workflowName}" found; using the first match.`
    );
  }
  return matches[0].id;
}

function getWorkflowFileFromRef(): string | null {
  const ref = process.env.GITHUB_WORKFLOW_REF;
  if (!ref) return null;
  const match = ref.match(/\.github\/workflows\/(.+?)@/);
  return match ? match[1] : null;
}

async function downloadBaselineArtifact(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  artifactId: number,
  source: 'workflow-run' | 'repo-pagination'
): Promise<BundleStats | null> {
  const { data: downloadData } = await retryOnFail(
    () =>
      octokit.rest.actions.downloadArtifact({
        owner,
        repo,
        artifact_id: artifactId,
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
    `Baseline loaded (${source}): ${stats.totalGzip} bytes gzip from commit ${stats.commit.slice(0, 7)}`
  );

  return stats;
}
