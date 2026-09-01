import { BugProvingAgent } from '../../dist/agents/bug-proving-agent.js';
import { initializeDatabase } from '../../dist/database/graph-db.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = initializeDatabase(':memory:');
const agent = new BugProvingAgent(db, {
  fuzz: { maxAttempts: 25, executionTimeout: 400, determinismChecks: 1 },
});

const results = [];

// ═══════════════════════════════════════════════════════════════════════════════
// Define all 16 functions to test across 3 files with financial postconditions
// ═══════════════════════════════════════════════════════════════════════════════

const targets = [
  // ─── pricing.ts ────────────────────────────────────────────────────────────
  {
    file: 'src/pricing.ts',
    fn: 'blackScholes',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)', 'result >= 0'],
    params: [
      { name: 'S', type: 'number' },
      { name: 'K', type: 'number' },
      { name: 'T', type: 'number' },
      { name: 'r', type: 'number' },
      { name: 'sigma', type: 'number' },
    ],
    knownBugs: ['T=0 → division by zero', 'S<=0 or K<=0 → NaN from Math.log', 'sigma=0 → division by zero'],
  },
  {
    file: 'src/pricing.ts',
    fn: 'normalCDF',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)', 'result >= 0', 'result <= 1'],
    params: [{ name: 'x', type: 'number' }],
    knownBugs: ['Missing sqrt(2*PI) normalization — result can exceed 1 for large |x|'],
  },
  {
    file: 'src/pricing.ts',
    fn: 'valueAtRisk',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)'],
    params: [
      { name: 'portfolioValue', type: 'number' },
      { name: 'volatility', type: 'number' },
      { name: 'confidenceLevel', type: 'number' },
      { name: 'holdingPeriod', type: 'number' },
    ],
    knownBugs: ['confidenceLevel outside (0,1) → NaN from normalCDFInverse', 'holdingPeriod<0 → NaN from sqrt'],
  },
  {
    file: 'src/pricing.ts',
    fn: 'normalCDFInverse',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)'],
    params: [{ name: 'p', type: 'number' }],
    knownBugs: ['p<=0 or p>=1 returns NaN (by design but violates postcondition)', 'Misplaced parenthesis in rational approx'],
  },
  {
    file: 'src/pricing.ts',
    fn: 'sharpeRatio',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)'],
    params: [{ name: 'returns', type: 'number[]' }, { name: 'riskFreeRate', type: 'number' }],
    knownBugs: ['Division by zero when all returns identical (stdDev=0)', 'Empty array → NaN'],
  },
  {
    file: 'src/pricing.ts',
    fn: 'portfolioBeta',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)'],
    params: [{ name: 'assetBetas', type: 'number[]' }, { name: 'weights', type: 'number[]' }],
    knownBugs: ['weights shorter than assetBetas → NaN from undefined multiplication'],
  },

  // ─── order-matching.ts ─────────────────────────────────────────────────────
  {
    file: 'src/order-matching.ts',
    fn: 'matchOrder',
    pre: [],
    post: ['result.remainingQuantity >= 0'],
    params: [
      { name: 'incoming', type: '{ id: string, side: string, price: number, quantity: number, timestamp: number }' },
      { name: 'book', type: '{ id: string, side: string, price: number, quantity: number, timestamp: number }[]' },
    ],
    knownBugs: ['Sort logic inverted for sell orders (fills at worst price)', 'Mutates book directly'],
  },
  {
    file: 'src/order-matching.ts',
    fn: 'vwap',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)', 'result >= 0'],
    params: [
      { name: 'trades', type: '{ buyOrderId: string, sellOrderId: string, price: number, quantity: number, timestamp: number }[]' },
    ],
    knownBugs: ['Empty array → NaN (0/0)'],
  },
  {
    file: 'src/order-matching.ts',
    fn: 'spread',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)'],
    params: [{ name: 'bids', type: 'number[]' }, { name: 'asks', type: 'number[]' }],
    knownBugs: ['Empty arrays → -Infinity and Infinity → Infinity result'],
  },
  {
    file: 'src/order-matching.ts',
    fn: 'midPrice',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)'],
    params: [{ name: 'bestBid', type: 'number' }, { name: 'bestAsk', type: 'number' }],
    knownBugs: ['No validation bid < ask', 'Infinity inputs → Infinity/NaN'],
  },
  {
    file: 'src/order-matching.ts',
    fn: 'bookImbalance',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)', 'result >= 0', 'result <= 1'],
    params: [{ name: 'bidVolume', type: 'number' }, { name: 'askVolume', type: 'number' }],
    knownBugs: ['Both zero → NaN (0/0)', 'Negative inputs → out of [0,1] range'],
  },

  // ─── risk.ts ───────────────────────────────────────────────────────────────
  {
    file: 'src/risk.ts',
    fn: 'kellyFraction',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)'],
    params: [
      { name: 'winRate', type: 'number' },
      { name: 'avgWin', type: 'number' },
      { name: 'avgLoss', type: 'number' },
    ],
    knownBugs: ['avgLoss=0 → division by zero', 'Negative avgLoss → inverted formula'],
  },
  {
    file: 'src/risk.ts',
    fn: 'maxDrawdown',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)', 'result >= 0'],
    params: [{ name: 'values', type: 'number[]' }],
    knownBugs: ['Empty array → undefined peak', 'Peak=0 → division by zero', 'All zeros → NaN'],
  },
  {
    file: 'src/risk.ts',
    fn: 'annualizedReturn',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)'],
    params: [{ name: 'dailyReturns', type: 'number[]' }],
    knownBugs: ['Empty array → 252/0 exponent → NaN', 'Return of -1 → 0^big → 0 then -1'],
  },
  {
    file: 'src/risk.ts',
    fn: 'sortinoRatio',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)'],
    params: [{ name: 'returns', type: 'number[]' }, { name: 'targetReturn', type: 'number' }],
    knownBugs: ['Empty array → NaN', 'No downside returns → division by zero', 'All returns above target → NaN'],
  },
  {
    file: 'src/risk.ts',
    fn: 'returnCorrelation',
    pre: [],
    post: ['isFinite(result)', '!isNaN(result)', 'result >= -1', 'result <= 1'],
    params: [{ name: 'a', type: 'number[]' }, { name: 'b', type: 'number[]' }],
    knownBugs: ['Mismatched lengths → NaN', 'Constant series → variance=0 → division by zero', 'Empty arrays → NaN'],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Execute the proving run
// ═══════════════════════════════════════════════════════════════════════════════

console.log('');
console.log('╔═══════════════════════════════════════════════════════════════════════╗');
console.log('║   BUGGY vs. REAL-TIME TRADING ENGINE — Proof-Carrying Bug Detection  ║');
console.log('║   Testing 16 financial functions across pricing, matching, and risk   ║');
console.log('╚═══════════════════════════════════════════════════════════════════════╝');
console.log('');
console.log('  Known bugs planted: ~30+ (division by zero, NaN propagation, overflow,');
console.log('  inverted logic, missing guards, empty array crashes, boundary errors)');
console.log('');
console.log('─────────────────────────────────────────────────────────────────────────');
console.log('  PROVING RUN');
console.log('─────────────────────────────────────────────────────────────────────────');
console.log('');

let currentFile = '';
const totalStart = Date.now();

for (const target of targets) {
  if (target.file !== currentFile) {
    currentFile = target.file;
    console.log(`  📁 ${currentFile}`);
    console.log('  ' + '─'.repeat(67));
  }

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
    knownBugs: target.knownBugs,
  };
  results.push(entry);

  const icon = result.certified ? '🐛' : '✓ ';
  const proofInfo = result.proof
    ? `→ ${result.proof.violated_postcondition.slice(0, 30)} | Input: ${JSON.stringify(result.proof.test_input).slice(0, 50)}`
    : 'No violation found';
  console.log(`  ${icon} ${target.fn.padEnd(22)} ${elapsed.toString().padStart(5)}ms [${entry.attempts.toString().padStart(3)} fuzz]  ${proofInfo}`);
}

const totalElapsed = Date.now() - totalStart;

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

console.log('');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  RESULTS SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('');

const proven = results.filter(r => r.certified);
const clean = results.filter(r => !r.certified);

console.log(`  Total functions tested:  ${results.length}`);
console.log(`  Bugs PROVEN (cert):      ${proven.length}  🐛`);
console.log(`  No bug found:            ${clean.length}  ✓`);
console.log(`  Total proving time:      ${totalElapsed}ms`);
console.log(`  Avg time per function:   ${Math.round(totalElapsed / results.length)}ms`);
console.log('');

// ═══════════════════════════════════════════════════════════════════════════════
// Detailed proof certificates
// ═══════════════════════════════════════════════════════════════════════════════

if (proven.length > 0) {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  PROOF CERTIFICATES (bugs with mathematical proof of existence)');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('');

  for (const r of proven) {
    console.log(`  🐛 ${r.function} (${r.file})`);
    console.log(`     Triggering input:   ${JSON.stringify(r.proof.input).slice(0, 100)}`);
    console.log(`     Observed output:    ${JSON.stringify(r.proof.output).slice(0, 80)}`);
    console.log(`     Violated contract:  ${r.proof.violated}`);
    console.log(`     Known bugs in fn:   ${r.knownBugs.join('; ')}`);
    console.log('');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Detection analysis — compare against known bugs
// ═══════════════════════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  DETECTION ANALYSIS');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('');

// Every target has known bugs, so we know the ground truth
const totalKnownBuggy = targets.length; // All 16 functions have bugs
const truePositives = proven.length;
const falseNegatives = clean.length; // Functions with bugs that weren't caught

console.log(`  Ground Truth:      All ${totalKnownBuggy} functions contain known bugs`);
console.log(`  True Positives:    ${truePositives}/${totalKnownBuggy} bugs correctly detected`);
console.log(`  False Negatives:   ${falseNegatives}/${totalKnownBuggy} bugs MISSED`);
console.log(`  Detection Rate:    ${((truePositives / totalKnownBuggy) * 100).toFixed(1)}%`);
console.log('');

// ═══════════════════════════════════════════════════════════════════════════════
// Per-module breakdown
// ═══════════════════════════════════════════════════════════════════════════════

const modules = ['src/pricing.ts', 'src/order-matching.ts', 'src/risk.ts'];
console.log('  Per-module detection:');
for (const mod of modules) {
  const modResults = results.filter(r => r.file === mod);
  const modProven = modResults.filter(r => r.certified).length;
  const modTotal = modResults.length;
  const pct = ((modProven / modTotal) * 100).toFixed(0);
  const bar = '█'.repeat(Math.round(modProven / modTotal * 20)) + '░'.repeat(20 - Math.round(modProven / modTotal * 20));
  console.log(`    ${mod.padEnd(25)} ${modProven}/${modTotal} [${bar}] ${pct}%`);
}
console.log('');

// ═══════════════════════════════════════════════════════════════════════════════
// Missed bugs analysis
// ═══════════════════════════════════════════════════════════════════════════════

if (clean.length > 0) {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  MISSED BUGS — Functions where Buggy did NOT find the bug');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('');

  for (const r of clean) {
    console.log(`  ❌ ${r.function} (${r.file})`);
    console.log(`     Fuzz attempts:    ${r.attempts}`);
    console.log(`     Known bugs:       ${r.knownBugs.join('; ')}`);
    console.log(`     Why missed:       Fuzzer may not have generated edge-case inputs`);
    console.log('');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Performance breakdown
// ═══════════════════════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  PERFORMANCE');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('');
console.log(`  Fastest:  ${Math.min(...results.map(r => r.time_ms))}ms (${results.find(r => r.time_ms === Math.min(...results.map(x => x.time_ms))).function})`);
console.log(`  Slowest:  ${Math.max(...results.map(r => r.time_ms))}ms (${results.find(r => r.time_ms === Math.max(...results.map(x => x.time_ms))).function})`);
console.log(`  Average:  ${Math.round(totalElapsed / results.length)}ms per function`);
console.log(`  Total:    ${totalElapsed}ms for ${results.length} functions`);
console.log('');

// ═══════════════════════════════════════════════════════════════════════════════
// Bug category analysis
// ═══════════════════════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  BUG CATEGORIES TESTED');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('');
console.log('  Category                       Functions    Detected');
console.log('  ─────────────────────────────  ───────────  ────────');

const categories = [
  { name: 'Division by zero', fns: ['blackScholes', 'sharpeRatio', 'kellyFraction', 'maxDrawdown', 'bookImbalance', 'vwap', 'returnCorrelation', 'sortinoRatio'] },
  { name: 'NaN propagation', fns: ['valueAtRisk', 'normalCDFInverse', 'portfolioBeta', 'annualizedReturn'] },
  { name: 'Empty array crash', fns: ['sharpeRatio', 'maxDrawdown', 'annualizedReturn', 'sortinoRatio', 'returnCorrelation', 'spread'] },
  { name: 'Boundary violation', fns: ['normalCDF', 'bookImbalance'] },
  { name: 'Logic errors', fns: ['matchOrder'] },
  { name: 'Overflow/Infinity', fns: ['spread', 'midPrice', 'blackScholes'] },
];

for (const cat of categories) {
  const detected = cat.fns.filter(fn => proven.some(r => r.function === fn)).length;
  const total = cat.fns.length;
  console.log(`  ${cat.name.padEnd(31)} ${total.toString().padStart(3)} funcs    ${detected}/${total}`);
}

console.log('');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  VERDICT');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('');

const detectionRate = (truePositives / totalKnownBuggy) * 100;
if (detectionRate >= 80) {
  console.log('  🏆 EXCELLENT — Buggy detected ≥80% of subtle financial bugs');
} else if (detectionRate >= 60) {
  console.log('  ✅ GOOD — Buggy detected ≥60% of bugs, edge cases remain');
} else if (detectionRate >= 40) {
  console.log('  ⚠️  MODERATE — Buggy caught some bugs but missed many edge cases');
} else {
  console.log('  ❌ NEEDS WORK — Detection rate below 40% on financial code');
}
console.log(`  Detection rate: ${detectionRate.toFixed(1)}% (${truePositives}/${totalKnownBuggy})`);
console.log('');
console.log('  This test represents the HARDEST category for automated bug proving:');
console.log('  subtle numerical errors in high-stakes financial calculations where');
console.log('  single NaN or Infinity values can cause millions in trading losses.');
console.log('');

db.close();
