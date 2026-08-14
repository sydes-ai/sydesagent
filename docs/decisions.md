# Decisions

## D1 — Parsing stack: `web-tree-sitter` (WASM), no fallback needed

**Date:** 2026-08-13. **Status:** accepted.

The plan flagged an ABI risk: `tree-sitter-wasms@0.1.13` grammars are built with
`tree-sitter-cli@0.20.x`, while `web-tree-sitter` is at 0.26.

Spike (`scripts/spike-treesitter.mjs`) loaded the Go and TypeScript grammars under
`web-tree-sitter@0.25.10` and ran real queries:

```
[go] abi=14 root=source_file hasError=false
[go] captures: fn=addPokemon@9, pkg=helpers@10, callee=DecodePokemonJSON@10, ...
[typescript] abi=14 root=program hasError=false
SPIKE OK
```

Grammar ABI is 14, which `web-tree-sitter@0.25.x` accepts. **Decision:** pin
`web-tree-sitter@^0.25.10` + `tree-sitter-wasms@^0.1.13`. No native bindings, no vendored
grammar build, no compiler toolchain requirement — the indexer is pure WASM and portable,
which matters because the benchmark runner must work inside varied environments.

The package also ships grammars for Java, Rust, C, C++ — the remaining Multi-SWE-bench
languages — so M7 is additive (a language adapter + queries), with no packaging work.

Re-run the check any time the parser stack is upgraded:

```bash
node scripts/spike-treesitter.mjs
```

## D2 — Own graph, `GraphProvider` interface kept thin

`codebase-memory-mcp` is capable but opaque to the measurements this project exists to make:
per-lookup latency, suggestion→access attribution, incremental re-index after each edit, and a
clean graph-off ablation. Those need in-process control. The query surface is small enough
(`findSymbol`, `neighbors`, `callers`, `callees`, `testsFor`, `impact`, `pathCandidates`) that
an MCP-backed implementation can be dropped in later behind the same interface.

## D3 — Confidence tiers on every edge

Resolution is not always decidable without full type inference (Go method calls on variables,
TS dynamic dispatch). Rather than guess silently, every edge carries
`exact | likely | heuristic`, ranking prefers higher confidence, heuristic edges are labelled
when shown to the model, and ambiguous references fan out to at most `maxAmbiguousFanout`
candidates before being dropped. A confidently wrong edge is worse than a missing one — it
sends the agent into the wrong subsystem, which is the specific failure the spec warns about.
