"""MCP server over stdio, so an agent can prove and repair defects directly.

    buggy-mcp

Speaks JSON-RPC 2.0, one UTF-8 message per line on stdin/stdout, and implements
the subset an agent needs: initialize, ping, tools/list, tools/call, plus empty
resources/list and prompts/list so clients that probe them do not error.

Written against the stdlib rather than the official SDK. The SDK installs fine,
but brings 27 transitive packages including a web server and a crypto library,
which is disproportionate for a stdio pipe and would end this package's
dependency-free install. The subset used here is small and has been stable
across every protocol revision.

Two failure modes this file exists to prevent:

- Anything written to stdout corrupts the protocol. The real stdout is taken
  private at startup and `sys.stdout` is pointed at stderr, so a stray print
  anywhere in the library is a harmless log line instead of a protocol
  violation.
- A tool that raises is not a protocol error. Per the spec, a failure inside a
  tool is reported as a successful `tools/call` carrying `isError: true`, so the
  agent sees the message and can react. Returning a JSON-RPC error instead makes
  clients treat it as a broken server.
"""

from __future__ import annotations

import dataclasses
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Callable

from . import __version__
from .inspection import (
    SourceSyntaxError,
    describe_unsupported,
    find_classes,
    find_functions,
)
from .prove import Config, investigate
from .repair import propose

SERVER_NAME = "buggy"

PREFERRED_PROTOCOL = "2025-06-18"
"""What we report when the client asks for something we do not recognise.

The spec expects the server to answer with a version it supports; the client
then decides whether to continue.
"""

KNOWN_PROTOCOLS = frozenset({
    "2024-11-05", "2025-03-26", "2025-06-18", "2026-07-28",
})
"""Revisions whose initialize/tools surface matches what is implemented here.
A client asking for one of these gets it echoed back."""

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


# --- Tool definitions ---

_FILE = {"type": "string",
         "description": "Path to the Python file, absolute or relative to cwd."}
_FUNCTION = {"type": "string",
             "description": "Function name. Use a dotted name for a class "
                            "member, e.g. 'Cart.total'."}
_PRE = {"type": "array", "items": {"type": "string"},
        "description": "Preconditions as PYTHON expressions over the parameter "
                       "names, e.g. 'budget > 0'. For an instance method the "
                       "constructor's parameters are in scope too. Inputs that "
                       "fail these are skipped, so they also decide which "
                       "inputs a fix is allowed to change."}
_POST = {"type": "array", "items": {"type": "string"},
         "description": "Postconditions as PYTHON expressions. 'result' is the "
                        "return value, e.g. 'result >= 0'. A condition that "
                        "cannot be evaluated is reported as a warning, never "
                        "silently skipped."}
_BUDGET = {"type": "integer",
           "description": "Inputs to execute before giving up. Default 300."}
_TIMEOUT = {"type": "number",
            "description": "Seconds allowed per call. Default 2."}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "buggy_functions",
        "description": (
            "List the functions in a Python file with their signatures, and say "
            "which can be investigated. Call this first when you do not know "
            "what is in a file, or when a function turns out not to be "
            "investigable and you need the reason."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"file": _FILE},
            "required": ["file"],
        },
    },
    {
        "name": "buggy_investigate",
        "description": (
            "Prove whether a Python function has a defect, by executing it on "
            "generated inputs. Returns a certificate naming the exact failing "
            "call, verified three ways: the input satisfied the preconditions, "
            "the failure was re-observed in a fresh process, and it recurred on "
            "repeat attempts. A proven finding is reproducible by hand. "
            "'unconfirmed' means no failing input was found within the budget "
            "and is NOT a proof of safety. Use this before editing a risky "
            "function, and after editing one to check the fix held."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "function": _FUNCTION, "file": _FILE,
                "preconditions": _PRE, "postconditions": _POST,
                "budget": _BUDGET, "timeout": _TIMEOUT,
                "receiver": {
                    "type": "string",
                    "description": "Expression building the object an instance "
                                   "method is called on, e.g. 'Cart([1, 2])'. "
                                   "Inferred from __init__ when omitted.",
                },
            },
            "required": ["function", "file"],
        },
    },
    {
        "name": "buggy_repair",
        "description": (
            "Prove a defect and then propose fixes, each verified by execution: "
            "does it parse, does the proven trigger stop failing, does anything "
            "that worked change, and do other inputs of the same shape get "
            "fixed too. Verdicts are 'verified', 'overfit' or 'rejected', each "
            "with the evidence. Nothing is written to the file. Show the user a "
            "verified patch and let them decide; apply it yourself only if they "
            "agree."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "function": _FUNCTION, "file": _FILE,
                "preconditions": _PRE, "postconditions": _POST,
                "budget": _BUDGET, "timeout": _TIMEOUT,
            },
            "required": ["function", "file"],
        },
    },
    {
        "name": "buggy_scan",
        "description": (
            "Investigate every supported function in a Python file and return "
            "one line per function. Use it to triage a file you are unfamiliar "
            "with. Note that any preconditions and postconditions apply to all "
            "functions alike, which is blunt; investigate individually for "
            "anything that matters."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "file": _FILE,
                "preconditions": _PRE, "postconditions": _POST,
                "budget": _BUDGET, "timeout": _TIMEOUT,
            },
            "required": ["file"],
        },
    },
]


# --- Serialisation ---


def _plain(value: Any) -> Any:
    """Make a result JSON-safe without losing NaN or infinity.

    Those values are the evidence for a whole class of finding, so they are
    emitted as JSON's non-standard NaN/Infinity literals rather than nulled.
    """
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {k: _plain(v) for k, v in dataclasses.asdict(value).items()}
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_plain(v) for v in value]
    if hasattr(value, "value") and type(value).__name__ in (
        "Outcome", "OracleKind", "Verdict", "ParamKind", "ReceiverKind"
    ):
        return value.value
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return repr(value)


def _target_file(args: dict[str, Any]) -> Path:
    """Resolve and check the `file` argument.

    Checked up front so a mistyped path comes back as a tool error the agent
    can see and correct. Left to `investigate`, it would surface as an ordinary
    report with status "skipped", which is indistinguishable at a glance from
    "this function cannot be analysed" and invites the agent to move on.
    """
    raw = args.get("file")
    if not raw:
        raise KeyError("file")
    path = Path(raw).expanduser()
    if not path.exists():
        raise OSError(f"no such file: {path}")
    if path.is_dir():
        raise OSError(f"expected a Python file, got a directory: {path}")
    if path.suffix != ".py":
        raise OSError(f"expected a .py file, got: {path}")
    return path


def _config(args: dict[str, Any]) -> Config:
    return Config(
        max_executions=int(args.get("budget") or 300),
        timeout=float(args.get("timeout") or 2.0),
        receiver=args.get("receiver"),
    )


def _reproduction(certificate: Any) -> str:
    """The call a human can paste into a REPL to see the failure."""
    call_args = ", ".join(repr(a) for a in certificate.args)
    receiver = certificate.receiver
    if receiver is not None and receiver.needed:
        owner, _, method = certificate.function.rpartition(".")
        return f"{receiver.render(owner or certificate.function)}.{method}({call_args})"
    return f"{certificate.function}({call_args})"


def _report_payload(report: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "function": report.function,
        "file": report.file,
        "status": report.status,
        "executions": report.executions,
        "filtered_by_preconditions": report.filtered,
        "duration_ms": round(report.duration_ms, 1),
    }
    if report.note:
        out["note"] = report.note
    if report.warnings:
        # Listed first in importance: a condition that did not run means the
        # property the user cared about was never checked.
        out["specifications_not_checked"] = [
            {"condition": w.condition, "role": w.role, "reason": w.reason}
            for w in report.warnings
        ]
    if report.certificate is not None:
        c = report.certificate
        out["certificate"] = {
            "input": _plain(c.args),
            "observed": _plain(c.observed),
            "broke": c.rule,
            "kind": c.kind.value,
            "detail": c.detail,
            "reproduce": _reproduction(c),
            "built_on": (c.receiver.render(c.function.rpartition(".")[0])
                         if c.receiver is not None and c.receiver.needed else None),
            "verified": {
                "admissible_at": c.admissible_at,
                "sound_at": c.sound_at,
                "reproducible_at": c.reproducible_at,
                "reproductions": f"{c.reproductions}/{c.attempts}",
            },
        }
    if report.status == "unconfirmed":
        out["caveat"] = ("no failing input was found within the budget; this is "
                         "not a proof of safety")
    return out


# --- Tool handlers ---


def tool_functions(args: dict[str, Any]) -> dict[str, Any]:
    path = _target_file(args)
    source = path.read_text(encoding="utf-8")
    classes = find_classes(source, str(path))
    entries = []
    for info in find_functions(source, str(path)):
        reason = describe_unsupported(info, classes)
        entries.append({
            "name": info.qualified_name,
            "kind": info.kind,
            "line": info.line,
            "signature": [
                {"name": p.name, "annotation": p.annotation,
                 "has_default": p.has_default, "kind": p.kind.value}
                for p in info.signature.parameters
            ],
            "returns": info.signature.return_annotation,
            "investigable": reason is None,
            "reason": reason,
        })
    return {"file": str(path), "count": len(entries), "functions": entries}


def tool_investigate(args: dict[str, Any]) -> dict[str, Any]:
    path = _target_file(args)
    if not args.get("function"):
        raise KeyError("function")
    report = investigate(
        path, args["function"],
        preconditions=args.get("preconditions"),
        postconditions=args.get("postconditions"),
        config=_config(args),
    )
    return _report_payload(report)


def tool_repair(args: dict[str, Any]) -> dict[str, Any]:
    path = _target_file(args)
    if not args.get("function"):
        raise KeyError("function")
    config = _config(args)
    report = investigate(
        path, args["function"],
        preconditions=args.get("preconditions"),
        postconditions=args.get("postconditions"),
        config=config,
    )
    payload = _report_payload(report)
    payload["candidates"] = []

    if report.certificate is None:
        payload["repair_note"] = "nothing to repair: no failure was proven"
        return payload

    result = propose(
        path, args["function"],
        certificate=report.certificate,
        preconditions=args.get("preconditions"),
        postconditions=args.get("postconditions"),
        timeout=config.timeout,
    )
    source = path.read_text(encoding="utf-8")
    payload["candidates"] = [
        {
            "verdict": evidence.verdict,
            "summary": patch.summary,
            "rationale": patch.rationale,
            "evidence": evidence.reason,
            "strategy": patch.strategy,
            "insert_before_line": patch.insert_before_line,
            "lines": patch.lines,
            "diff": patch.diff(source),
        }
        for patch, evidence in result.candidates
    ]
    payload["verified_count"] = sum(
        1 for c in payload["candidates"] if c["verdict"] == "verified"
    )
    payload["repair_note"] = ("nothing was written to the file; show the user a "
                              "verified patch and let them decide")
    return payload


def tool_scan(args: dict[str, Any]) -> dict[str, Any]:
    path = _target_file(args)
    source = path.read_text(encoding="utf-8")
    classes = find_classes(source, str(path))
    config = _config(args)

    rows = []
    proven = 0
    for info in find_functions(source, str(path)):
        if describe_unsupported(info, classes) is not None:
            continue
        report = investigate(
            path, info.qualified_name,
            preconditions=args.get("preconditions"),
            postconditions=args.get("postconditions"),
            config=config,
        )
        if report.status == "proven":
            proven += 1
        row = {"function": report.function, "status": report.status}
        if report.certificate is not None:
            row["input"] = _plain(report.certificate.args)
            row["broke"] = report.certificate.rule
            row["reproduce"] = _reproduction(report.certificate)
        if report.note:
            row["note"] = report.note
        rows.append(row)

    return {"file": str(path), "investigated": len(rows), "proven": proven,
            "results": rows}


HANDLERS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "buggy_functions": tool_functions,
    "buggy_investigate": tool_investigate,
    "buggy_repair": tool_repair,
    "buggy_scan": tool_scan,
}


# --- JSON-RPC plumbing ---


class Server:
    """Handles one stdio session."""

    def __init__(self, out: Any) -> None:
        self._out = out
        self._initialized = False

    def send(self, message: dict[str, Any]) -> None:
        self._out.write(json.dumps(message) + "\n")
        self._out.flush()

    def reply(self, request_id: Any, result: dict[str, Any]) -> None:
        self.send({"jsonrpc": "2.0", "id": request_id, "result": result})

    def fail(self, request_id: Any, code: int, message: str) -> None:
        """A protocol-level error. Not for tool failures; see `call_tool`."""
        self.send({"jsonrpc": "2.0", "id": request_id,
                   "error": {"code": code, "message": message}})

    def handle(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        request_id = message.get("id")
        params = message.get("params") or {}

        # A notification has no id and must not be answered.
        if request_id is None:
            return

        if method == "initialize":
            requested = params.get("protocolVersion")
            self._initialized = True
            self.reply(request_id, {
                "protocolVersion": (requested if requested in KNOWN_PROTOCOLS
                                    else PREFERRED_PROTOCOL),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": __version__},
                "instructions": (
                    "Proves defects in Python functions by executing them, and "
                    "verifies proposed fixes the same way. Conditions are "
                    "Python expressions. A 'proven' finding is reproducible by "
                    "hand; 'unconfirmed' means not found within budget and is "
                    "not a proof of safety."
                ),
            })
        elif method == "ping":
            self.reply(request_id, {})
        elif method == "tools/list":
            self.reply(request_id, {"tools": TOOLS})
        elif method == "resources/list":
            self.reply(request_id, {"resources": []})
        elif method == "prompts/list":
            self.reply(request_id, {"prompts": []})
        elif method == "tools/call":
            self.call_tool(request_id, params)
        else:
            self.fail(request_id, METHOD_NOT_FOUND, f"unknown method: {method}")

    def call_tool(self, request_id: Any, params: dict[str, Any]) -> None:
        name = params.get("name")
        args = params.get("arguments") or {}
        handler = HANDLERS.get(name)

        if handler is None:
            self.fail(request_id, INVALID_PARAMS, f"unknown tool: {name}")
            return

        try:
            payload = handler(args)
            is_error = False
        except KeyError as exc:
            payload = {"error": f"missing required argument: {exc.args[0]}"}
            is_error = True
        except (OSError, SourceSyntaxError) as exc:
            payload = {"error": str(exc)}
            is_error = True
        except Exception as exc:  # noqa: BLE001
            # Reported as a tool failure, not a JSON-RPC error: the agent can
            # read this and react, whereas a protocol error reads as a broken
            # server. The traceback goes to stderr for whoever is debugging.
            traceback.print_exc(file=sys.stderr)
            payload = {"error": f"{type(exc).__name__}: {exc}"}
            is_error = True

        text = json.dumps(_plain(payload), indent=2, allow_nan=True)
        self.reply(request_id, {
            "content": [{"type": "text", "text": text}],
            "structuredContent": _plain(payload),
            "isError": is_error,
        })


def _take_stdout() -> Any:
    """Claim the real stdout for the protocol and redirect everyone else.

    stdout is the wire here. A stray print from any library would land in the
    middle of a JSON-RPC message and break the session, so `sys.stdout` is
    pointed at stderr where it becomes a harmless log line.
    """
    private_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(private_fd, "w", encoding="utf-8", buffering=1)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__, file=sys.stderr)
        return 0
    if argv and argv[0] == "--version":
        print(f"buggy-mcp {__version__}", file=sys.stderr)
        return 0

    out = _take_stdout()
    server = Server(out)

    for line in sys.stdin:
        line = line.strip().lstrip("\ufeff")
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError as exc:
            server.fail(None, PARSE_ERROR, f"invalid JSON: {exc}")
            continue
        if not isinstance(message, dict):
            server.fail(None, INVALID_REQUEST, "expected a JSON-RPC object")
            continue
        try:
            server.handle(message)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            if message.get("id") is not None:
                server.fail(message.get("id"), INTERNAL_ERROR,
                            f"{type(exc).__name__}: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
