export type ChartPt = { t: number; inn: number; out: number };

export function paddedMax(pts: ChartPt[]): number {
  let m = 0;
  for (const p of pts) {
    if (p.inn > m) m = p.inn;
    if (p.out > m) m = p.out;
  }
  return m > 0 ? m * 1.08 : 1;
}

/** Grow with the data; ease down so a single spike does not yank the axis. */
export function stepYMax(current: number, target: number): number {
  if (target >= current) return target;
  return Math.max(target, current + (target - current) * 0.22);
}

const CHART_MAX_POINTS = 160;

function mag(p: ChartPt) {
  return p.inn + p.out;
}

/** Largest-triangle-three-buckets; keeps first/last and a live tail. */
export function downsampleChart(pts: ChartPt[], maxPoints = CHART_MAX_POINTS): ChartPt[] {
  if (pts.length <= maxPoints) return pts;
  const tailN = Math.min(2, pts.length);
  const tail = pts.slice(pts.length - tailN);
  const head = pts.slice(0, pts.length - tailN);
  const budget = maxPoints - tailN;
  if (head.length <= budget) return pts;
  return [...lttb(head, budget), ...tail];
}

function lttb(data: ChartPt[], threshold: number): ChartPt[] {
  const n = data.length;
  if (threshold >= n || threshold < 3) return data;
  const sampled: ChartPt[] = [data[0]];
  const bucketSize = (n - 2) / (threshold - 2);
  let prev = 0;
  for (let i = 0; i < threshold - 2; i++) {
    const start = Math.floor((i + 1) * bucketSize) + 1;
    const end = Math.min(n - 1, Math.floor((i + 2) * bucketSize) + 1);
    const avgStart = end;
    const avgEnd = Math.min(n - 1, Math.floor((i + 3) * bucketSize) + 1);
    let avgT = 0;
    let avgY = 0;
    const avgCount = Math.max(1, avgEnd - avgStart);
    for (let j = avgStart; j < avgEnd; j++) {
      avgT += data[j].t;
      avgY += mag(data[j]);
    }
    avgT /= avgCount;
    avgY /= avgCount;
    const aT = data[prev].t;
    const aY = mag(data[prev]);
    let maxArea = -1;
    let chosen = start;
    for (let j = start; j < end; j++) {
      const area = Math.abs((aT - avgT) * (mag(data[j]) - aY) - (aT - data[j].t) * (avgY - aY));
      if (area > maxArea) {
        maxArea = area;
        chosen = j;
      }
    }
    sampled.push(data[chosen]);
    prev = chosen;
  }
  sampled.push(data[n - 1]);
  return sampled;
}
