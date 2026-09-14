# checkout-service (Buggy example)

A tiny, self-contained project used to demonstrate **Buggy** (the proof-carrying
debugger) end to end. The source files contain **intentional bugs** so you can
watch Buggy find, prove, and (attempt to) repair them, and see the experience
memory it builds.

## Layout

```
checkout-service/
├─ .debugger.yaml        # Buggy config (language: typescript; watchlist scope: team)
├─ src/
│  ├─ pricing.ts         # applyDiscount, pricePerUnit, averageOrderValue, taxAmount
│  ├─ inventory.ts       # stockCoverageDays, reorderQuantity
│  └─ discounts.py       # split_payment, bulk_unit_price, clamp_percent  (Python)
├─ run-buggy.mjs         # end-to-end runner that writes logs/
├─ logs/                 # generated: run.log, investigations.jsonl, summary.md, watchlist.log
└─ WORKFLOW.md           # the documented walkthrough with real results
```

## Run it

From the Buggy repo root (so `dist/` is built):

```bash
npm run build                                   # build Buggy once
node examples/checkout-service/run-buggy.mjs     # runs the full pipeline, writes logs/
```

Then read `logs/summary.md` and `WORKFLOW.md`.

## Intentional bugs

| Function | File | Bug |
|---|---|---|
| `applyDiscount` | pricing.ts | discount > 100% → negative price |
| `pricePerUnit` | pricing.ts | quantity 0 → Infinity/NaN |
| `averageOrderValue` | pricing.ts | empty array → NaN |
| `stockCoverageDays` | inventory.ts | dailyUsage 0 → Infinity |
| `split_payment` | discounts.py | people 0 → ZeroDivisionError |
| `bulk_unit_price` | discounts.py | quantity 0 → ZeroDivisionError |

`taxAmount`, `reorderQuantity`, and `clamp_percent` are clean (Buggy should report them `unconfirmed`).
