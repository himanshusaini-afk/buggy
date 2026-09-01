import { SubprocessExecutor } from '../dist/sandbox/subprocess-executor.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const executor = new SubprocessExecutor({ timeout: 3000 });

// Read the source file
const source = readFileSync(resolve(__dirname, 'src/expenses.ts'), 'utf-8');

// Test execution with the raw source (should fail due to TS syntax if strip isn't working)
console.log('=== Testing splitExpense(100, 0) ===');
const result = await executor.execute({
  functionCode: source,
  functionName: 'splitExpense',
  input: [100, 0],
  timeout: 3000,
});
console.log('Success:', result.success);
console.log('Output:', result.output);
console.log('Crashed:', result.crashed);
console.log('Error:', result.error?.slice(0, 200));
console.log('');

console.log('=== Testing splitExpense(0, 0) ===');
const result2 = await executor.execute({
  functionCode: source,
  functionName: 'splitExpense',
  input: [0, 0],
  timeout: 3000,
});
console.log('Success:', result2.success);
console.log('Output:', result2.output);
console.log('Crashed:', result2.crashed);
console.log('Error:', result2.error?.slice(0, 200));

executor.cleanup();
