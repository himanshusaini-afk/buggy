import { BugProvingAgent } from '../../dist/agents/bug-proving-agent.js';
import { initializeDatabase } from '../../dist/database/graph-db.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = initializeDatabase(':memory:');
const agent = new BugProvingAgent(db, {
  fuzz: { maxAttempts: 40, executionTimeout: 2000, determinismChecks: 2 },
});

const results = [];

// Define all functions to test with their specs
const targets = [
  // embeddings.ts
  {
    file: 'src/embeddings.ts',
    fn: 'cosineSimilarity',
    pre: [],
    post: ['!isNaN(result)', 'isFinite(result)', 'result >= -1', 'result <= 1'],
    params: [{ name: 'a', type: 'number[]' }, { name: 'b', type: 'number[]' }],
  },
  {
    file: 'src/embeddings.ts',
    fn: 'normalizeVector',
    pre: [],
    post: ['Array.isArray(result)', '!result.some(v => isNaN(v))'],
    params: [{ name: 'vec', type: 'number[]' }],
  },
  {
    file: 'src/embeddings.ts',
    fn: 'averageEmbeddings',
    pre: [],
    post: ['Array.isArray(result)', '!result.some(v => isNaN(v))'],
    params: [{ name: 'embeddings', type: 'number[][]' }],
  },
  {
    file: 'src/embeddings.ts',
    fn: 'topKSimilar',
    pre: [],
    post: ['Array.isArray(result)'],
    params: [{ name: 'query', type: 'number[]' }, { name: 'corpus', type: 'number[][]' }, { name: 'k', type: 'number' }],
  },
  // chunking.ts
  {
    file: 'src/chunking.ts',
    fn: 'chunkBySize',
    pre: [],
    post: ['Array.isArray(result)'],
    params: [{ name: 'text', type: 'string' }, { name: 'chunkSize', type: 'number' }, { name: 'overlap', type: 'number' }],
  },
  {
    file: 'src/chunking.ts',
    fn: 'chunkBySentence',
    pre: [],
    post: ['Array.isArray(result)'],
    params: [{ name: 'text', type: 'string' }, { name: 'maxSentencesPerChunk', type: 'number' }],
  },
  {
    file: 'src/chunking.ts',
    fn: 'optimalChunkSize',
    pre: [],
    post: ['isFinite(result)', 'result > 0'],
    params: [{ name: 'targetTokens', type: 'number' }, { name: 'avgCharsPerToken', type: 'number' }],
  },
  // retriever.ts
  {
    file: 'src/retriever.ts',
    fn: 'bm25Score',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)'],
    params: [{ name: 'query', type: 'string[]' }, { name: 'document', type: 'string[]' }, { name: 'avgDocLength', type: 'number' }],
  },
  {
    file: 'src/retriever.ts',
    fn: 'reciprocalRankFusion',
    pre: [],
    post: ['Array.isArray(result)'],
    params: [{ name: 'rankings', type: 'number[][]' }],
  },
  // context-builder.ts
  {
    file: 'src/context-builder.ts',
    fn: 'estimateTokens',
    pre: [],
    post: ['result >= 0', 'isFinite(result)'],
    params: [{ name: 'text', type: 'string' }],
  },
  {
    file: 'src/context-builder.ts',
    fn: 'contextUtilization',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)'],
    params: [{ name: 'usedTokens', type: 'number' }, { name: 'maxTokens', type: 'number' }],
  },
];

console.log('═══════════════════════════════════════════════════════════');
console.log('  BUGGY vs. RAG PIPELINE — Full Proving Test');
console.log('═══════════════════════════════════════════════════════════');
console.log('');

for (const target of targets) {
  const start = Date.now();
  const result = await agent.investigate({
    function_id: target.fn,
    file_path: resolve(__dirname, target.file),
    specification: {
      name: target.fn,
      preconditions: target.pre,
      postconditions: target.post,
      parameters: target.params,
      return_type: 'unknown',
    },
  });
  const elapsed = Date.now() - start;

  const entry = {
    file: target.file,
    function: target.fn,
    certified: result.certified,
    proof: result.proof ? {
      input: result.proof.test_input,
      output: result.proof.observed_output,
      violated: result.proof.violated_postcondition,
    } : null,
    attempts: result.intermediate.fuzz_mutations,
    time_ms: elapsed,
    status: result.certified ? '🐛 BUG PROVEN' : '✓ No bug found',
  };
  results.push(entry);

  const icon = result.certified ? '🐛' : '✓ ';
  const proofInfo = result.proof
    ? `Input: ${JSON.stringify(result.proof.test_input).slice(0, 60)} → ${result.proof.violated_postcondition.slice(0, 40)}`
    : 'Clean';
  console.log(`  ${icon} ${target.fn.padEnd(24)} ${elapsed.toString().padStart(5)}ms  ${proofInfo}`);
}

// Summary
console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  SUMMARY');
console.log('═══════════════════════════════════════════════════════════');

const proven = results.filter(r => r.certified);
const clean = results.filter(r => !r.certified);

console.log(`  Total functions:   ${results.length}`);
console.log(`  Bugs proven:       ${proven.length}`);
console.log(`  No bug found:      ${clean.length}`);
console.log(`  Total time:        ${results.reduce((s, r) => s + r.time_ms, 0)}ms`);
console.log('');

if (proven.length > 0) {
  console.log('  BUGS FOUND:');
  for (const r of proven) {
    console.log(`    ${r.function} (${r.file})`);
    console.log(`      Input:    ${JSON.stringify(r.proof.input).slice(0, 80)}`);
    console.log(`      Violated: ${r.proof.violated}`);
    console.log('');
  }
}

if (clean.length > 0) {
  console.log('  CLEAN (no bug found within budget):');
  for (const r of clean) {
    console.log(`    ${r.function} (${r.file}) — ${r.attempts} attempts`);
  }
}

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  FAILURE ANALYSIS');
console.log('═══════════════════════════════════════════════════════════');
console.log('');

// Analyze where Buggy "failed" (functions with known bugs that weren't caught)
const knownBugs = [
  { fn: 'cosineSimilarity', bug: 'Division by zero for zero vectors', shouldCatch: true },
  { fn: 'normalizeVector', bug: 'Division by zero for zero vector', shouldCatch: true },
  { fn: 'averageEmbeddings', bug: 'Crash on empty array (embeddings[0].length)', shouldCatch: true },
  { fn: 'optimalChunkSize', bug: 'Returns 0 or negative for 0/negative inputs', shouldCatch: true },
  { fn: 'bm25Score', bug: 'NaN for avgDocLength=0 (division by zero)', shouldCatch: true },
  { fn: 'contextUtilization', bug: 'Division by zero for maxTokens=0', shouldCatch: true },
  { fn: 'chunkBySize', bug: 'Infinite loop if overlap >= chunkSize', shouldCatch: false }, // Hard to catch — timeout needed
];

let falseNegatives = 0;
let truePositives = 0;

for (const known of knownBugs) {
  const found = results.find(r => r.function === known.fn);
  if (!found) continue;

  if (found.certified) {
    console.log(`  ✅ TRUE POSITIVE: ${known.fn} — Bug correctly proven`);
    console.log(`     Known: ${known.bug}`);
    console.log(`     Found: ${found.proof?.violated}`);
    truePositives++;
  } else if (known.shouldCatch) {
    console.log(`  ❌ FALSE NEGATIVE: ${known.fn} — Bug exists but NOT proven`);
    console.log(`     Known bug: ${known.bug}`);
    console.log(`     Reason: Fuzzer didn't generate triggering input in ${found.attempts} attempts`);
    console.log(`     Fix needed: Better input generation for this pattern`);
    falseNegatives++;
  }
  console.log('');
}

console.log(`  True Positives:  ${truePositives}/${knownBugs.filter(b => b.shouldCatch).length}`);
console.log(`  False Negatives: ${falseNegatives}/${knownBugs.filter(b => b.shouldCatch).length}`);
console.log(`  Detection Rate:  ${((truePositives / knownBugs.filter(b => b.shouldCatch).length) * 100).toFixed(0)}%`);
console.log('');

// Improvement suggestions
console.log('═══════════════════════════════════════════════════════════');
console.log('  IMPROVEMENT SUGGESTIONS');
console.log('═══════════════════════════════════════════════════════════');
console.log('');
console.log('  Based on failure analysis:');
console.log('');
if (falseNegatives > 0) {
  console.log('  1. Array-type fuzzing needs empty array [] as edge case');
  console.log('     → averageEmbeddings([]) should crash on embeddings[0].length');
  console.log('');
  console.log('  2. Zero-vector detection for cosine/normalize');
  console.log('     → [0,0,0] should produce NaN from 0/0');
  console.log('');
  console.log('  3. Multi-arg edge cases need better combos');
  console.log('     → bm25Score([], [], 0) triggers division by zero');
}
console.log('');

db.close();
