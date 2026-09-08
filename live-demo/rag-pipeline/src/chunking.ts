/**
 * RAG Pipeline — Document Chunking
 */

export interface Chunk {
  id: string;
  text: string;
  startIndex: number;
  endIndex: number;
  metadata?: Record<string, unknown>;
}

/** Split text into chunks by character count with overlap */
export function chunkBySize(text: string, chunkSize: number, overlap: number): Chunk[] {
  const chunks: Chunk[] = [];
  // Guard against a non-advancing loop: a non-positive chunk size, or an overlap
  // that meets/exceeds the chunk size, would leave `start` fixed and spin forever.
  if (chunkSize <= 0) return chunks;
  const step = Math.max(1, chunkSize - overlap);
  let start = 0;
  let id = 0;

  while (start < text.length) {
    const end = start + chunkSize;
    chunks.push({
      id: `chunk_${id++}`,
      text: text.slice(start, end),
      startIndex: start,
      endIndex: Math.min(end, text.length),
    });
    start += step;
  }

  return chunks;
}

/** Split text by sentences (period + space) */
export function chunkBySentence(text: string, maxSentencesPerChunk: number): Chunk[] {
  const sentences = text.split(/(?<=\.)\s+/);
  const chunks: Chunk[] = [];
  let id = 0;
  let charOffset = 0;
  // A non-positive group size would never advance `i` — clamp to at least 1.
  const step = Math.max(1, maxSentencesPerChunk);

  for (let i = 0; i < sentences.length; i += step) {
    const group = sentences.slice(i, i + step);
    const chunkText = group.join(' ');
    chunks.push({
      id: `chunk_${id++}`,
      text: chunkText,
      startIndex: charOffset,
      endIndex: charOffset + chunkText.length,
    });
    charOffset += chunkText.length + 1;
  }

  return chunks;
}

/** Calculate optimal chunk size based on average token length */
export function optimalChunkSize(targetTokens: number, avgCharsPerToken: number): number {
  // Chunk size must be positive; non-positive inputs would yield a useless 0/negative size.
  return Math.max(1, targetTokens * avgCharsPerToken);
}
