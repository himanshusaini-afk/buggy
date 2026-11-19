"""Records proven defects so they can be re-run later.

Deliberately narrower than the TypeScript implementation's Watchlist, which
distilled investigations into prose "lessons" and promoted them through local,
team and global tiers. The useful part of that idea does not need any of it.

A certificate is reproducible evidence: it names an exact call that failed. So
the artifact worth keeping is the trigger itself, because it can be executed
again and give a definitive answer rather than a recollection. That makes this
module a regression suite derived from proven defects:

    buggy investigate ... --record     store the certificate
    buggy recheck                      re-run every stored trigger
    buggy export-tests                 emit them as pytest cases

Every claim it makes is re-verified by execution. Nothing is inferred from
history, which is what made the original's lessons hard to trust.

Two things from that design are left out on purpose. A cross-project global
index writes to the user's home directory for a weak signal. And generating
hooks or steering files from defect counts is config synthesised from thin
evidence; a developer who wants a guardrail is better served by the pytest
export, which is specific and checkable.

The database lives at `.buggy/findings.db` in the project, created on first
use. Recording is opt-in: a tool that inspects your code should not start
writing files to it uninvited.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .models import Certificate, OracleKind, Receiver, ReceiverKind

__all__ = ["Store", "Finding", "RecheckResult", "DEFAULT_DIR"]

DEFAULT_DIR = ".buggy"
DB_NAME = "findings.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS findings (
  id              TEXT PRIMARY KEY,
  file            TEXT NOT NULL,
  function        TEXT NOT NULL,
  kind            TEXT NOT NULL,
  rule            TEXT NOT NULL,
  detail          TEXT,
  args_json       TEXT NOT NULL,
  observed_json   TEXT,
  receiver_json   TEXT,
  preconditions   TEXT NOT NULL DEFAULT '[]',
  postconditions  TEXT NOT NULL DEFAULT '[]',
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL,
  times_seen      INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'open',
  status_at       TEXT NOT NULL,
  fix_applied     TEXT
);

CREATE TABLE IF NOT EXISTS checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id  TEXT NOT NULL REFERENCES findings(id),
  at          TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_findings_function ON findings(function);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
CREATE INDEX IF NOT EXISTS idx_checks_finding ON checks(finding_id);
"""

STATUS_OPEN = "open"
STATUS_FIXED = "fixed"
STATUS_REGRESSED = "regressed"
"""Proven again after having been recorded as fixed. The single most useful
signal here: it means a fix did not hold."""
STATUS_UNREACHABLE = "unreachable"
"""The file or function is gone, so the trigger can no longer be run. Reported
rather than assumed fixed; a deleted function is not a repaired one."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dumps(value: Any) -> str:
    """Serialise, keeping NaN and infinity.

    They are the evidence for a whole class of finding, and `json` round-trips
    them between two Python processes without loss.
    """
    return json.dumps(value, allow_nan=True, default=repr)


@dataclass
class Finding:
    """One recorded defect."""

    id: str
    file: str
    function: str
    kind: str
    rule: str
    detail: str | None
    args: list[Any]
    observed: Any
    receiver: Receiver | None
    preconditions: list[str]
    postconditions: list[str]
    first_seen: str
    last_seen: str
    times_seen: int
    status: str
    status_at: str
    fix_applied: str | None = None

    def certificate(self) -> Certificate:
        """Rebuild a certificate, so the repair and oracle code can be reused.

        The three verification timestamps are the ones from when it was proven,
        carried through unchanged: re-deriving them now would claim a
        verification that did not happen.
        """
        return Certificate(
            function=self.function, file=self.file, args=self.args,
            observed=self.observed, rule=self.rule,
            kind=OracleKind(self.kind),
            admissible_at=self.first_seen, sound_at=self.first_seen,
            reproducible_at=self.first_seen, detail=self.detail,
            receiver=self.receiver,
        )

    def reproduce(self) -> str:
        """The call to paste into a REPL."""
        call_args = ", ".join(repr(a) for a in self.args)
        if self.receiver is not None and self.receiver.needed:
            owner, _, method = self.function.rpartition(".")
            return (f"{self.receiver.render(owner or self.function)}"
                    f".{method}({call_args})")
        return f"{self.function}({call_args})"


@dataclass
class RecheckResult:
    finding: Finding
    outcome: str
    """`still_failing`, `fixed`, `regressed` or `unreachable`."""
    detail: str | None = None

    @property
    def is_regression(self) -> bool:
        return self.outcome == STATUS_REGRESSED


class Store:
    """The findings database for one project."""

    def __init__(self, project_root: str | Path = ".",
                 path: str | Path | None = None) -> None:
        self.root = Path(project_root).resolve()
        self.path = (Path(path) if path is not None
                     else self.root / DEFAULT_DIR / DB_NAME)
        self._db: sqlite3.Connection | None = None

    # --- Lifecycle ---

    @property
    def db(self) -> sqlite3.Connection:
        if self._db is None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._db = sqlite3.connect(str(self.path))
            self._db.row_factory = sqlite3.Row
            self._db.execute("PRAGMA journal_mode = WAL")
            self._db.execute("PRAGMA foreign_keys = ON")
            self._db.executescript(SCHEMA)
            self._db.commit()
        return self._db

    def close(self) -> None:
        if self._db is not None:
            self._db.close()
            self._db = None

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def exists(self) -> bool:
        return self.path.exists()

    # --- Paths ---

    def _relative(self, file: str | Path) -> str:
        """Store paths relative to the project, so the database is portable."""
        try:
            return str(Path(file).resolve().relative_to(self.root))
        except ValueError:
            return str(Path(file).resolve())

    def _absolute(self, stored: str) -> Path:
        candidate = Path(stored)
        return candidate if candidate.is_absolute() else self.root / candidate

    # --- Recording ---

    @staticmethod
    def identity(file: str, function: str, rule: str, args: list[Any]) -> str:
        """A stable id for one defect.

        Keyed on the failing call rather than on a timestamp, so investigating
        the same function twice updates one row instead of accumulating
        duplicates that would inflate every count.
        """
        material = "\x00".join([file, function, rule, _dumps(args)])
        return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]

    def record(
        self,
        certificate: Certificate,
        *,
        preconditions: list[str] | None = None,
        postconditions: list[str] | None = None,
    ) -> tuple[Finding, bool]:
        """Store a certificate.

        @returns (finding, is_regression). `is_regression` is True when this
            defect had previously been recorded as fixed, which is the signal
            worth acting on: the earlier fix did not hold.
        """
        rel = self._relative(certificate.file)
        fid = self.identity(rel, certificate.function, certificate.rule,
                            certificate.args)
        now = _now()

        row = self.db.execute(
            "SELECT status, times_seen FROM findings WHERE id = ?", (fid,)
        ).fetchone()

        regression = bool(row) and row["status"] == STATUS_FIXED
        receiver = certificate.receiver

        if row is None:
            self.db.execute(
                "INSERT INTO findings (id, file, function, kind, rule, detail,"
                " args_json, observed_json, receiver_json, preconditions,"
                " postconditions, first_seen, last_seen, times_seen, status,"
                " status_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)",
                (fid, rel, certificate.function, certificate.kind.value,
                 certificate.rule, certificate.detail,
                 _dumps(certificate.args), _dumps(certificate.observed),
                 _dumps(receiver.to_payload()) if receiver is not None else None,
                 _dumps(preconditions or []), _dumps(postconditions or []),
                 now, now, STATUS_OPEN, now),
            )
        else:
            status = STATUS_REGRESSED if regression else STATUS_OPEN
            self.db.execute(
                "UPDATE findings SET last_seen = ?, times_seen = times_seen + 1,"
                " status = ?, status_at = ?, observed_json = ?, detail = ?"
                " WHERE id = ?",
                (now, status, now, _dumps(certificate.observed),
                 certificate.detail, fid),
            )
        self.db.commit()
        return self.get(fid), regression  # type: ignore[return-value]

    def mark_fixed(self, finding_id: str, fix: str | None = None) -> None:
        """Record that a defect is believed fixed.

        Only `recheck` sets this, from an observed pass. Marking it from a
        generated patch would record an intention as a result.
        """
        self.db.execute(
            "UPDATE findings SET status = ?, status_at = ?, fix_applied = ?"
            " WHERE id = ?",
            (STATUS_FIXED, _now(), fix, finding_id),
        )
        self.db.commit()

    def _log_check(self, finding_id: str, outcome: str,
                   detail: str | None) -> None:
        self.db.execute(
            "INSERT INTO checks (finding_id, at, outcome, detail)"
            " VALUES (?,?,?,?)",
            (finding_id, _now(), outcome, detail),
        )
        self.db.commit()

    # --- Reading ---

    def _to_finding(self, row: sqlite3.Row) -> Finding:
        receiver = None
        if row["receiver_json"]:
            payload = json.loads(row["receiver_json"])
            receiver = Receiver(
                kind=ReceiverKind(payload.get("kind", "none")),
                args=tuple(payload.get("args") or ()),
                source=payload.get("source"),
            )
        return Finding(
            id=row["id"], file=row["file"], function=row["function"],
            kind=row["kind"], rule=row["rule"], detail=row["detail"],
            args=json.loads(row["args_json"]),
            observed=json.loads(row["observed_json"]) if row["observed_json"] else None,
            receiver=receiver,
            preconditions=json.loads(row["preconditions"]),
            postconditions=json.loads(row["postconditions"]),
            first_seen=row["first_seen"], last_seen=row["last_seen"],
            times_seen=row["times_seen"], status=row["status"],
            status_at=row["status_at"], fix_applied=row["fix_applied"],
        )

    def get(self, finding_id: str) -> Finding | None:
        row = self.db.execute("SELECT * FROM findings WHERE id = ?",
                              (finding_id,)).fetchone()
        return self._to_finding(row) if row else None

    def findings(
        self,
        *,
        function: str | None = None,
        file: str | Path | None = None,
        status: str | None = None,
    ) -> list[Finding]:
        """Recorded defects, newest first."""
        clauses, params = [], []
        if function:
            # Accept a bare name for a class member, since that is how people
            # refer to one in conversation.
            clauses.append("(function = ? OR function LIKE ?)")
            params += [function, f"%.{function}"]
        if file:
            clauses.append("file = ?")
            params.append(self._relative(file))
        if status:
            clauses.append("status = ?")
            params.append(status)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self.db.execute(
            f"SELECT * FROM findings{where} ORDER BY last_seen DESC", params
        ).fetchall()
        return [self._to_finding(r) for r in rows]

    def summary(self) -> dict[str, Any]:
        counts = {
            r["status"]: r["n"] for r in self.db.execute(
                "SELECT status, COUNT(*) AS n FROM findings GROUP BY status")
        }
        total = sum(counts.values())
        return {
            "database": str(self.path),
            "total": total,
            "by_status": counts,
            "regressed": counts.get(STATUS_REGRESSED, 0),
            "checks_run": self.db.execute(
                "SELECT COUNT(*) AS n FROM checks").fetchone()["n"],
        }

    # --- Rechecking ---

    def recheck(
        self,
        *,
        timeout: float = 2.0,
        function: str | None = None,
        python: str | None = None,
    ) -> list[RecheckResult]:
        """Re-run every stored trigger and report what happened now.

        This is the whole point of recording. Each answer comes from executing
        the call again, so "fixed" means observed to pass, not inferred from a
        patch having been offered.
        """
        from .executor import Executor, ExecutorError
        from .inspection import find_function
        from .repair import _still_failing
        from .specs import compile_condition, SpecSyntaxError

        results: list[RecheckResult] = []

        for finding in self.findings(function=function):
            path = self._absolute(finding.file)
            if not path.exists():
                results.append(self._settle(finding, STATUS_UNREACHABLE,
                                            f"file is gone: {finding.file}"))
                continue

            source = path.read_text(encoding="utf-8")
            try:
                info = find_function(source, finding.function, str(path))
            except Exception as exc:  # noqa: BLE001 - unparseable file
                results.append(self._settle(finding, STATUS_UNREACHABLE,
                                            f"cannot parse: {exc}"))
                continue
            if info is None:
                results.append(self._settle(
                    finding, STATUS_UNREACHABLE,
                    f"function no longer exists: {finding.function}"))
                continue

            conditions = []
            for text in finding.postconditions:
                try:
                    conditions.append(compile_condition(text))
                except SpecSyntaxError:
                    continue

            try:
                executor = Executor(source, filename=str(path),
                                    timeout=timeout, python=python)
            except ExecutorError as exc:
                results.append(self._settle(finding, STATUS_UNREACHABLE,
                                            str(exc)))
                continue

            try:
                if executor.load_error is not None:
                    results.append(self._settle(
                        finding, STATUS_UNREACHABLE,
                        f"module will not load: {executor.load_error.message}"))
                    continue
                result = executor.call(finding.function, finding.args,
                                       timeout=timeout,
                                       receiver=finding.receiver)
            except ExecutorError as exc:
                results.append(self._settle(finding, STATUS_UNREACHABLE,
                                            str(exc)))
                continue
            finally:
                executor.close()

            certificate = finding.certificate()
            still = _still_failing(
                result, certificate, conditions, info.signature.names,
                finding.args, (),
                tuple(finding.receiver.args) if finding.receiver else (),
            )

            if still:
                # A finding stays `regressed` until it actually passes again,
                # not just until the next run. Downgrading it to
                # `still_failing` on the second check would let a build go
                # green while the defect is still there, which is the one thing
                # this command exists to prevent.
                outcome = (
                    STATUS_REGRESSED
                    if finding.status in (STATUS_FIXED, STATUS_REGRESSED)
                    else "still_failing"
                )
                detail = f"{result.exception_type or 'returned'}: {result.message or result.value!r}"
            else:
                outcome = STATUS_FIXED
                detail = (f"now returns {result.value!r}"
                          if result.ok else f"now {result.outcome.value}")
            results.append(self._settle(finding, outcome, detail))

        return results

    def _settle(self, finding: Finding, outcome: str,
                detail: str | None) -> RecheckResult:
        """Log the check and move the finding's status to match."""
        self._log_check(finding.id, outcome, detail)
        status = {"still_failing": STATUS_OPEN}.get(outcome, outcome)
        self.db.execute(
            "UPDATE findings SET status = ?, status_at = ? WHERE id = ?",
            (status, _now(), finding.id),
        )
        self.db.commit()
        refreshed = self.get(finding.id) or finding
        return RecheckResult(refreshed, outcome, detail)


# --- pytest export ---


_HEADER = '''"""Regression tests generated by buggy from proven defects.

Each test replays an exact call that was observed to fail, so a defect that
comes back fails a test instead of reaching production. Generated by:

    buggy export-tests

Safe to edit. Re-running the command overwrites this file, so move anything you
want to keep.
"""

import math

import pytest
'''


def _import_line(file: str) -> tuple[str, str]:
    """Derive a module path from a stored file path."""
    parts = Path(file).with_suffix("").parts
    return ".".join(parts), Path(file).stem


def to_pytest(findings: list[Finding]) -> str:
    """Render findings as a pytest module.

    Each test asserts the failure is *gone*, so the file passes once the
    defects are fixed and fails if any returns. That direction matters: a test
    asserting the bug still exists would have to be deleted when fixed, which
    is how regression suites rot.
    """
    lines = [_HEADER]
    seen: set[str] = set()

    by_module: dict[str, list[Finding]] = {}
    for finding in findings:
        module, _ = _import_line(finding.file)
        by_module.setdefault(module, []).append(finding)

    for module, group in sorted(by_module.items()):
        roots = sorted({f.function.split(".")[0] for f in group})
        lines.append(f"from {module} import {', '.join(roots)}")
    lines.append("")

    for finding in findings:
        name = ("test_" + finding.function.replace(".", "_").lower()
                + "_" + finding.kind + "_" + finding.id[:6])
        if name in seen:
            continue
        seen.add(name)

        call = finding.reproduce()
        lines.append("")
        lines.append(f"def {name}():")
        lines.append(f'    """{finding.rule}')
        lines.append("")
        lines.append(f"    Proven {finding.first_seen[:10]}. "
                     f"Trigger: {call}")
        if finding.detail:
            lines.append(f"    Observed: {finding.detail}")
        lines.append('    """')

        kind = finding.kind
        if kind == "crash":
            exception = (finding.rule.removeprefix("must not raise ").strip()
                         or "Exception")
            lines.append(f"    # Was raising {exception}.")
            lines.append("    try:")
            lines.append(f"        {call}")
            lines.append(f"    except {exception} as exc:")
            lines.append(f'        pytest.fail(f"{finding.function} still '
                         f'raises {exception}: {{exc}}")')
        elif kind == "non_finite":
            lines.append(f"    result = {call}")
            lines.append("    assert math.isfinite(result), (")
            lines.append(f'        f"{finding.function} returned a non-finite '
                         f'value: {{result!r}}")')
        elif kind == "postcondition":
            condition = finding.rule
            lines.append(f"    result = {call}")
            lines.append(f"    assert {condition}, (")
            lines.append(f'        f"{finding.function} broke '
                         f'{condition!r}: result={{result!r}}")')
        elif kind == "timeout":
            lines.append("    # Was not terminating. Keep the bound tight so a")
            lines.append("    # regression fails fast rather than hanging CI.")
            lines.append("    import threading")
            lines.append("    done = []")
            lines.append(f"    thread = threading.Thread("
                         f"target=lambda: done.append({call}), daemon=True)")
            lines.append("    thread.start()")
            lines.append("    thread.join(timeout=5)")
            lines.append("    assert done, "
                         f'"{finding.function} did not finish within 5s"')
        else:
            lines.append(f"    # {kind}: assert whatever this should do now.")
            lines.append(f"    {call}")

    return "\n".join(lines) + "\n"
