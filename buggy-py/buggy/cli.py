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
from .store import Store, to_pytest
from .models import Report

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
    recorded = None
    if args.record and report.certificate is not None:
        with Store(Path(args.file).resolve().parent) as store:
            finding, regression = store.record(
                report.certificate,
                preconditions=args.pre, postconditions=args.post)
            recorded = (finding, regression)

    if args.json:
        payload = dataclasses.asdict(report)
        if recorded:
            payload["recorded"] = {"id": recorded[0].id,
                                   "regression": recorded[1]}
        _dump(payload)
    else:
        _print_report(report, args.verbose)
        if recorded:
            finding, regression = recorded
            print(f"  recorded as {paint('cyan', finding.id)}"
                  + paint("dim", f"  (seen {finding.times_seen}x)"))
            if regression:
                print("  " + paint("red", "REGRESSION") +
                      ": this was recorded as fixed and is failing again.")
            print()
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


_STORE_STYLE = {"open": "red", "fixed": "green", "regressed": "red",
                "unreachable": "yellow", "still_failing": "red"}


def _store(args: argparse.Namespace) -> Store:
    return Store(Path(getattr(args, "root", ".")).resolve())


def cmd_findings(args: argparse.Namespace) -> int:
    with _store(args) as store:
        if not store.exists():
            message = ("no defects recorded yet. Run 'buggy investigate "
                       "... --record' first.")
            if args.json:
                _dump({"total": 0, "findings": [], "note": message})
            else:
                print(f"\n  {message}\n")
            return 0

        found = store.findings(status=args.status, function=args.function)
        summary = store.summary()

        if args.json:
            _dump({**summary, "findings": found})
            return 0

        print()
        print(paint("bold", f"  {summary['total']} recorded defect(s)")
              + paint("dim", f"  {summary['database']}"))
        print(paint("dim", "  " + "-" * 70))
        for f in found:
            style = _STORE_STYLE.get(f.status, "dim")
            print(f"  {paint(style, f'[{f.status}]'):<20} "
                  f"{paint('cyan', f.reproduce())}")
            print(paint("dim", f"      {f.rule}"))
            print(paint("dim", f"      {f.id}  seen {f.times_seen}x, "
                               f"last {f.last_seen[:19]}"))
        if summary["regressed"]:
            print()
            print("  " + paint("red", f"{summary['regressed']} regressed")
                  + ": proven again after being recorded as fixed.")
        print()
        print(paint("dim", "  'buggy recheck' re-runs these. "
                           "'buggy export-tests' turns them into pytest cases."))
        print()
    return 0


def cmd_recheck(args: argparse.Namespace) -> int:
    with _store(args) as store:
        if not store.exists():
            if args.json:
                _dump({"checked": 0, "results": []})
            else:
                print("\n  nothing recorded to recheck.\n")
            return 0

        results = store.recheck(timeout=args.timeout, function=args.function,
                                python=args.python)
        if args.json:
            _dump({"checked": len(results), "results": results})
            return 0

        print()
        print(paint("bold", f"  rechecked {len(results)} recorded defect(s)"))
        print(paint("dim", "  " + "-" * 70))
        counts: dict[str, int] = {}
        for r in results:
            counts[r.outcome] = counts.get(r.outcome, 0) + 1
            style = _STORE_STYLE.get(r.outcome, "dim")
            print(f"  {paint(style, f'[{r.outcome}]'):<22} "
                  f"{paint('cyan', r.finding.reproduce())}")
            if r.detail:
                print(paint("dim", f"      {r.detail}"))
        print(paint("dim", "  " + "-" * 70))
        print("  " + ", ".join(f"{n} {name}" for name, n in sorted(counts.items())))

        regressions = [r for r in results if r.is_regression]
        if regressions:
            print()
            print("  " + paint("red", f"{len(regressions)} REGRESSION(S)")
                  + ": these were fixed and are failing again.")
        print()

        # A regression is the one outcome worth failing a build over.
        return 1 if regressions else 0


def cmd_export(args: argparse.Namespace) -> int:
    with _store(args) as store:
        if not store.exists():
            warn("nothing recorded to export.")
            return 1
        found = store.findings(status=args.status)
        if not found:
            warn("no findings match; nothing written.")
            return 1
        text = to_pytest(found)

    if args.output:
        target = Path(args.output)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        if args.json:
            _dump({"written": str(target), "tests": len(found)})
        else:
            print(f"\n  wrote {len(found)} test(s) to "
                  f"{paint('cyan', str(target))}")
            print(paint("dim", "  Each asserts the failure is gone, so the file "
                               "passes once the defects are fixed."))
            print()
    else:
        # The generated module is data, so it goes to stdout where it can be
        # piped; the note about it goes to stderr.
        print(text)
        warn(f"{len(found)} test(s) generated. Redirect to a file, or use -o.")
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
    p_inv.add_argument("--record", action="store_true",
                       help="store a proven defect in .buggy/ so it can be "
                            "re-run later with 'buggy recheck'")
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

    p_findings = sub.add_parser(
        "findings", help="list defects recorded in this project")
    p_findings.add_argument("--status", default=None,
                            choices=["open", "fixed", "regressed", "unreachable"])
    p_findings.add_argument("--function", default=None)
    p_findings.add_argument("--root", default=".",
                            help="project root holding .buggy/ (default: cwd)")
    shared(p_findings)
    p_findings.set_defaults(handler=cmd_findings)

    p_recheck = sub.add_parser(
        "recheck", help="re-run every recorded trigger and report what changed")
    p_recheck.add_argument("--function", default=None)
    p_recheck.add_argument("--root", default=".")
    p_recheck.add_argument("--timeout", type=float, default=2.0, metavar="S")
    p_recheck.add_argument("--python", default=None, metavar="PATH")
    shared(p_recheck)
    p_recheck.set_defaults(handler=cmd_recheck)

    p_export = sub.add_parser(
        "export-tests", help="write recorded defects out as pytest cases")
    p_export.add_argument("-o", "--output", default=None, metavar="PATH",
                          help="file to write (default: stdout)")
    p_export.add_argument("--status", default=None)
    p_export.add_argument("--root", default=".")
    shared(p_export)
    p_export.set_defaults(handler=cmd_export)

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
