export interface FileStats {
  path: string;
  name: string;
  size: number;
  gzip: number;
  brotli: number;
}

export interface BundleStats {
  files: FileStats[];
  totalSize: number;
  totalGzip: number;
  totalBrotli: number;
  timestamp: string;
  commit: string;
}
