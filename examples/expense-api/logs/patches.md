# Candidate fixes — expense-api

_Generated 2026-09-24T11:04:15.266Z_

Every fix Buggy proposed, with the overfitting score the classifier assigned.
**None of these were applied** — Buggy returns patches as data so you stay in
control. Scores above the 0.5 threshold are rejected as likely overfit.

## `split_expense` (src/expenses.py) — confirmed_no_repair

Trigger: `[0,0]` → function must not throw: ZeroDivisionError: division by zero

**REJECTED** — overfitting 93.0%
Rejected because: Overfitting risk: top factors - identifier_count, statement_count, nesting_depth
```python
if people == 0:
    return 0.0
```

**REJECTED** — overfitting 97.5%
Rejected because: Overfitting risk: top factors - identifier_count, statement_count, nesting_depth
```python
    return 0.0
```

**REJECTED** — overfitting 93.0%
Rejected because: Overfitting risk: top factors - identifier_count, statement_count, nesting_depth
```python
    if people == 0:
        return 0.0
```


## `average_expense` (src/expenses.py) — confirmed_no_repair

Trigger: `[[]]` → function must not throw: ZeroDivisionError: division by zero

**REJECTED** — overfitting 93.0%
Rejected because: Overfitting risk: top factors - identifier_count, statement_count, nesting_depth
```python
if len(amounts) == 0:
    return 0.0
```

**REJECTED** — overfitting 98.7%
Rejected because: Overfitting risk: top factors - identifier_count, nesting_depth, statement_count
```python
    return 0.0
```

**REJECTED** — overfitting 93.0%
Rejected because: Overfitting risk: top factors - identifier_count, statement_count, nesting_depth
```python
    if len(amounts) == 0:
        return 0.0
```


## `budget_usage` (src/budget.py) — confirmed_no_repair

Trigger: `[0,0]` → function must not throw: ZeroDivisionError: division by zero

**REJECTED** — overfitting 86.0%
Rejected because: Overfitting risk: top factors - identifier_count, statement_count, nesting_depth
```python
if budget == 0:
    return 0.0
```

**REJECTED** — overfitting 97.2%
Rejected because: Overfitting risk: top factors - nesting_depth, identifier_count, statement_count
```python
    return 0.0
```

**REJECTED** — overfitting 86.0%
Rejected because: Overfitting risk: top factors - identifier_count, statement_count, nesting_depth
```python
    if budget == 0:
        return 0.0
```
