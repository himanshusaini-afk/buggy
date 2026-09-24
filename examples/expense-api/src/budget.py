"""Budget calculations.

Contains one proven defect and two functions that are genuinely safe, so the
example shows Buggy reporting both `confirmed_*` and `unconfirmed` outcomes.
"""


def budget_usage(spent, budget):
    """Percentage of the budget consumed.

    BUG: `budget == 0` raises ZeroDivisionError.
    """
    return (spent / budget) * 100


def remaining_budget(budget, spent):
    """Money left in the budget, never negative.

    Clean: clamped at 0.
    """
    return max(0, budget - spent)


def clamp_percent(value):
    """Force a value into the 0-100 range.

    Clean: bounded by construction, so it can never return out-of-range.
    """
    return max(0, min(100, value))
