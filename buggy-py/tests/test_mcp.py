"""The MCP server, driven as a real subprocess over stdio.

In-process tests would miss the two things most likely to break a session: a
stray write to stdout corrupting the wire, and a crash in one tool killing the
server. So every test here talks to an actual child process the way a client
would.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
FIXTURE = PACKAGE_ROOT / "tests" / "fixtures" / "sample.py"


class Session:
    """A live MCP server, with a few helpers for sending requests."""

    def __init__(self) -> None:
        env = dict(os.environ)
        env["PYTHONPATH"] = str(PACKAGE_ROOT) + os.pathsep + env.get("PYTHONPATH", "")
        self.proc = subprocess.Popen(
            [sys.executable, "-u", "-m", "buggy.mcp"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1, env=env,
        )
        self._id = 0

    def request(self, method: str, params: dict | None = None,
                timeout: float = 90.0) -> dict:
        self._id += 1
        self.proc.stdin.write(json.dumps({
            "jsonrpc": "2.0", "id": self._id, "method": method,
            "params": params or {},
        }) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise AssertionError(
                f"server closed the connection. stderr:\n{self.read_stderr()}")
        return json.loads(line)

    def notify(self, method: str, params: dict | None = None) -> None:
        self.proc.stdin.write(json.dumps({
            "jsonrpc": "2.0", "method": method, "params": params or {},
        }) + "\n")
        self.proc.stdin.flush()

    def call(self, tool: str, **arguments) -> tuple[dict, bool]:
        """Call a tool. Returns (parsed payload, isError)."""
        reply = self.request("tools/call",
                             {"name": tool, "arguments": arguments})
        result = reply["result"]
        return json.loads(result["content"][0]["text"]), result["isError"]

    def initialize(self, version: str = "2025-06-18") -> dict:
        reply = self.request("initialize", {
            "protocolVersion": version, "capabilities": {},
            "clientInfo": {"name": "test", "version": "1"},
        })
        self.notify("notifications/initialized")
        return reply["result"]

    def read_stderr(self) -> str:
        try:
            os.set_blocking(self.proc.stderr.fileno(), False)
            return self.proc.stderr.read() or ""
        except (OSError, ValueError):
            return ""

    def close(self) -> None:
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            self.proc.kill()
            self.proc.wait(timeout=5)
        finally:
            # Closed explicitly, or the pipes leak and every later test run
            # reports ResourceWarning noise that hides real problems.
            for stream in (self.proc.stdout, self.proc.stderr):
                try:
                    if stream:
                        stream.close()
                except OSError:
                    pass


class McpTestCase(unittest.TestCase):
    def setUp(self):
        self.session = Session()
        self.addCleanup(self.session.close)


class TestHandshake(McpTestCase):
    def test_initialize_reports_name_and_tool_capability(self):
        result = self.session.initialize()
        self.assertEqual(result["serverInfo"]["name"], "buggy")
        self.assertIn("tools", result["capabilities"])
        self.assertIn("instructions", result)

    def test_known_protocol_version_is_echoed(self):
        for version in ("2024-11-05", "2025-03-26", "2025-06-18", "2026-07-28"):
            with self.subTest(version=version):
                session = Session()
                self.addCleanup(session.close)
                self.assertEqual(
                    session.initialize(version)["protocolVersion"], version)

    def test_unknown_protocol_version_gets_a_supported_one(self):
        """The spec expects the server to answer with a version it supports and
        let the client decide, rather than echoing something it cannot speak."""
        result = self.session.initialize("1999-01-01")
        self.assertNotEqual(result["protocolVersion"], "1999-01-01")
        self.assertRegex(result["protocolVersion"], r"^20\d\d-\d\d-\d\d$")

    def test_notifications_get_no_reply(self):
        """A reply to a notification desynchronises the stream, so every later
        response would be read as the answer to the wrong request."""
        self.session.initialize()
        self.session.notify("notifications/initialized")
        self.session.notify("notifications/cancelled", {"requestId": 99})
        # If either produced a reply, this read would return it instead.
        self.assertEqual(self.session.request("ping")["result"], {})

    def test_ping(self):
        self.session.initialize()
        self.assertEqual(self.session.request("ping")["result"], {})

    def test_empty_resource_and_prompt_lists(self):
        """Clients probe these during discovery; an error would look broken."""
        self.session.initialize()
        self.assertEqual(
            self.session.request("resources/list")["result"]["resources"], [])
        self.assertEqual(
            self.session.request("prompts/list")["result"]["prompts"], [])


class TestToolDescriptions(McpTestCase):
    def setUp(self):
        super().setUp()
        self.session.initialize()
        self.tools = self.session.request("tools/list")["result"]["tools"]

    def test_four_tools_advertised(self):
        self.assertEqual(
            {t["name"] for t in self.tools},
            {"buggy_functions", "buggy_investigate", "buggy_repair",
             "buggy_scan"},
        )

    def test_every_tool_has_a_description_and_schema(self):
        for tool in self.tools:
            with self.subTest(tool=tool["name"]):
                self.assertTrue(tool["description"])
                self.assertEqual(tool["inputSchema"]["type"], "object")
                self.assertIn("required", tool["inputSchema"])

    def test_schemas_say_conditions_are_python(self):
        """An agent reading the schema must not write JavaScript, which is the
        exact mistake the TypeScript implementation invited."""
        investigate = next(t for t in self.tools
                           if t["name"] == "buggy_investigate")
        props = investigate["inputSchema"]["properties"]
        for key in ("preconditions", "postconditions"):
            self.assertIn("PYTHON", props[key]["description"])

    def test_descriptions_warn_that_unconfirmed_is_not_safety(self):
        investigate = next(t for t in self.tools
                           if t["name"] == "buggy_investigate")
        self.assertIn("not", investigate["description"].lower())
        self.assertIn("proof of safety", investigate["description"])


class TestTools(McpTestCase):
    def setUp(self):
        super().setUp()
        self.session.initialize()

    def test_functions_lists_and_marks_investigability(self):
        payload, is_error = self.session.call("buggy_functions",
                                             file=str(FIXTURE))
        self.assertFalse(is_error)
        names = {f["name"] for f in payload["functions"]}
        self.assertIn("divide", names)
        self.assertIn("Calculator.static_divide", names)
        async_fn = next(f for f in payload["functions"] if f["name"] == "async_fn")
        self.assertFalse(async_fn["investigable"])
        self.assertIn("async", async_fn["reason"])

    def test_investigate_returns_a_runnable_reproduction(self):
        payload, is_error = self.session.call(
            "buggy_investigate", function="divide", file=str(FIXTURE),
            budget=200)
        self.assertFalse(is_error)
        self.assertEqual(payload["status"], "proven")
        cert = payload["certificate"]
        self.assertIn("ZeroDivisionError", cert["broke"])
        self.assertTrue(cert["reproduce"].startswith("divide("))
        # At least 2 of 3 is the bar; a clean trigger reproduces all 3.
        reproduced, _, attempts = cert["verified"]["reproductions"].partition("/")
        self.assertEqual(attempts, "3")
        self.assertGreaterEqual(int(reproduced), 2)

    def test_instance_method_reproduction_includes_construction(self):
        payload, _ = self.session.call(
            "buggy_investigate", function="Basket.average", file=str(FIXTURE),
            budget=200)
        self.assertEqual(payload["status"], "proven")
        self.assertIn("Basket(", payload["certificate"]["reproduce"])
        self.assertIn(".average(", payload["certificate"]["reproduce"])

    def test_unconfirmed_carries_the_caveat(self):
        payload, _ = self.session.call(
            "buggy_investigate", function="monthly", file=str(FIXTURE),
            preconditions=["isinstance(yearly, float) and math.isfinite(yearly)"],
            postconditions=["math.isfinite(result)"], budget=100)
        self.assertEqual(payload["status"], "unconfirmed")
        self.assertIn("not a proof of safety", payload["caveat"])

    def test_javascript_condition_is_reported_not_silently_dropped(self):
        payload, _ = self.session.call(
            "buggy_investigate", function="clamp_percent", file=str(FIXTURE),
            postconditions=["!isNaN(result)"], budget=30)
        warnings = payload["specifications_not_checked"]
        self.assertEqual(warnings[0]["condition"], "!isNaN(result)")
        self.assertIn("JavaScript", warnings[0]["reason"])

    def test_repair_returns_verified_patches_with_evidence(self):
        payload, is_error = self.session.call(
            "buggy_repair", function="divide", file=str(FIXTURE), budget=200)
        self.assertFalse(is_error)
        self.assertGreaterEqual(payload["verified_count"], 1)
        verified = [c for c in payload["candidates"]
                    if c["verdict"] == "verified"]
        patch = verified[0]
        self.assertTrue(patch["evidence"])
        self.assertTrue(patch["diff"])
        self.assertTrue(any("if " in line for line in patch["lines"]))
        self.assertIn("nothing was written", payload["repair_note"])

    def test_repair_on_a_clean_function_says_so(self):
        payload, is_error = self.session.call(
            "buggy_repair", function="monthly", file=str(FIXTURE),
            preconditions=["isinstance(yearly, float) and math.isfinite(yearly)"],
            budget=60)
        self.assertFalse(is_error)
        self.assertEqual(payload["candidates"], [])
        self.assertIn("nothing to repair", payload["repair_note"])

    def test_repair_does_not_modify_the_file(self):
        before = FIXTURE.read_bytes()
        self.session.call("buggy_repair", function="divide",
                          file=str(FIXTURE), budget=150)
        self.assertEqual(FIXTURE.read_bytes(), before)

    def test_scan_covers_the_file(self):
        payload, is_error = self.session.call(
            "buggy_scan", file=str(FIXTURE), budget=60)
        self.assertFalse(is_error)
        self.assertGreater(payload["investigated"], 3)
        self.assertGreaterEqual(payload["proven"], 1)

    def test_nan_survives_the_wire(self):
        """NaN is the evidence for a whole class of finding, so it must not be
        nulled on the way out."""
        payload, _ = self.session.call(
            "buggy_investigate", function="ratio", file=str(FIXTURE),
            budget=200)
        self.assertEqual(payload["status"], "proven")
        observed = payload["certificate"]["observed"]
        self.assertTrue(observed != observed or observed in (float("inf"),
                                                             float("-inf")))


class TestErrorHandling(McpTestCase):
    def setUp(self):
        super().setUp()
        self.session.initialize()

    def test_missing_file_is_a_tool_error_the_agent_can_see(self):
        payload, is_error = self.session.call(
            "buggy_investigate", function="x", file="/does/not/exist.py")
        self.assertTrue(is_error)
        self.assertIn("no such file", payload["error"])

    def test_non_python_file_is_rejected(self):
        payload, is_error = self.session.call(
            "buggy_functions", file=str(PACKAGE_ROOT / "README.md"))
        self.assertTrue(is_error)
        self.assertIn(".py", payload["error"])

    def test_missing_required_argument_is_named(self):
        payload, is_error = self.session.call("buggy_investigate",
                                              file=str(FIXTURE))
        self.assertTrue(is_error)
        self.assertIn("function", payload["error"])

    def test_tool_failure_is_not_a_protocol_error(self):
        """Per the spec a tool that fails returns isError on a successful call.
        A JSON-RPC error would make the client treat the server as broken."""
        reply = self.session.request("tools/call", {
            "name": "buggy_functions",
            "arguments": {"file": "/does/not/exist.py"},
        })
        self.assertNotIn("error", reply)
        self.assertTrue(reply["result"]["isError"])

    def test_unknown_tool_is_a_protocol_error(self):
        reply = self.session.request("tools/call",
                                     {"name": "nope", "arguments": {}})
        self.assertEqual(reply["error"]["code"], -32602)

    def test_unknown_method_is_a_protocol_error(self):
        reply = self.session.request("made/up")
        self.assertEqual(reply["error"]["code"], -32601)

    def test_malformed_json_does_not_kill_the_session(self):
        self.session.proc.stdin.write("{not json at all\n")
        self.session.proc.stdin.flush()
        error = json.loads(self.session.proc.stdout.readline())
        self.assertEqual(error["error"]["code"], -32700)
        self.assertEqual(self.session.request("ping")["result"], {})

    def test_a_failing_tool_does_not_kill_the_session(self):
        self.session.call("buggy_investigate", function="x",
                          file="/does/not/exist.py")
        payload, is_error = self.session.call("buggy_functions",
                                              file=str(FIXTURE))
        self.assertFalse(is_error)


class TestStdoutIsolation(McpTestCase):
    def test_target_output_cannot_corrupt_the_protocol(self):
        """The target prints, and its worker is a child of ours. If any of that
        reached our stdout it would land inside a JSON-RPC message."""
        noisy = PACKAGE_ROOT / "tests" / "fixtures" / "_noisy_tmp.py"
        noisy.write_text(
            "import sys\n"
            "def shout(x):\n"
            "    print('to stdout')\n"
            "    sys.stdout.write('more stdout\\n')\n"
            "    sys.stderr.write('to stderr\\n')\n"
            "    return 1 / x\n",
            encoding="utf-8",
        )
        self.addCleanup(noisy.unlink)

        self.session.initialize()
        payload, is_error = self.session.call(
            "buggy_investigate", function="shout", file=str(noisy), budget=60)
        self.assertFalse(is_error)
        self.assertEqual(payload["status"], "proven")
        self.assertEqual(self.session.request("ping")["result"], {})


if __name__ == "__main__":
    unittest.main()
