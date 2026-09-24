"""Expense calculations for a small expense-tracking API.

This module intentionally ships with real defects so Buggy has something to
prove. Each bug is a pattern you actually hit in production code: dividing by a
caller-supplied count, averaging a possibly-empty collection, and applying an
unclamped percentage.
"""


def split_expense(amount, people):
    """Split a bill evenly between people.

    BUG: `people == 0` raises ZeroDivisionError.
    """
    return amount / people


def average_expense(amounts):
    """Mean of a list of expense amounts.

    BUG: an empty list raises ZeroDivisionError (len == 0).
    """
    return sum(amounts) / len(amounts)


def apply_discount(price, percent_off):
    """Apply a percentage discount to a price.

    BUG: `percent_off > 100` produces a NEGATIVE price (no clamp).
    """
    return price - price * (percent_off / 100)


def monthly_average(yearly_total):
    """Average monthly spend from a yearly total.

    Clean: the divisor is a non-zero constant, so this cannot fail.
    """
    return yearly_total / 12
