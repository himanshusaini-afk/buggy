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
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Normalize a vector to unit length */
export function normalizeVector(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map(v => v / magnitude);
}

/** Compute average of multiple embedding vectors */
export function averageEmbeddings(embeddings: number[][]): number[] {
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
