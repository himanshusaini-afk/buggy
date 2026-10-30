"""Executes a target function many times in a reusable child process.

Keeps process isolation but pays for interpreter startup once instead of once
per input. Measured per execution on a one-line function: a bare `python3 -c
pass` spawn costs 16.7 ms, the TypeScript implementation's four-temp-file and
fresh-interpreter approach 34.9 ms, this module 0.015 ms. Those committed
example logs took 494 seconds for seven trivial functions.

Isolation is limited and says so. A worker is killed and respawned on timeout
or hard crash, so a wedged process cannot affect later executions, and
RLIMIT_CPU kills runaway loops by signal. A hard memory cap is unavailable on
macOS, where RLIMIT_AS cannot be lowered, so limits are requested and reported
rather than assumed; see `Executor.limits`.
"""

from __future__ import annotations

import json
import os
import select
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Any

from .types import ExecResult, Outcome, Receiver

__all__ = ["Executor", "ExecutorError"]

DEFAULT_TIMEOUT_S = 5.0
"""Wall-clock budget for one call."""

DEFAULT_CPU_SECONDS = 10
"""Hard CPU budget for the whole worker, enforced by the OS. Deliberately
larger than one call's wall-clock timeout: it is a backstop for loops that
ignore the parent's patience, not the primary timeout."""

DEFAULT_FSIZE_MB = 64
"""Cap on any single file the target writes, so a runaway loop cannot fill the disk."""

_READY_TIMEOUT_S = 10.0


class ExecutorError(RuntimeError):
    """The worker could not be started or spoken to."""


@dataclass
class _Worker:
    process: subprocess.Popen
    limits: dict[str, Any]
    calls: int = 0
    buffer: str = ""
    """Bytes read past the end of the current reply. One reply per request means
    this is normally empty, but carrying it forward costs nothing and makes the
    transport correct even if that ever stops being true."""


class Executor:
    """Runs one target module's functions in a reusable subprocess.

    Not thread-safe: one Executor owns one worker and one pipe. Use several
    instances to parallelise.
    """

    def __init__(
        self,
        source: str,
        *,
        filename: str = "<target>",
        python: str | None = None,
        timeout: float = DEFAULT_TIMEOUT_S,
        cpu_seconds: int = DEFAULT_CPU_SECONDS,
        fsize_mb: int = DEFAULT_FSIZE_MB,
        address_mb: int | None = None,
    ) -> None:
        self._source = source
        self._filename = filename
        self._python = python or os.environ.get("BUGGY_PYTHON") or sys.executable
        self._timeout = timeout
        self._cpu_seconds = cpu_seconds
        self._fsize_mb = fsize_mb
        self._address_mb = address_mb

        self._worker: _Worker | None = None
        self._limits: dict[str, Any] = {}
        self._load_error: ExecResult | None = None
        self.respawns = 0
        """How many times the worker had to be replaced. A high count against a
        low call count means the target is crashing the interpreter itself."""

        self._start()

# --- Lifecycle ---

    def _spawn(self) -> _Worker:
        cmd = [
            self._python,
            "-u",
            "-m",
            "buggy._worker",
            "--cpu-seconds", str(self._cpu_seconds),
            "--fsize-mb", str(self._fsize_mb),
        ]
        if self._address_mb:
            cmd += ["--address-mb", str(self._address_mb)]

        env = dict(os.environ)
        # Make the package importable without requiring installation, and keep
        # our path first so a target module named `buggy` cannot shadow it.
        package_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        existing = env.get("PYTHONPATH")
        env["PYTHONPATH"] = package_root + (os.pathsep + existing if existing else "")
        env.pop("PYTHONSTARTUP", None)

        try:
            process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                text=True,
                bufsize=1,
                start_new_session=True,  # so we can kill the whole group
            )
        except OSError as exc:
            raise ExecutorError(
                f"could not start Python interpreter {self._python!r}: {exc}"
            ) from exc

        ready = self._read_event(process, _READY_TIMEOUT_S)
        if ready is None or ready.get("event") != "ready":
            stderr = self._drain_stderr(process)
            self._kill(process)
            raise ExecutorError(
                f"worker did not start (interpreter {self._python!r}). {stderr}".strip()
            )

        return _Worker(process=process, limits=ready.get("limits", {}))

    def _start(self) -> None:
        self._worker = self._spawn()
        self._limits = self._worker.limits
        self._load_error = None

        reply = self._request({
            "op": "load", "source": self._source, "filename": self._filename
        }, timeout=max(self._timeout, 10.0))

        if reply is None:
            self._load_error = ExecResult(
                Outcome.HARD_CRASH,
                exception_type="LoadCrashed",
                message="the target module killed the interpreter while loading",
            )
            return

        if reply.get("event") == "load_failed":
            # The module never loaded, so nothing about the function under test
            # has been learned. Classified as an environment error upstream.
            self._load_error = ExecResult(
                Outcome.RAISED,
                exception_type=reply.get("exception_type"),
                message=reply.get("message"),
                traceback_text=reply.get("traceback"),
            )
            return

        self._module_names: list[str] = reply.get("names", [])

    def _restart(self) -> None:
        self.respawns += 1
        self.close()
        self._start()

    def close(self) -> None:
        worker, self._worker = self._worker, None
        if worker is None:
            return
        try:
            if worker.process.poll() is None:
                try:
                    worker.process.stdin.write(json.dumps({"op": "shutdown"}) + "\n")
                    worker.process.stdin.flush()
                    worker.process.wait(timeout=1.0)
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    self._kill(worker.process)
        finally:
            for stream in (worker.process.stdin, worker.process.stdout, worker.process.stderr):
                try:
                    if stream:
                        stream.close()
                except OSError:
                    pass

    def __enter__(self) -> Executor:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

# --- Transport ---

    @staticmethod
    def _kill(process: subprocess.Popen) -> None:
        """Kill the worker and anything it spawned."""
        if process.poll() is not None:
            return
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except (OSError, PermissionError):
            try:
                process.kill()
            except OSError:
                pass
        try:
            process.wait(timeout=2.0)
        except subprocess.TimeoutExpired:  # pragma: no cover
            pass

    @staticmethod
    def _drain_stderr(process: subprocess.Popen, limit: int = 2000) -> str:
        """Read whatever the dead worker left on stderr, for diagnostics."""
        try:
            if process.stderr is None:
                return ""
            os.set_blocking(process.stderr.fileno(), False)
            return (process.stderr.read() or "")[:limit]
        except (OSError, ValueError):
            return ""

    def _read_event(
        self,
        process: subprocess.Popen,
        timeout: float,
        worker: _Worker | None = None,
    ) -> dict | None:
        """Read one protocol line, or None if the deadline passed or it died.

        ``readline`` would block uninterruptibly, so the pipe is waited on with
        ``select`` and reassembled here. ``select`` rather than a polling sleep
        matters at this call rate: a 0.5 ms sleep between polls added ~0.25 ms
        of pure latency to every execution, which is most of the per-call cost
        when the call itself takes microseconds.
        """
        if process.stdout is None:  # pragma: no cover
            return None
        fd = process.stdout.fileno()
        deadline = time.monotonic() + timeout

        # Resume from anything left over by the previous reply.
        buffer = worker.buffer if worker is not None else ""
        if worker is not None:
            worker.buffer = ""

        def take_line() -> dict | None:
            nonlocal buffer
            line, sep, rest = buffer.partition("\n")
            if not sep:
                return None
            buffer = ""
            if worker is not None:
                worker.buffer = rest
            try:
                return json.loads(line)
            except ValueError:
                return None

        if buffer:
            event = take_line()
            if event is not None:
                return event

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if worker is not None:
                    worker.buffer = buffer
                return None
            try:
                ready, _, _ = select.select([fd], [], [], min(remaining, 0.25))
            except (OSError, ValueError):
                return None
            if not ready:
                continue
            try:
                chunk = os.read(fd, 65536)
            except (BlockingIOError, InterruptedError):
                continue
            except OSError:
                return None
            if not chunk:  # EOF: the worker exited
                return None
            buffer += chunk.decode("utf-8", errors="replace")
            event = take_line()
            if event is not None:
                return event

    def _request(self, payload: dict, timeout: float) -> dict | None:
        worker = self._worker
        if worker is None or worker.process.poll() is not None:
            return None
        try:
            encoded = json.dumps(payload)
        except (TypeError, ValueError) as exc:
            # An argument that cannot be serialised is a harness limitation, not
            # a finding. Raised rather than returned as a result so it cannot be
            # mistaken for a defect in the target; callers that generate inputs
            # are expected to produce transferable ones.
            raise ExecutorError(f"argument could not be serialised: {exc}") from exc
        try:
            worker.process.stdin.write(encoded + "\n")
            worker.process.stdin.flush()
        except (OSError, ValueError):
            return None
        return self._read_event(worker.process, timeout, worker)

# --- Public surface ---

    def can_construct(
        self,
        class_name: str,
        receiver: Receiver,
        *,
        timeout: float | None = None,
    ) -> tuple[bool, str | None]:
        """Whether this receiver builds successfully.

        @returns (ok, reason_if_not).
        """
        if self._load_error is not None:
            return False, self._load_error.message
        reply = self._request(
            {"op": "construct", "class": class_name,
             "receiver": receiver.to_payload()},
            timeout if timeout is not None else self._timeout,
        )
        if reply is None:
            self._restart()
            return False, "building the object killed or hung the interpreter"
        if reply.get("ok"):
            return True, None
        return False, reply.get("message")

    @property
    def limits(self) -> dict[str, Any]:
        """What the OS actually accepted, keyed by rlimit name.

        A value of ``"rejected: ..."`` means the limit is not enforceable on
        this platform. Read this rather than assuming a cap is in place.
        """
        return dict(self._limits)

    @property
    def load_error(self) -> ExecResult | None:
        """Set when the target module failed to import. Nothing can be proven."""
        return self._load_error

    @property
    def module_names(self) -> list[str]:
        return list(getattr(self, "_module_names", []))

    def call(
        self,
        name: str,
        args: list[Any],
        *,
        timeout: float | None = None,
        receiver: Receiver | None = None,
    ) -> ExecResult:
        """Call `name` with positional `args` and describe what happened.

        Never raises for anything the target does; a crash, a hang and a clean
        return are all ordinary results.

        @param receiver: for an instance method, how to build the object to call
            it on. A fresh one is built per call, inside the worker.
        """
        if self._load_error is not None:
            return self._load_error

        budget = timeout if timeout is not None else self._timeout
        payload: dict[str, Any] = {"op": "call", "name": name, "args": args}
        if receiver is not None and receiver.needed:
            payload["receiver"] = receiver.to_payload()

        started = time.perf_counter()
        reply = self._request(payload, budget)
        elapsed = (time.perf_counter() - started) * 1000

        if reply is None:
            # No reply: either it exceeded the deadline or the interpreter died.
            # Distinguish them, because a hang and a segfault are different findings.
            worker = self._worker
            died = worker is None or worker.process.poll() is not None
            stderr = self._drain_stderr(worker.process) if worker else ""
            self._restart()
            if died:
                return ExecResult(
                    Outcome.HARD_CRASH,
                    exception_type="InterpreterDied",
                    message="the worker exited without reporting a result",
                    duration_ms=elapsed,
                    stderr=stderr or None,
                )
            return ExecResult(
                Outcome.TIMEOUT,
                message=f"no result within {budget:g}s",
                duration_ms=elapsed,
            )

        worker = self._worker
        if worker is not None:
            worker.calls += 1

        if reply.get("outcome") == "ok":
            return ExecResult(
                Outcome.OK,
                value=reply.get("value"),
                duration_ms=elapsed,
                fidelity=reply.get("fidelity", "exact"),
                value_type=reply.get("type"),
            )

        result = ExecResult(
            Outcome.RAISED,
            exception_type=reply.get("exception_type"),
            message=reply.get("message"),
            traceback_text=reply.get("traceback"),
            duration_ms=elapsed,
        )
        if reply.get("fatal"):
            # The target exited the interpreter; the worker is gone.
            self._restart()
        return result

    def call_many(
        self,
        name: str,
        args: list[Any],
        times: int,
        *,
        timeout: float | None = None,
        receiver: Receiver | None = None,
    ) -> list[ExecResult]:
        """Call the same input repeatedly, for determinism and reproducibility."""
        return [
            self.call(name, args, timeout=timeout, receiver=receiver)
            for _ in range(times)
        ]
