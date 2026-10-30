"""Buggy - proof-carrying debugging for Python.

Finds a real failing input by executing your code, verifies the failure three
ways before reporting it, and hands back a certificate naming the exact input
that broke the function.

A native Python reimplementation of the TypeScript original, written because
the original evaluated specifications as JavaScript even against Python
targets, which made Python specifications silently do nothing.

@module buggy
"""

from __future__ import annotations

__version__ = "0.1.0.dev0"

from .types import (
    Certificate,
    ConditionResult,
    ExecResult,
    FunctionInfo,
    OracleKind,
    Outcome,
    Parameter,
    ParamKind,
    Report,
    Signature,
    SpecWarning,
    Verdict,
    Violation,
)

__all__ = [
    "__version__",
    "Certificate",
    "ConditionResult",
    "ExecResult",
    "FunctionInfo",
    "OracleKind",
    "Outcome",
    "Parameter",
    "ParamKind",
    "Report",
    "Signature",
    "SpecWarning",
    "Verdict",
    "Violation",
]
