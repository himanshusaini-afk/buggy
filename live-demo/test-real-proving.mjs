import { BugProvingAgent } from '../dist/agents/bug-proving-agent.js';
import { initializeDatabase } from '../dist/database/graph-db.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const db = initializeDatabase(':memory:');
const agent = new BugProvingAgent(db, {
  fuzz: { maxAttempts: 30, executionTimeout: 2000, determinismChecks: 2 },
});

console.log('═══════════════════════════════════════════════════');
console.log('  REAL BUG PROVING TEST');
console.log('═══════════════════════════════════════════════════');
console.log('');

// Test 1: splitExpense with people=0
console.log('--- Test 1: splitExpense(amount, people=0) ---');
const result1 = await agent.investigate({
  function_id: 'splitExpense',
  file_path: resolve(__dirname, 'src/expenses.ts'),
  specification: {
    name: 'splitExpense',
    preconditions: ['input[0] >= 0'],
    postconditions: ['isFinite(result)', 'result >= 0'],
    parameters: [{ name: 'amount', type: 'number' }, { name: 'people', type: 'number' }],
    return_type: 'number',
  },
});
console.log(`  Certified: ${result1.certified}`);
if (result1.proof) {
  console.log(`  Input:     ${JSON.stringify(result1.proof.test_input)}`);
  console.log(`  Output:    ${JSON.stringify(result1.proof.observed_output)}`);
  console.log(`  Violated:  ${result1.proof.violated_postcondition}`);
}
console.log(`  Attempts:  ${result1.intermediate.fuzz_mutations}`);
console.log('');

// Test 2: budgetUsage with budget=0
console.log('--- Test 2: budgetUsage(spent, budget=0) ---');
const result2 = await agent.investigate({
  function_id: 'budgetUsage',
  file_path: resolve(__dirname, 'src/expenses.ts'),
  specification: {
    name: 'budgetUsage',
    preconditions: ['input[0] >= 0'],
    postconditions: ['isFinite(result)', '!isNaN(result)'],
    parameters: [{ name: 'spent', type: 'number' }, { name: 'budget', type: 'number' }],
    return_type: 'number',
  },
});
console.log(`  Certified: ${result2.certified}`);
if (result2.proof) {
  console.log(`  Input:     ${JSON.stringify(result2.proof.test_input)}`);
  console.log(`  Output:    ${JSON.stringify(result2.proof.observed_output)}`);
  console.log(`  Violated:  ${result2.proof.violated_postcondition}`);
}
console.log(`  Attempts:  ${result2.intermediate.fuzz_mutations}`);
console.log('');

// Test 3: growthRate with previousMonth=0
console.log('--- Test 3: growthRate(current, previous=0) ---');
const result3 = await agent.investigate({
  function_id: 'growthRate',
  file_path: resolve(__dirname, 'src/reports.ts'),
  specification: {
    name: 'growthRate',
    preconditions: [],
    postconditions: ['isFinite(result)', '!isNaN(result)'],
    parameters: [{ name: 'currentMonth', type: 'number' }, { name: 'previousMonth', type: 'number' }],
    return_type: 'number',
  },
});
console.log(`  Certified: ${result3.certified}`);
if (result3.proof) {
  console.log(`  Input:     ${JSON.stringify(result3.proof.test_input)}`);
  console.log(`  Output:    ${JSON.stringify(result3.proof.observed_output)}`);
  console.log(`  Violated:  ${result3.proof.violated_postcondition}`);
}
console.log(`  Attempts:  ${result3.intermediate.fuzz_mutations}`);
console.log('');

// Test 4: dailyRate with days=0
console.log('--- Test 4: dailyRate(totalSpent, days=0) ---');
const result4 = await agent.investigate({
  function_id: 'dailyRate',
  file_path: resolve(__dirname, 'src/dates.ts'),
  specification: {
    name: 'dailyRate',
    preconditions: ['input[0] >= 0'],
    postconditions: ['isFinite(result)', '!isNaN(result)', 'result >= 0'],
    parameters: [{ name: 'totalSpent', type: 'number' }, { name: 'days', type: 'number' }],
    return_type: 'number',
  },
});
console.log(`  Certified: ${result4.certified}`);
if (result4.proof) {
  console.log(`  Input:     ${JSON.stringify(result4.proof.test_input)}`);
  console.log(`  Output:    ${JSON.stringify(result4.proof.observed_output)}`);
  console.log(`  Violated:  ${result4.proof.violated_postcondition}`);
}
console.log(`  Attempts:  ${result4.intermediate.fuzz_mutations}`);
console.log('');

console.log('═══════════════════════════════════════════════════');
const proven = [result1, result2, result3, result4].filter(r => r.certified).length;
console.log(`  RESULTS: ${proven}/4 bugs proven autonomously`);
console.log('═══════════════════════════════════════════════════');

db.close();
