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
    start += chunkSize - overlap;
  }

  return chunks;
}

/** Split text by sentences (period + space) */
export function chunkBySentence(text: string, maxSentencesPerChunk: number): Chunk[] {
  const sentences = text.split(/(?<=\.)\s+/);
  const chunks: Chunk[] = [];
  let id = 0;
  let charOffset = 0;

  for (let i = 0; i < sentences.length; i += maxSentencesPerChunk) {
    const group = sentences.slice(i, i + maxSentencesPerChunk);
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
  return targetTokens * avgCharsPerToken;
}
