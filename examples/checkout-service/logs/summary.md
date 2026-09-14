# Buggy findings — checkout-service

_Generated 2026-09-14T10:45:32.117Z_

**4 bugs proven** across 9 functions (5 clean).

| Function | Lang | File | Status | Trigger | Violated |
|---|---|---|---|---|---|
| `applyDiscount` | typescript | pricing.ts | unconfirmed | — | — |
| `pricePerUnit` | typescript | pricing.ts | confirmed_no_repair | `[0,0]` | !isNaN(result) |
| `averageOrderValue` | typescript | pricing.ts | confirmed_no_repair | `[[]]` | !isNaN(result) |
| `taxAmount` | typescript | pricing.ts | unconfirmed | — | — |
| `stockCoverageDays` | typescript | inventory.ts | confirmed_no_repair | `[0,0]` | !isNaN(result) |
| `reorderQuantity` | typescript | inventory.ts | unconfirmed | — | — |
| `split_payment` | python | discounts.py | confirmed_no_repair | `[0,0]` | function must not throw: ZeroDivisionError: division by zero |
| `bulk_unit_price` | python | discounts.py | unconfirmed | — | — |
| `clamp_percent` | python | discounts.py | unconfirmed | — | — |

## Proven bugs
- **pricePerUnit** (src/pricing.ts) — trigger `[0,0]` → !isNaN(result)
- **averageOrderValue** (src/pricing.ts) — trigger `[[]]` → !isNaN(result)
- **stockCoverageDays** (src/inventory.ts) — trigger `[0,0]` → !isNaN(result)
- **split_payment** (src/discounts.py) — trigger `[0,0]` → function must not throw: ZeroDivisionError: division by zero

## Clean (no bug found)
- applyDiscount (src/pricing.ts)
- taxAmount (src/pricing.ts)
- reorderQuantity (src/inventory.ts)
- bulk_unit_price (src/discounts.py)
- clamp_percent (src/discounts.py)
