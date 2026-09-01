/**
 * RAG Pipeline — Retriever
 */

import type { Chunk } from './chunking.js';

export interface RetrievalResult {
  chunk: Chunk;
  score: number;
  rank: number;
}

/** Score chunks using BM25 algorithm */
export function bm25Score(
  query: string[],
  document: string[],
  avgDocLength: number,
  k1: number = 1.5,
  b: number = 0.75
): number {
  let score = 0;
  const docLength = document.length;

  for (const term of query) {
    const tf = document.filter(t => t === term).length;
    const idf = Math.log(1 + 1 / (tf + 1)); // Simplified IDF
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDocLength)));
    score += idf * tfNorm;
  }

  return score;
}

/** Reciprocal Rank Fusion to combine multiple ranking lists */
export function reciprocalRankFusion(
  rankings: number[][],
  k: number = 60
): { index: number; score: number }[] {
  const scores = new Map<number, number>();

  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank++) {
      const docId = ranking[rank];
      const current = scores.get(docId) || 0;
      scores.set(docId, current + 1 / (k + rank + 1));
    }
  }

  return Array.from(scores.entries())
    .map(([index, score]) => ({ index, score }))
    .sort((a, b) => b.score - a.score);
}

/** Re-rank results using cross-encoder score simulation */
export function rerank(
  results: RetrievalResult[],
  queryLength: number,
  maxResults: number
): RetrievalResult[] {
  // Boost shorter chunks (more focused)
  const reranked = results.map(r => ({
    ...r,
    score: r.score * (queryLength / r.chunk.text.length),
  }));

  reranked.sort((a, b) => b.score - a.score);
  return reranked.slice(0, maxResults);
}
