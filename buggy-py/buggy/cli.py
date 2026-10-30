"""Command line interface.

Diagnostics go to stderr, data goes to stdout. That separation is not cosmetic:
``--json`` exists so another program can read the output, and a single stray
informational line on stdout makes the document unparseable. The original
implementation carried a comment about exactly this bug.

@module buggy.cli
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import sys
from pathlib import Path
from typing import Any, Sequence

from . import __version__
from .inspection import (
    SourceSyntaxError,
    describe_unsupported,
    find_classes,
    find_functions,
)
from .prove import Config, investigate
from .repair import propose
from .types import Report

# --- Presentation ---

_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR") \
    and os.environ.get("TERM") != "dumb"

_CODES = {
    "bold": "1", "dim": "2", "red": "31", "green": "32",
    "yellow": "33", "cyan": "36", "magenta": "35",
}


def paint(style: str, text: str) -> str:
    if not _COLOR:
        return text
    return f"\x1b[{_CODES[style]}m{text}\x1b[0m"


def warn(message: str) -> None:
    print(message, file=sys.stderr)


_STATUS_STYLE = {
    "proven": "red",      # a proven defect is bad news; colour it that way
    "unconfirmed": "green",
    "no_valid_input": "yellow",
    "skipped": "yellow",
}


def _encode(value: Any) -> Any:
    """Make a report JSON-serialisable without losing NaN or infinity."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {k: _encode(v) for k, v in dataclasses.asdict(value).items()}
    if isinstance(value, dict):
        return {k: _encode(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_encode(v) for v in value]
    if hasattr(value, "value") and type(value).__name__ in ("Outcome", "OracleKind", "Verdict", "ParamKind"):
        return value.value
    return value


def _dump(payload: Any) -> None:
    # allow_nan keeps NaN and Infinity in the output. They are the evidence for
    # a whole class of finding, and turning them into null would erase it.
    print(json.dumps(_encode(payload), indent=2, default=repr, allow_nan=True))


# --- Commands ---


def cmd_functions(args: argparse.Namespace) -> int:
    path = Path(args.file)
    try:
        source = path.read_text(encoding="utf-8")
    except OSError as exc:
        warn(paint("red", "error: ") + str(exc))
        return 1

    try:
        functions = find_functions(source, str(path))
    except SourceSyntaxError as exc:
        if args.json:
            _dump({"error": str(exc), "type": "SyntaxError"})
        else:
            warn(paint("red", "syntax error: ") + str(exc))
        return 1

    classes = find_classes(source, str(path))
    entries = []
    for info in functions:
        reason = describe_unsupported(info, classes)
        entries.append({
            "name": info.qualified_name,
            "kind": info.kind,
            "line": info.line,
            "end_line": info.end_line,
            "parameters": [
                {"name": p.name, "annotation": p.annotation, "has_default": p.has_default,
                 "kind": p.kind.value}
                for p in info.signature.parameters
            ],
            "returns": info.signature.return_annotation,
            "needs_receiver": info.needs_receiver,
            "owner": info.owner,
            "investigable": reason is None,
            "reason": reason,
        })

    if args.json:
        _dump({"file": str(path), "count": len(entries), "functions": entries})
        return 0

    if not entries:
        print(f"  no functions found in {path}")
        return 0

    print()
    print(paint("bold", f"  {len(entries)} function(s) in {path}"))
    print(paint("dim", "  " + "-" * 70))
    for entry in entries:
        params = ", ".join(
            p["name"] + (f": {p['annotation']}" if p["annotation"] else "")
            for p in entry["parameters"]
        )
        mark = paint("green", "*") if entry["investigable"] else paint("dim", "-")
        print(f"  {mark} {paint('cyan', entry['name'])}({params})"
              + paint("dim", f"  L{entry['line']}"))
        if entry["reason"]:
            print(paint("dim", f"      skipped: {entry['reason']}"))
    print()
    return 0


def _reproduction(cert) -> str:
    """The exact call a reader can paste into a REPL.

    For an instance method this must include the construction, because
    ``total(0)`` is not something anyone can run; ``Cart([1, 2]).total(0)`` is.
    A certificate the reader cannot re-run is not evidence.
    """
    call_args = ", ".join(repr(a) for a in cert.args)
    receiver = cert.receiver
    if receiver is not None and receiver.needed:
        owner, _, method = cert.function.rpartition(".")
        return f"{receiver.render(owner or cert.function)}.{method}({call_args})"
    return f"{cert.function}({call_args})"


def _print_report(report: Report, verbose: bool) -> None:
    style = _STATUS_STYLE.get(report.status, "dim")
    print()
    print(paint("bold", f"  {report.function}") + paint("dim", f"  ({report.file})"))
    print(paint("dim", "  " + "-" * 70))
    print(f"  status      {paint(style, report.status)}")

    for w in report.warnings:
        print("  " + paint("yellow", "! ") +
              f"{w.role} not checked: {paint('cyan', w.condition)}")
        print(paint("dim", f"      {w.reason}"))

    cert = report.certificate
    if cert is not None:
        print()
        print(paint("bold", "  Certificate of failure"))
        if cert.receiver is not None and cert.receiver.needed:
            owner = cert.function.rpartition(".")[0]
            print(f"    built on    {paint('cyan', cert.receiver.render(owner))}"
                  + paint("dim", "  (rebuilt for every call)"))
        print(f"    input       {paint('cyan', repr(cert.args))}")
        print(f"    result      {cert.observed!r}")
        print(f"    broke       {paint('red', cert.rule)}")
        if cert.detail:
            print(f"    detail      {cert.detail}")
        print(paint("dim", f"    admissible  {cert.admissible_at}"))
        print(paint("dim", f"    sound       {cert.sound_at}"))
        print(paint("dim", f"    reproduced  {cert.reproductions}/{cert.attempts}"
                           f"  at {cert.reproducible_at}"))
        print()
        print("  " + paint("dim", "Call it yourself to see it fail:"))
        print(f"    {paint('cyan', _reproduction(cert))}")

    if report.note:
        print()
        print(f"  note        {report.note}")

    if verbose or report.status == "unconfirmed":
        print()
        print(paint("dim", f"  {report.executions} executed, "
                           f"{report.filtered} filtered by preconditions, "
                           f"{report.environment_errors} harness errors, "
                           f"{report.duration_ms:.0f}ms"))
    if report.status == "unconfirmed":
        print(paint("dim", "  'unconfirmed' means no failing input was found "
                           "within budget. It is not a proof of safety."))
    elif report.status == "no_valid_input":
        print(paint("yellow", "  the function was never called - this result "
                              "says nothing about it."))
    print()


def cmd_investigate(args: argparse.Namespace) -> int:
    config = Config(
        max_executions=args.budget,
        timeout=args.timeout,
        determinism_checks=args.determinism,
        python=args.python,
        receiver=args.receiver,
    )
    report = investigate(
        args.file, args.function,
        preconditions=args.pre, postconditions=args.post, config=config,
    )
    if args.json:
        _dump(report)
    else:
        _print_report(report, args.verbose)
    # A proven defect is a finding, not a failure of the tool, so exit 0 unless
    # we could not do the work at all.
    return 1 if report.status == "skipped" else 0


_VERDICT_STYLE = {"verified": "green", "overfit": "yellow", "rejected": "red"}


def cmd_repair(args: argparse.Namespace) -> int:
    config = Config(
        max_executions=args.budget, timeout=args.timeout,
        python=args.python, receiver=args.receiver,
    )
    report = investigate(
        args.file, args.function,
        preconditions=args.pre, postconditions=args.post, config=config,
    )

    if report.certificate is None:
        if args.json:
            _dump({"function": args.function, "status": report.status,
                   "note": report.note, "candidates": []})
        else:
            _print_report(report, args.verbose)
            print("  nothing to repair: no failure was proven.")
            print()
        return 0

    result = propose(
        args.file, args.function,
        certificate=report.certificate,
        preconditions=args.pre,
        postconditions=args.post,
        timeout=args.timeout,
        python=args.python,
    )

    if args.json:
        _dump({
            "function": result.function,
            "file": result.file,
            "certificate": result.certificate,
            "candidates": [
                {"patch": p, "evidence": e, "verdict": e.verdict,
                 "reason": e.reason, "diff": p.diff(
                     Path(args.file).read_text(encoding="utf-8"))}
                for p, e in result.candidates
            ],
        })
        return 0

    _print_report(report, args.verbose)
    source = Path(args.file).read_text(encoding="utf-8")

    print(paint("bold", f"  Candidate fixes ({len(result.candidates)})"))
    print(paint("dim", "  " + "-" * 70))
    if not result.candidates:
        print("  none: the trigger did not suggest a guard.")
        print()
        return 0

    for patch, evidence in result.candidates:
        style = _VERDICT_STYLE.get(evidence.verdict, "dim")
        # The verdict word carries the meaning; a symbol beside it would only
        # repeat itself ("ok VERIFIED").
        label = f"{evidence.verdict.upper():<8}"
        print(f"  {paint(style, label)}  {patch.summary}")
        print(paint("dim", f"      {patch.rationale}"))
        print(paint("dim", f"      {evidence.reason}"))
        if args.verbose or evidence.verdict == "verified":
            for line in patch.diff(source).splitlines():
                colour = "green" if line.startswith("+") else "dim"
                print(f"      {paint(colour, line)}")
        print()

    print(paint("dim", "  " + "-" * 70))
    print("  Nothing was written to your file. Apply a fix yourself, or review "
          "the diff above.")
    print()
    return 0


def cmd_scan(args: argparse.Namespace) -> int:
    path = Path(args.file)
    try:
        source = path.read_text(encoding="utf-8")
        functions = find_functions(source, str(path))
    except (OSError, SourceSyntaxError) as exc:
        warn(paint("red", "error: ") + str(exc))
        return 1

    config = Config(
        max_executions=args.budget, timeout=args.timeout,
        determinism_checks=args.determinism, python=args.python,
        receiver=args.receiver,
    )

    classes = find_classes(source, str(path))
    post = args.post or []
    reports: list[Report] = []
    for info in functions:
        if describe_unsupported(info, classes) is not None and not args.json:
            continue
        reports.append(investigate(
            path, info.qualified_name,
            preconditions=args.pre, postconditions=post, config=config,
        ))

    if args.json:
        _dump({"file": str(path), "reports": reports})
        return 0

    proven = [r for r in reports if r.status == "proven"]
    print()
    print(paint("bold", f"  {path}"))
    print(paint("dim", "  " + "-" * 70))
    for r in reports:
        style = _STATUS_STYLE.get(r.status, "dim")
        mark = paint("red", "[fail]") if r.status == "proven" else (
            paint("green", "[pass]") if r.status == "unconfirmed"
            else paint("yellow", "[skip]")
        )
        trigger = repr(r.certificate.args) if r.certificate else ""
        print(f"  {mark} {r.function:<28} {paint(style, r.status):<22} "
              f"{paint('cyan', trigger)}")
        if r.certificate:
            print(paint("dim", f"      broke: {r.certificate.rule}"))
        for w in r.warnings:
            print("      " + paint("yellow", "! ") + f"{w.condition} - {w.reason}")
    print(paint("dim", "  " + "-" * 70))
    print(f"  {len(proven)} proven, {len(reports) - len(proven)} not confirmed, "
          f"of {len(reports)} investigated")
    print()
    return 0


# --- Entry point ---


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="buggy",
        description="Prove bugs in Python functions by executing them.",
        epilog=(
            "Conditions are Python expressions. Parameter names are in scope, "
            "and postconditions also see 'result'.\n"
            "  buggy investigate budget_usage -f budget.py "
            "--pre 'budget > 0' --post 'result >= 0'"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=f"buggy {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    def shared(p: argparse.ArgumentParser) -> None:
        p.add_argument("--json", action="store_true",
                       help="emit JSON on stdout (machine-readable)")
        p.add_argument("-v", "--verbose", action="store_true")

    def search_opts(p: argparse.ArgumentParser) -> None:
        p.add_argument("--budget", type=int, default=300, metavar="N",
                       help="inputs to execute before giving up (default 300)")
        p.add_argument("--timeout", type=float, default=2.0, metavar="S",
                       help="seconds allowed per call (default 2)")
        p.add_argument("--determinism", type=int, default=0, metavar="N",
                       help="repeat executions per input to detect nondeterminism")
        p.add_argument("--python", default=None, metavar="PATH",
                       help="interpreter to run the target with "
                            "(default: this one, or $BUGGY_PYTHON)")
        p.add_argument("--receiver", default=None, metavar="EXPR",
                       help="expression building the object an instance method "
                            "is called on, e.g. 'Cart(items=[1,2])'. Inferred "
                            "from __init__ when omitted.")

    p_functions = sub.add_parser("functions", help="list functions in a file")
    p_functions.add_argument("file")
    shared(p_functions)
    p_functions.set_defaults(handler=cmd_functions)

    p_inv = sub.add_parser("investigate", help="investigate one function")
    p_inv.add_argument("function")
    p_inv.add_argument("-f", "--file", required=True)
    p_inv.add_argument("--pre", action="append", default=[], metavar="EXPR",
                       help="precondition; repeatable")
    p_inv.add_argument("--post", action="append", default=[], metavar="EXPR",
                       help="postcondition; repeatable")
    shared(p_inv)
    search_opts(p_inv)
    p_inv.set_defaults(handler=cmd_investigate)

    p_repair = sub.add_parser(
        "repair", help="investigate, then propose and verify fixes")
    p_repair.add_argument("function")
    p_repair.add_argument("-f", "--file", required=True)
    p_repair.add_argument("--pre", action="append", default=[], metavar="EXPR")
    p_repair.add_argument("--post", action="append", default=[], metavar="EXPR")
    shared(p_repair)
    search_opts(p_repair)
    p_repair.set_defaults(handler=cmd_repair)

    p_scan = sub.add_parser("scan", help="investigate every function in a file")
    p_scan.add_argument("file")
    p_scan.add_argument("--pre", action="append", default=[], metavar="EXPR")
    p_scan.add_argument("--post", action="append", default=[], metavar="EXPR")
    shared(p_scan)
    search_opts(p_scan)
    p_scan.set_defaults(handler=cmd_scan)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.handler(args))
    except KeyboardInterrupt:
        warn("interrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
