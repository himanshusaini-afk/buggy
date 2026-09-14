"""Checkout discounts (Python).

NOTE: Contains intentional bugs so Buggy can prove them by execution.
See WORKFLOW.md for the run and the fixes.
"""


def split_payment(total, people):
    # BUG: people == 0 -> ZeroDivisionError.
    return total / people


def bulk_unit_price(total, quantity):
    # BUG: quantity == 0 -> ZeroDivisionError.
    return total / quantity


def clamp_percent(value):
    # Clean: always returns a value in [0, 100].
    return max(0, min(100, value))
