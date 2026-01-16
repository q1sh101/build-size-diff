import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { createReadStream } from 'fs';
import { FileStats, BundleStats } from './types';
import { isAssetFile } from './utils';

export async function scanDirectory(
  distPath: string,
  useGzip: boolean,
  useBrotli: boolean
): Promise<BundleStats> {
  try {
    const stat = await fs.promises.stat(distPath);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${distPath}`);
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('ENOENT')) {
      throw new Error(`Directory not found: ${distPath}`);
    }
    throw error;
  }

  const files: FileStats[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && isAssetFile(entry.name)) {
        const stat = await fs.promises.stat(fullPath);
        files.push({
          path: path.relative(distPath, fullPath),
          name: entry.name,
          size: stat.size,
          gzip: 0,
          brotli: 0,
        });
      }
    }
  }

  await walk(distPath);

  const concurrency = Math.max(1, Math.min(4, files.length));
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const file = files[index];
      if (!file) break;
      const fullPath = path.join(distPath, file.path);
      if (useGzip) {
        file.gzip = await getCompressedSize(fullPath, 'gzip');
      }
      if (useBrotli) {
        file.brotli = await getCompressedSize(fullPath, 'brotli');
      }
    }
  });
  await Promise.all(workers);

  return {
    files,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    totalGzip: files.reduce((sum, f) => sum + f.gzip, 0),
    totalBrotli: files.reduce((sum, f) => sum + f.brotli, 0),
    timestamp: new Date().toISOString(),
    commit: process.env.GITHUB_SHA || 'unknown',
  };
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  const unitIndex = Math.min(i, sizes.length - 1);
  const value = bytes / Math.pow(k, unitIndex);
  const sign = bytes < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toFixed(2)} ${sizes[unitIndex]}`;
}

async function getCompressedSize(
  filePath: string,
  mode: 'gzip' | 'brotli'
): Promise<number> {
  return new Promise((resolve, reject) => {
    const source = createReadStream(filePath);
    const compressor =
      mode === 'gzip' ? zlib.createGzip() : zlib.createBrotliCompress();

    let size = 0;
    let settled = false;

    const cleanup = (): void => {
      source.destroy();
      compressor.destroy();
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    source.on('error', fail);
    compressor.on('error', fail);
    compressor.on('data', (chunk) => {
      size += chunk.length;
    });
    compressor.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(size);
    });

    source.pipe(compressor);
  });
}
