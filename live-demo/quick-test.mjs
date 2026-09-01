import { BugProvingAgent } from '../dist/agents/bug-proving-agent.js';
import { initializeDatabase } from '../dist/database/graph-db.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = initializeDatabase(':memory:');
const agent = new BugProvingAgent(db, {
  fuzz: { maxAttempts: 30, executionTimeout: 1500, determinismChecks: 2 },
});

console.log('Testing splitExpense(amount, people) with postcondition: isFinite(result)...');
const result = await agent.investigate({
  function_id: 'splitExpense',
  file_path: resolve(__dirname, 'src/expenses.ts'),
  specification: {
    name: 'splitExpense',
    preconditions: [],
    postconditions: ['isFinite(result)'],
    parameters: [{ name: 'amount', type: 'number' }, { name: 'people', type: 'number' }],
    return_type: 'number',
  },
});

console.log(`Certified: ${result.certified}`);
if (result.proof) {
  console.log(`Input:     ${JSON.stringify(result.proof.test_input)}`);
  console.log(`Output:    ${JSON.stringify(result.proof.observed_output)}`);
  console.log(`Violated:  ${result.proof.violated_postcondition}`);
}
console.log(`Attempts:  ${result.intermediate.fuzz_mutations}`);
db.close();
