/**
 * RAG Pipeline — Context Builder
 */

import type { Chunk } from './chunking.js';

export interface ContextWindow {
  chunks: Chunk[];
  totalTokens: number;
  truncated: boolean;
}

/** Estimate token count (rough: 1 token ≈ 4 chars) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Build context window fitting within token limit */
export function buildContext(
  chunks: Chunk[],
  maxTokens: number
): ContextWindow {
  const selected: Chunk[] = [];
  let totalTokens = 0;

  for (const chunk of chunks) {
    const tokens = estimateTokens(chunk.text);
    if (totalTokens + tokens > maxTokens) {
      return { chunks: selected, totalTokens, truncated: true };
    }
    selected.push(chunk);
    totalTokens += tokens;
  }

  return { chunks: selected, totalTokens, truncated: false };
}

/** Calculate context utilization percentage */
export function contextUtilization(usedTokens: number, maxTokens: number): number {
  return (usedTokens / maxTokens) * 100;
}

/** Merge overlapping chunks */
export function mergeOverlapping(chunks: Chunk[]): Chunk[] {
  if (chunks.length === 0) return [];

  const sorted = [...chunks].sort((a, b) => a.startIndex - b.startIndex);
  const merged: Chunk[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];

    if (curr.startIndex <= prev.endIndex) {
      // Overlapping — merge
      merged[merged.length - 1] = {
        id: prev.id,
        text: prev.text + curr.text.slice(prev.endIndex - curr.startIndex),
        startIndex: prev.startIndex,
        endIndex: Math.max(prev.endIndex, curr.endIndex),
      };
    } else {
      merged.push(curr);
    }
  }

  return merged;
}
