"""The worker process. Loads a target module once, then calls it repeatedly.

Run as a script, not imported:

    python3 -m buggy._worker [--cpu-seconds N] [--fsize-mb N]

Speaks newline-delimited JSON on stdin/stdout. Two protections live here rather
than in the parent:

- The target's output cannot corrupt the protocol. At startup fd 1 is
  duplicated for our private use and the original pointed at /dev/null, so a
  `print` in the target, or a C extension writing straight to fd 1, goes
  nowhere.
- Resource limits are self-imposed, before anything is loaded, so the parent
  needs no `preexec_fn` (unsafe in a threaded process). RLIMIT_CPU matters
  most: it kills runaway loops by signal, which a wall-clock timeout cannot do
  reliably when the child is wedged in C code.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from typing import Any

PROTOCOL_VERSION = 1


def _redirect_target_output() -> Any:
    """Take a private copy of stdout, then silence the real one.

    Returns a writable text stream connected to the parent. Must run before any
    target code is loaded.
    """
    private_fd = os.dup(1)
    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull_fd, 1)
    os.close(devnull_fd)
    # Re-point Python's own sys.stdout at the now-silenced fd 1 so that code
    # holding a reference to sys.stdout also writes nowhere.
    sys.stdout = open(1, "w", closefd=False)  # noqa: SIM115
    return os.fdopen(private_fd, "w", buffering=1, encoding="utf-8")


def _apply_limits(cpu_seconds: int | None, fsize_mb: int | None, address_mb: int | None) -> dict:
    """Lower our own resource limits. Reports what actually took effect.

    Nothing here is best-effort theatre: each limit is attempted and the result
    recorded, because enforcement is platform-dependent. On macOS, RLIMIT_AS
    and RLIMIT_DATA cannot be lowered at all (setrlimit raises ValueError),
    while RLIMIT_CPU works. Claiming a memory cap that the OS ignores would be
    worse than admitting there is none.
    """
    applied: dict[str, Any] = {}
    try:
        import resource
    except ImportError:  # pragma: no cover - Windows
        return {"supported": False}

    def _set(name: str, value: int) -> None:
        rid = getattr(resource, name, None)
        if rid is None:
            applied[name] = "unsupported"
            return
        try:
            soft, hard = resource.getrlimit(rid)
            new_hard = hard if hard != resource.RLIM_INFINITY else value
            resource.setrlimit(rid, (value, min(value, new_hard) if new_hard != resource.RLIM_INFINITY else value))
            applied[name] = value
        except (ValueError, OSError) as exc:
            applied[name] = f"rejected: {exc}"

    if cpu_seconds:
        _set("RLIMIT_CPU", cpu_seconds)
    if fsize_mb:
        _set("RLIMIT_FSIZE", fsize_mb * 1024 * 1024)
    if address_mb:
        _set("RLIMIT_AS", address_mb * 1024 * 1024)

    applied["supported"] = True
    return applied


def _encode(value: Any) -> tuple[Any, str]:
    """Prepare a return value for transport.

    ``json`` carries NaN, Infinity, -0.0 and arbitrary-precision ints between
    two Python processes without loss, so no sentinel encoding is needed (the
    TypeScript implementation required one in both directions because
    JSON.stringify destroys those values).

    Values JSON cannot represent at all are sent as their ``repr`` and flagged,
    so the parent knows not to evaluate postconditions against a lossy stand-in.

    @returns (payload, fidelity) where fidelity is ``exact`` or ``coerced``.
    """
    try:
        json.dumps(value)
        return value, "exact"
    except (TypeError, ValueError):
        return repr(value), "coerced"


class ReceiverError(Exception):
    """The object an instance method needs could not be built.

    Carried as its own exception type so the parent can classify it as a setup
    problem. A failure inside ``__init__`` says nothing about the method under
    test, and reporting it as that method's defect would be a false positive.
    """


def _resolve_attr(namespace: dict, dotted: str) -> tuple[Any, str | None]:
    """Walk a dotted name, so nested classes like ``Outer.Inner`` resolve."""
    parts = dotted.split(".")
    current: Any = namespace.get(parts[0], None)
    if current is None:
        return None, f"name not found in module: {parts[0]}"
    for part in parts[1:]:
        current = getattr(current, part, None)
        if current is None:
            return None, f"attribute not found: {part}"
    return current, None


def _resolve(namespace: dict, dotted: str) -> tuple[Any, Any, str | None]:
    """Resolve a possibly dotted name.

    @returns (target, owner_class, problem). `owner_class` is set only when the
        target is an instance method, in which case the caller must build a
        receiver before calling it. `target` is then the *unbound* function.
    """
    parts = dotted.split(".")
    current: Any = namespace.get(parts[0], None)
    if current is None:
        return None, None, f"name not found in module: {parts[0]}"

    owner: Any = None
    for part in parts[1:]:
        owner = current
        current = getattr(current, part, None)
        if current is None:
            return None, None, f"attribute not found: {part}"

    if not callable(current):
        return None, None, f"{dotted} is not callable"

    if owner is not None and isinstance(owner, type):
        raw = owner.__dict__.get(parts[-1])
        if isinstance(raw, (staticmethod, classmethod)):
            return current, None, None
        # A plain function on a class is an instance method. Hand back the class
        # so a receiver can be constructed for it.
        return current, owner, None

    return current, None, None


def _build_receiver(namespace: dict, owner: Any, spec: dict | None) -> Any:
    """Construct the object an instance method will be called on.

    Built fresh on every call. Sharing one instance across calls would let state
    written by an earlier call change the outcome of a later one, which breaks
    reproducibility and makes any stateful method look non-deterministic.

    @raises ReceiverError: construction failed, which is a setup problem.
    """
    kind = (spec or {}).get("kind", "construct")

    if kind == "expression":
        source = (spec or {}).get("source") or ""
        try:
            return eval(source, dict(namespace))  # noqa: S307 - user-supplied, by request
        except BaseException as exc:  # noqa: BLE001
            raise ReceiverError(
                f"--receiver expression failed: {type(exc).__name__}: {exc}"
            ) from exc

    args = (spec or {}).get("args") or []
    try:
        return owner(*args)
    except BaseException as exc:  # noqa: BLE001
        rendered = ", ".join(repr(a) for a in args)
        raise ReceiverError(
            f"{owner.__name__}({rendered}) failed: {type(exc).__name__}: {exc}"
        ) from exc


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--cpu-seconds", type=int, default=None)
    parser.add_argument("--fsize-mb", type=int, default=None)
    parser.add_argument("--address-mb", type=int, default=None)
    args = parser.parse_args()

    out = _redirect_target_output()
    limits = _apply_limits(args.cpu_seconds, args.fsize_mb, args.address_mb)

    def emit(payload: dict) -> None:
        out.write(json.dumps(payload, default=repr) + "\n")
        out.flush()

    emit({"event": "ready", "version": PROTOCOL_VERSION, "limits": limits,
          "executable": sys.executable, "python": sys.version.split()[0]})

    namespace: dict[str, Any] = {}
    loaded = False

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError as exc:
            emit({"event": "error", "error": f"malformed request: {exc}"})
            continue

        op = request.get("op")

        if op == "ping":
            emit({"event": "pong"})

        elif op == "shutdown":
            emit({"event": "bye"})
            return 0

        elif op == "load":
            namespace = {"__name__": "__buggy_target__"}
            try:
                code = compile(
                    request["source"], request.get("filename", "<target>"), "exec"
                )
                exec(code, namespace)  # noqa: S102 - executing the target is the job
                loaded = True
                emit({"event": "loaded",
                      "names": sorted(k for k in namespace if not k.startswith("__"))})
            except BaseException as exc:  # noqa: BLE001
                # Import-time failure means the module never loaded. This is an
                # environment problem, not a defect in the function under test,
                # and the parent classifies it as such.
                loaded = False
                emit({
                    "event": "load_failed",
                    "exception_type": type(exc).__name__,
                    "message": str(exc),
                    "traceback": traceback.format_exc(limit=20),
                })

        elif op == "construct":
            # A dedicated probe, so the parent can find a constructor that works
            # before it starts investigating. Doing this through `call` would
            # confuse "the class could not be built" with "the method failed".
            if not loaded:
                emit({"event": "constructed", "ok": False,
                      "message": "no target module has been loaded"})
                continue
            owner, problem = _resolve_attr(namespace, request["class"])
            if problem is not None:
                emit({"event": "constructed", "ok": False, "message": problem})
                continue
            try:
                instance = _build_receiver(namespace, owner, request.get("receiver"))
                emit({"event": "constructed", "ok": True,
                      "type": type(instance).__name__})
            except ReceiverError as exc:
                emit({"event": "constructed", "ok": False, "message": str(exc)})

        elif op == "call":
            if not loaded:
                emit({"event": "result", "outcome": "raised",
                      "exception_type": "ModuleNotLoaded",
                      "message": "no target module has been loaded"})
                continue

            fn, owner, problem = _resolve(namespace, request["name"])
            if problem is not None:
                emit({"event": "result", "outcome": "raised",
                      "exception_type": "FunctionNotResolved", "message": problem})
                continue

            call_args = request.get("args") or []
            if not isinstance(call_args, list):
                call_args = [call_args]

            receiver_spec = request.get("receiver")
            if owner is not None or (receiver_spec or {}).get("kind") == "expression":
                try:
                    receiver = _build_receiver(namespace, owner, receiver_spec)
                except ReceiverError as exc:
                    emit({"event": "result", "outcome": "raised",
                          "exception_type": "ReceiverConstructionFailed",
                          "message": str(exc)})
                    continue
                call_args = [receiver, *call_args]

            try:
                value = fn(*call_args)
                payload, fidelity = _encode(value)
                emit({"event": "result", "outcome": "ok",
                      "value": payload, "fidelity": fidelity,
                      "type": type(value).__name__})
            except Exception as exc:  # noqa: BLE001 - a raise is the finding
                emit({
                    "event": "result", "outcome": "raised",
                    "exception_type": type(exc).__name__,
                    "message": str(exc),
                    "traceback": traceback.format_exc(limit=20),
                })
            except BaseException as exc:  # noqa: BLE001
                # SystemExit / KeyboardInterrupt. Report, then stop: the target
                # asked to end the process and continuing would be unsound.
                emit({
                    "event": "result", "outcome": "raised",
                    "exception_type": type(exc).__name__,
                    "message": str(exc),
                    "traceback": traceback.format_exc(limit=20),
                    "fatal": True,
                })
                return 0

        else:
            emit({"event": "error", "error": f"unknown op: {op!r}"})

    return 0


if __name__ == "__main__":
    sys.exit(main())
