# Buggy findings — expense-api

_Generated 2026-09-24T09:43:35.849Z_

**3 bugs proven** across 7 functions (4 reported clean).

| Function | File | Status | Trigger | Violated rule |
|---|---|---|---|---|
| `split_expense` | expenses.py | confirmed_no_repair | `[0,0]` | function must not throw: ZeroDivisionError: division by zero |
| `average_expense` | expenses.py | confirmed_no_repair | `[[]]` | function must not throw: ZeroDivisionError: division by zero |
| `apply_discount` | expenses.py | unconfirmed | — | — |
| `monthly_average` | expenses.py | unconfirmed | — | — |
| `budget_usage` | budget.py | confirmed_no_repair | `[0,0]` | function must not throw: ZeroDivisionError: division by zero |
| `remaining_budget` | budget.py | unconfirmed | — | — |
| `clamp_percent` | budget.py | unconfirmed | — | — |

## Proven bugs
- **split_expense** — `[0,0]` → function must not throw: ZeroDivisionError: division by zero
- **average_expense** — `[[]]` → function must not throw: ZeroDivisionError: division by zero
- **budget_usage** — `[0,0]` → function must not throw: ZeroDivisionError: division by zero

## Reported clean (no violating input within budget)
- apply_discount (src/expenses.py)
- monthly_average (src/expenses.py)
- remaining_budget (src/budget.py)
- clamp_percent (src/budget.py)

> `unconfirmed` means "no failing input found within the search budget" — it is
> not a proof of safety. A proven bug, by contrast, is always a true positive:
> it was re-executed and observed to fail.
