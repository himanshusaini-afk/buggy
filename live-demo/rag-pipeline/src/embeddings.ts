/**
 * RAG Pipeline — Embedding & Vector Operations
 */

/** Compute cosine similarity between two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] ** 2;
    normB += b[i] ** 2;
  }
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  // A zero-length vector has no direction; similarity is undefined, so return 0
  // instead of 0 / 0 = NaN, which would silently corrupt every downstream ranking.
  if (magnitude === 0) return 0;
  return dot / magnitude;
}

/** Normalize a vector to unit length */
export function normalizeVector(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  // A zero vector cannot be normalized (0 / 0 = NaN); leave it as zeros.
  if (magnitude === 0) return vec.map(() => 0);
  return vec.map(v => v / magnitude);
}

/** Compute average of multiple embedding vectors */
export function averageEmbeddings(embeddings: number[][]): number[] {
  // No embeddings — nothing to average. Guards embeddings[0] being undefined.
  if (embeddings.length === 0) return [];
  const dim = embeddings[0].length;
  const result = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      result[i] += emb[i];
    }
  }
  return result.map(v => v / embeddings.length);
}

/** Find top-k most similar vectors by cosine similarity */
export function topKSimilar(query: number[], corpus: number[][], k: number): { index: number; score: number }[] {
  const scores = corpus.map((vec, index) => ({
    index,
    score: cosineSimilarity(query, vec),
  }));
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, k);
}
