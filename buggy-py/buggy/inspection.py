"""Reads function signatures and spans out of Python source, via ``ast``.

Using the standard library here instead of tree-sitter is a deliberate
simplification over the TypeScript original, which loaded a native
``tree-sitter-python`` grammar, fixed one grammar per process from a config
value, and silently fell back to the *TypeScript* grammar when the Python one
failed to load — producing confidently wrong results. ``ast`` has none of those
problems: it is always present, always correct for the running Python, gives
exact line and column spans, and cannot be configured into the wrong language.

Two things it gets right that the original did not:

**``self`` and ``cls`` are not parameters.** The original counted them, so every
method's arity came back one too high, and the fuzzer then called it with an
extra argument. That raises ``TypeError``, which looks exactly like the defect
the tool is supposed to find.

**Nested and class-scoped functions are distinguished.** A function defined
inside another function cannot be reached by name after the module executes, so
it is reported rather than silently investigated and found "clean".

@module buggy.inspection
"""

from __future__ import annotations

import ast
from dataclasses import replace

from .types import FunctionInfo, Parameter, ParamKind, Signature

__all__ = [
    "find_functions",
    "find_function",
    "function_source",
    "non_code_lines",
    "parse",
    "SourceSyntaxError",
]

_RECEIVERS = ("self", "cls")


class SourceSyntaxError(SyntaxError):
    """The target file is not valid Python. Reported with line and column."""


def parse(source: str, filename: str = "<target>") -> ast.Module:
    """Parse source into a module tree.

    @raises SourceSyntaxError: with the position, so the caller can point at it.
    """
    try:
        return ast.parse(source, filename=filename)
    except SyntaxError as exc:
        raise SourceSyntaxError(
            f"{filename}:{exc.lineno or 0}:{(exc.offset or 0)}: {exc.msg}"
        ) from exc


# ─── Signatures ──────────────────────────────────────────────────────────────


def _annotation_text(node: ast.expr | None) -> str | None:
    """Render an annotation back to source text, e.g. ``list[int]``."""
    if node is None:
        return None
    try:
        return ast.unparse(node)
    except Exception:  # pragma: no cover - unparse is total in practice
        return None


def _decorator_names(node: ast.FunctionDef | ast.AsyncFunctionDef) -> tuple[str, ...]:
    names: list[str] = []
    for dec in node.decorator_list:
        target = dec.func if isinstance(dec, ast.Call) else dec
        try:
            names.append(ast.unparse(target))
        except Exception:  # pragma: no cover
            continue
    return tuple(names)


def _signature(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    *,
    drop_receiver: bool,
) -> Signature:
    a = node.args
    params: list[Parameter] = []

    # Defaults align to the END of posonly+args, so index from the right.
    positional = list(a.posonlyargs) + list(a.args)
    first_default = len(positional) - len(a.defaults)

    for index, arg in enumerate(positional):
        kind = (
            ParamKind.POSITIONAL_ONLY
            if index < len(a.posonlyargs)
            else ParamKind.POSITIONAL_OR_KEYWORD
        )
        params.append(
            Parameter(
                name=arg.arg,
                annotation=_annotation_text(arg.annotation),
                has_default=index >= first_default,
                kind=kind,
            )
        )

    if a.vararg is not None:
        params.append(
            Parameter(a.vararg.arg, _annotation_text(a.vararg.annotation),
                      False, ParamKind.VAR_POSITIONAL)
        )

    for arg, default in zip(a.kwonlyargs, a.kw_defaults):
        params.append(
            Parameter(arg.arg, _annotation_text(arg.annotation),
                      default is not None, ParamKind.KEYWORD_ONLY)
        )

    if a.kwarg is not None:
        params.append(
            Parameter(a.kwarg.arg, _annotation_text(a.kwarg.annotation),
                      False, ParamKind.VAR_KEYWORD)
        )

    if drop_receiver and params and params[0].name in _RECEIVERS:
        params = params[1:]

    return Signature(
        parameters=tuple(params),
        return_annotation=_annotation_text(node.returns),
    )


# ─── Discovery ───────────────────────────────────────────────────────────────


def find_functions(source: str, filename: str = "<target>") -> list[FunctionInfo]:
    """Every function and method in the file, in source order.

    Walks the tree explicitly rather than with ``ast.walk`` so that each
    function's enclosing classes and functions are known, which is what
    determines its qualified name, whether it takes a receiver, and whether it
    is reachable by name at all.
    """
    tree = parse(source, filename)
    found: list[FunctionInfo] = []

    def visit(node: ast.AST, class_stack: tuple[str, ...], in_function: bool) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.ClassDef):
                visit(child, class_stack + (child.name,), in_function)
                continue

            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                decorators = _decorator_names(child)
                is_method = bool(class_stack) and not in_function
                is_static = "staticmethod" in decorators
                is_class_method = "classmethod" in decorators
                is_property = "property" in decorators

                # An instance method's first parameter is the receiver, and so
                # is a classmethod's. A staticmethod has none.
                drop_receiver = is_method and not is_static
                signature = _signature(child, drop_receiver=drop_receiver)

                is_async = isinstance(child, ast.AsyncFunctionDef)
                if is_method:
                    kind = "async_method" if is_async else "method"
                else:
                    kind = "async_function" if is_async else "function"

                qualified = ".".join(class_stack + (child.name,))

                found.append(
                    FunctionInfo(
                        name=child.name,
                        qualified_name=qualified,
                        kind=kind,
                        line=child.lineno,
                        end_line=getattr(child, "end_lineno", child.lineno) or child.lineno,
                        signature=signature,
                        is_nested=in_function,
                        needs_receiver=is_method and not (is_static or is_class_method),
                        decorators=decorators,
                        is_property=is_property,
                    )
                )
                visit(child, class_stack, True)
                continue

            visit(child, class_stack, in_function)

    visit(tree, (), False)
    return found


def find_function(
    source: str,
    name: str,
    filename: str = "<target>",
) -> FunctionInfo | None:
    """Locate one function by bare or qualified name.

    A bare name matches a module-level function first, so ``usage`` prefers the
    top-level ``usage`` over ``Budget.usage``. Pass the qualified name to be
    unambiguous.
    """
    functions = find_functions(source, filename)
    for fn in functions:
        if fn.qualified_name == name:
            return fn
    exact = [fn for fn in functions if fn.name == name]
    if not exact:
        return None
    for fn in exact:
        if "." not in fn.qualified_name:
            return fn
    return exact[0]


def function_source(source: str, info: FunctionInfo) -> str:
    """The function's own source text, decorators included."""
    lines = source.splitlines()
    start = info.line - 1
    for dec in range(start - 1, -1, -1):
        if lines[dec].lstrip().startswith("@"):
            start = dec
        elif lines[dec].strip():
            break
    return "\n".join(lines[start:info.end_line])


def non_code_lines(source: str, filename: str = "<target>") -> set[int]:
    """1-based lines holding no executable code: comments and docstrings.

    Needed by patch generation, which must not "fix" prose. Deriving this from
    the tree is exact, where guessing from text is not: a docstring line such as
    ``BUG: budget == 0 raises ZeroDivisionError`` contains ``==`` and reads like
    code to any heuristic.
    """
    lines: set[int] = set()

    for index, text in enumerate(source.splitlines(), start=1):
        stripped = text.strip()
        if not stripped or stripped.startswith("#"):
            lines.add(index)

    tree = parse(source, filename)
    for node in ast.walk(tree):
        if not isinstance(
            node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
        ):
            continue
        body = getattr(node, "body", [])
        if not body:
            continue
        first = body[0]
        # A bare string expression in leading position is a docstring. A string
        # used as a value (``return "hello"``) leaves its line executable.
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) \
                and isinstance(first.value.value, str):
            end = getattr(first, "end_lineno", first.lineno) or first.lineno
            lines.update(range(first.lineno, end + 1))

    return lines


def describe_unsupported(info: FunctionInfo) -> str | None:
    """Why this function cannot be investigated yet, or None if it can.

    Said plainly and up front. The alternative is investigating something that
    cannot be called, finding nothing, and reporting "clean" — which reads as
    evidence of safety and is the most damaging thing this tool can do.
    """
    if info.is_nested:
        return (
            "defined inside another function, so it is not reachable by name "
            "after the module loads"
        )
    if info.needs_receiver:
        return (
            "instance method: calling it needs a constructed receiver, which is "
            "not supported yet (staticmethod and classmethod are)"
        )
    if info.kind.startswith("async"):
        return "async function: not supported yet (needs an event loop in the worker)"
    if info.is_property:
        return "property accessor: not callable with generated arguments"
    if not info.signature.callable_parameters and any(
        p.kind is ParamKind.VAR_POSITIONAL for p in info.signature.parameters
    ):
        return "only *args: arity cannot be determined from the signature"
    return None
