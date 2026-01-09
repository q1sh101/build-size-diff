import { BundleStats, DiffResult } from './types';

export function diffBundles(
  baseline: BundleStats | null,
  current: BundleStats,
  budgetKb: number | null,
  warnKb: number | null = null,
  failKb: number | null = null,
  useGzip: boolean = true,
  useBrotli: boolean = true
): DiffResult {
  const compareMetric: DiffResult['compareMetric'] = useBrotli
    ? 'brotli'
    : useGzip
      ? 'gzip'
      : 'size';

  const extractMetric = (stats: BundleStats): number => {
    if (compareMetric === 'brotli') return stats.totalBrotli;
    if (compareMetric === 'gzip') return stats.totalGzip;
    return stats.totalSize;
  };

  const extractFileMetric = (file: BundleStats['files'][number]): number => {
    if (compareMetric === 'brotli') return file.brotli;
    if (compareMetric === 'gzip') return file.gzip;
    return file.size;
  };

  if (!baseline) {
    return {
      baseline: null,
      current,
      diffSize: 0,
      diffGzip: 0,
      diffBrotli: 0,
      diffMetric: 0,
      diffPercent: 0,
      diffPercentGzip: 0,
      diffPercentBrotli: 0,
      diffPercentSize: 0,
      topChanges: [],
      compareMetric,
      status: 'no-baseline',
      worstDeltaKb: 0,
      thresholdStatus: 'ok',
      thresholdMessage: null,
      budgetMaxIncreaseKb: budgetKb,
      warnAboveKb: warnKb,
      failAboveKb: failKb,
    };
  }

  const diffSize = current.totalSize - baseline.totalSize;
  const diffGzip = current.totalGzip - baseline.totalGzip;
  const diffBrotli = current.totalBrotli - baseline.totalBrotli;
  const diffMetric = extractMetric(current) - extractMetric(baseline);
  const diffPercentGzip =
    baseline.totalGzip > 0 ? (diffGzip / baseline.totalGzip) * 100 : 0;
  const diffPercentBrotli =
    baseline.totalBrotli > 0 ? (diffBrotli / baseline.totalBrotli) * 100 : 0;
  const diffPercentSize =
    baseline.totalSize > 0 ? (diffSize / baseline.totalSize) * 100 : 0;
  const diffPercent =
    extractMetric(baseline) > 0
      ? (diffMetric / extractMetric(baseline)) * 100
      : 0;

  const baselineMap = new Map(baseline.files.map((f) => [f.path, f]));
  const currentPaths = new Set(current.files.map((f) => f.path));
  const topChanges: DiffResult['topChanges'] = [];
  let maxPositiveDiff = 0;

  for (const file of current.files) {
    const baseFile = baselineMap.get(file.path);
    const before = baseFile ? extractFileMetric(baseFile) : 0;
    const after = extractFileMetric(file);
    const diff = after - before;

    if (diff !== 0) {
      topChanges.push({ file: file.path, before, after, diff });
    }
    if (diff > maxPositiveDiff) {
      maxPositiveDiff = diff;
    }
  }

  for (const [filePath, baseFile] of baselineMap) {
    if (!currentPaths.has(filePath)) {
      topChanges.push({
        file: filePath,
        before: extractFileMetric(baseFile),
        after: 0,
        diff: -extractFileMetric(baseFile),
      });
    }
  }

  topChanges.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  topChanges.splice(5);

  const worstDeltaKb = Math.round((maxPositiveDiff / 1024) * 10) / 10;

  let thresholdStatus: DiffResult['thresholdStatus'] = 'ok';
  let thresholdMessage: string | null = null;

  if (failKb !== null && worstDeltaKb >= failKb) {
    thresholdStatus = 'fail';
    thresholdMessage = `Largest file +${worstDeltaKb} KB (fail at ${failKb} KB)`;
  } else if (warnKb !== null && worstDeltaKb >= warnKb) {
    thresholdStatus = 'warn';
    thresholdMessage = `Largest file +${worstDeltaKb} KB (warn at ${warnKb} KB / fail at ${failKb ?? '-'} KB)`;
  }

  let status: DiffResult['status'] = 'pass';
  if (budgetKb !== null && diffMetric > budgetKb * 1024) {
    status = 'fail';
  } else if (thresholdStatus === 'fail') {
    status = 'fail';
  }

  return {
    baseline,
    current,
    diffSize,
    diffGzip,
    diffBrotli,
    diffMetric,
    diffPercent,
    diffPercentGzip,
    diffPercentBrotli,
    diffPercentSize,
    topChanges,
    compareMetric,
    status,
    worstDeltaKb,
    thresholdStatus,
    thresholdMessage,
    budgetMaxIncreaseKb: budgetKb,
    warnAboveKb: warnKb,
    failAboveKb: failKb,
  };
}
