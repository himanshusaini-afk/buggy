/**
 * Data Pipeline Functions
 *
 * BUG 10: movingAverage() window extends beyond array bounds
 * BUG 11: detectOutliers() uses wrong formula (2*IQR instead of 1.5*IQR)
 * BUG 12: interpolateMissing() corrupts non-null values via shallow copy
 */

export interface DataPoint {
  timestamp: number;
  value: number | null;
  label?: string;
}

export function movingAverage(data: number[], windowSize: number): number[] {
  const result: number[] = [];

  for (let i = 0; i < data.length; i++) {
    let sum = 0;
    let count = 0;
    // BUG: Window extends beyond array bounds (no Math.min/max clamping)
    for (let j = i - windowSize; j <= i + windowSize; j++) {
      sum += data[j]; // BUG: data[j] is undefined for negative j or j >= data.length → NaN propagation
      count++;
    }
    result.push(sum / count);
  }

  return result;
}

export function detectOutliers(values: number[]): { outliers: number[]; indices: number[] } {
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;

  // BUG: Uses 2*IQR instead of standard 1.5*IQR
  const lowerBound = q1 - 2 * iqr;
  const upperBound = q3 + 2 * iqr;

  const outliers: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < values.length; i++) {
    if (values[i] < lowerBound || values[i] > upperBound) {
      outliers.push(values[i]);
      indices.push(i);
    }
  }

  return { outliers, indices };
}

export function interpolateMissing(data: DataPoint[]): DataPoint[] {
  const result = [...data]; // Shallow copy — BUG: modifies original objects

  for (let i = 0; i < result.length; i++) {
    if (result[i].value === null) {
      // Linear interpolation between previous and next non-null values
      let prevIdx = i - 1;
      let nextIdx = i + 1;

      while (prevIdx >= 0 && result[prevIdx].value === null) prevIdx--;
      while (nextIdx < result.length && result[nextIdx].value === null) nextIdx++;

      if (prevIdx >= 0 && nextIdx < result.length) {
        const prevVal = result[prevIdx].value!;
        const nextVal = result[nextIdx].value!;
        const fraction = (i - prevIdx) / (nextIdx - prevIdx);
        result[i].value = prevVal + fraction * (nextVal - prevVal); // BUG: Mutates original due to shallow copy
      }
    }
  }

  return result;
}

export function binData(values: number[], numBins: number): { binEdges: number[]; counts: number[] } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const binWidth = (max - min) / numBins; // BUG: Division by zero if numBins = 0, or binWidth = 0 if min === max

  const binEdges: number[] = [];
  const counts: number[] = new Array(numBins).fill(0);

  for (let i = 0; i <= numBins; i++) {
    binEdges.push(min + i * binWidth);
  }

  for (const value of values) {
    const binIndex = Math.floor((value - min) / binWidth); // BUG: Last value gets binIndex = numBins (out of bounds)
    counts[binIndex]++; // BUG: Out of bounds for value === max
  }

  return { binEdges, counts };
}
