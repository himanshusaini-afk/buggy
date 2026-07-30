---
inclusion: manual
---

# Buggy — Type Narrowing Suggestions

When Buggy proves a bug exists, suggest TypeScript type-level fixes that would prevent the bug at compile time — moving the check from runtime to the type system.

## Triggering Phrases

- "how can I prevent this at the type level?"
- "make this type-safe"
- "prevent this class of bug"
- "strengthen the types"

## Workflow

### After a Bug is Proven

When `buggy_investigate` returns a proof certificate, analyze the root cause and suggest type-level prevention:

### Pattern: Unbounded Numeric Input

**Bug:** `discountPercent > 100` causes negative result

**Type fix:** Branded type

```typescript
type Percent = number & { readonly __brand: unique symbol };

function asPercent(value: number): Percent {
  if (value < 0 || value > 100) throw new RangeError(`${value} is not a valid percent`);
  return value as Percent;
}

function applyDiscount(price: number, discount: Percent): number {
  return price - (price * discount / 100); // Now safe — discount is always 0-100
}
```

### Pattern: Division by Zero (Empty Array)

**Bug:** `items.length === 0` causes `NaN`

**Type fix:** NonEmpty array type

```typescript
type NonEmptyArray<T> = [T, ...T[]];

function calculateAverage(items: NonEmptyArray<CartItem>): number {
  const total = items.reduce((sum, item) => sum + item.price, 0);
  return total / items.length; // Safe — items.length >= 1
}
```

### Pattern: Nullable Return Without Check

**Bug:** `result` is `null` but caller doesn't check

**Type fix:** Explicit Result type

```typescript
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

function findUser(id: string): Result<User, 'not_found' | 'invalid_id'> {
  // Caller MUST handle the error case — TypeScript enforces it
}
```

### Pattern: Non-Deterministic Behavior

**Bug:** Function uses `Math.random()` making it non-deterministic

**Type fix:** Explicit effect type or dependency injection

```typescript
interface RandomSource {
  next(): number; // 0-1
}

// Now the randomness is injectable and testable
function calculateLoyaltyPoints(total: number, random: RandomSource): number {
  const bonus = random.next() > 0.5 ? 10 : 0;
  return Math.floor(total / 10) + bonus;
}
```

### Pattern: Integer Overflow

**Bug:** `price * quantity` exceeds `Number.MAX_SAFE_INTEGER`

**Type fix:** SafeInt branded type with validation

```typescript
type SafeInt = number & { readonly __safeInt: unique symbol };

function asSafeInt(value: number): SafeInt {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${value} exceeds safe integer range`);
  return value as SafeInt;
}

function multiply(a: SafeInt, b: SafeInt): SafeInt {
  const result = a * b;
  return asSafeInt(result); // Throws if overflow occurs
}
```

## Presentation Format

When suggesting type narrowing, present it as:

```
🛡️ Type-Level Prevention

The bug (discountPercent > 100 → negative result) can be prevented at compile time:

Before: function applyDiscount(price: number, discount: number)
After:  function applyDiscount(price: number, discount: Percent)

This means any caller passing an unchecked number will get a TypeScript error.
The validation happens once at the system boundary, not in every function.

Want me to apply this type narrowing?
```
