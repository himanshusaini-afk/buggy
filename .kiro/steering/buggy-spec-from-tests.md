---
inclusion: fileMatch
fileMatchPattern: "**/*.test.ts,**/*.spec.ts,**/*.test.js,**/*.spec.js"
---

# Buggy — Specification Inference from Existing Tests

When a test file is loaded into context, use the test assertions to automatically infer formal specifications for the functions under test. This enables Buggy to find bugs that the tests don't cover.

## How to Extract Specifications from Tests

### Pattern Recognition

| Test assertion | Inferred postcondition |
|---------------|----------------------|
| `expect(fn(x)).toBeGreaterThanOrEqual(0)` | `result >= 0` |
| `expect(fn(x)).toBe(y)` | For specific x → `result === y` (edge case) |
| `expect(fn(x)).not.toBeNull()` | `result !== null` |
| `expect(fn(x)).not.toBeNaN()` | `!isNaN(result)` |
| `expect(fn(x)).toHaveLength(n)` | `result.length === n` |
| `expect(fn(x)).toThrow()` | For invalid input → function should throw |
| `expect(fn(x)).toBeTruthy()` | `!!result === true` |
| `expect(fn([])).toBe(0)` | `input.length === 0 → result === 0` |
| `expect(fn(x)).toBeInstanceOf(Y)` | `result instanceof Y` |

### Workflow

1. When you see a test file, extract all `expect()` assertions
2. Group them by the function being tested
3. Separate assertions into:
   - **Preconditions** (from describe/it block names, setup code)
   - **Postconditions** (from expect assertions)
   - **Edge cases** (from specific value tests like `toBe(0)`)
4. When the user asks to debug or investigate, pass these inferred specs to `buggy_investigate`

### Example

```typescript
// Test file says:
describe('calculateTotal', () => {
  it('returns 0 for empty array', () => {
    expect(calculateTotal([])).toBe(0);
  });
  it('returns positive for valid items', () => {
    expect(calculateTotal([{price: 10, qty: 2}])).toBeGreaterThan(0);
  });
  it('handles single item', () => {
    expect(calculateTotal([{price: 5, qty: 1}])).toBe(5);
  });
});
```

```
// Inferred specification:
preconditions: ["Array.isArray(items)"]
postconditions: [
  "items.length === 0 ? result === 0 : result > 0",
  "result >= 0",
  "typeof result === 'number'"
]
```

### Key Insight

Tests only cover the inputs the developer thought of. Buggy fuzzes with thousands of inputs the developer DIDN'T think of. By combining the test-inferred specs with Buggy's fuzzer, you catch bugs that live between the test cases.
