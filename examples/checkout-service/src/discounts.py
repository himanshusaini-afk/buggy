"""Checkout discounts (Python).

Originally shipped with intentional bugs Buggy proved by execution
(see WORKFLOW.md); the guards below are the applied fixes.
"""


def split_payment(total, people):
    # Guard division by zero (would raise ZeroDivisionError).
    if people == 0:
        return 0.0
    return total / people


def bulk_unit_price(total, quantity):
    # Guard division by zero (would raise ZeroDivisionError).
    if quantity == 0:
        return 0.0
    return total / quantity


def clamp_percent(value):
    # Clean: always returns a value in [0, 100].
    return max(0, min(100, value))
