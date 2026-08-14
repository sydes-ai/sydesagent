# Sydes — a graph-aware coding agent

Sydes treats a codebase as a connected system rather than a pile of files. A tree-sitter code
graph answers structural questions — who calls this, what does it call, which tests cover it,
what else does this edit reach — so the language model spends its turns on semantics instead of
rediscovering the same relationships through repeated grep-and-read cycles.

**Use the LLM for semantics, the graph for structure.** Neither replaces the other.

The design bet is falsifiable, and the repository is built to test it: the graph is a
toggleable layer over an otherwise complete coding agent, and `--graph off` runs the same agent,
model and budgets without it. If structure only adds context instead of replacing exploration,
the A/B report says so.

## Quick start

```bash
npm install
npm test
```

Index a repository and ask the graph a structural question:

```bash
npx tsx src/cli/index.ts index fixtures/go-pokedex
npx tsx src/cli/index.ts graph expand pkg/handler/pokedex.go -r fixtures/go-pokedex
```

```
Structure of pkg/handler/pokedex.go
Defined here:
  addPokemon  → pkg/handler/pokedex.go:11
  listPokemon → pkg/handler/pokedex.go:25
Related code:
  DecodePokemonJSON → helpers/helpers.go:21
  RespondWithError  → helpers/helpers.go:33
  AddPokemon        → service/pokemon.go:24
Used by:
  Handler.Routes → pkg/handler/handler.go:20
Related tests:
  Test_addPokemon → pkg/handler/pokedex_test.go:17
```

Every line ends in a path. A list of bare symbol names would just start another round of
searching, which is the cost this project exists to remove.

Run the agent:

```bash
npx tsx src/cli/index.ts run -r ./my-repo -t "Reject uploads larger than 10MB" \
  --provider anthropic --model claude-sonnet-5 --graph on
```

### Providers

| Provider | Credential | Notes |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | Temperature is omitted automatically for reasoning families (`gpt-5*`, `o1/o3/o4`), which reject any value but the default. |
| `anthropic` | `ANTHROPIC_API_KEY` | Honours `ANTHROPIC_BASE_URL`. |
| `ollama` | none | Needs `ollama serve` and a tool-capable model. |
| `mock` / `replay` | none | Scripted turns for tests; cassettes for deterministic replays of real transcripts. |

Tool use is the hard requirement. An 8B local model will make valid calls but wanders and
misreports success; treat local runs as plumbing checks, not evidence. Frontier-class models
complete the fixture task cleanly in around ten turns.

## How the loop works

```
task → model reasons → search / read → concrete anchor found
     → graph expands the structural neighborhood → compact evidence
     → model chooses the next action → read / edit → graph updates the change surface
     → verify → repeat
```

Two design rules follow from the spec and are enforced in code:

**Anchor-first.** There is no "ask the graph about the task in English" tool. Natural-language
retrieval over a structural index is exactly where a graph becomes confidently wrong and sends
the agent into a subsystem that merely sounds right. The model finds a concrete anchor; the
graph expands from it. An unknown anchor returns the real alternatives that exist, never a
guess.

**Structure arrives where the model is already reading.** The most valuable graph answers cost
no extra model turn because they ride along with a tool result the model already paid for:

| Trigger | What gets attached |
| --- | --- |
| Successful read | The file's structural neighborhood, deduped against what was already shown |
| Failed read (`ENOENT`) | Existing nearby files — `server/handler/pokemon.go` → `pkg/handler/pokedex.go` |
| Search with no hits | Similar symbols from the graph |
| Edit | The change surface: callers, implementations, covering tests |

Each is individually toggleable, because each is a claim that has to survive measurement.

## The ledger

Sydes tracks what the run has already established: files read (by content hash), neighborhoods
expanded, structural facts already shown, failed paths, searches, edits and test runs.

Re-reading an unchanged file returns a pointer, not the file:

```
service/pokemon.go is unchanged since you read it on turn 3 (48 lines). Its contents are
already above. Re-read a slice with start_line/end_line if you need to look again.
```

The saving is not the filesystem call — those are free. It is the model attention that would
have been spent reading the same 48 lines twice.

## Graph quality

Resolution is staged from most to least certain, and the stage that produced an edge sets its
confidence:

- `exact` — resolved through an explicit binding (import, same package, same-file scope, or a
  declared receiver type such as `svc: PokemonService`)
- `likely` — a repo-unique name match
- `heuristic` — one of several same-named candidates, shown to the model marked `~uncertain`

Ambiguous references fan out to at most three candidates before being dropped. **A confidently
wrong edge is worse than a missing one**, so name lookups are case-sensitive (in Go,
`addPokemon` and `AddPokemon` are unrelated functions), builtins are filtered out, and the
`heuristicEdges` / `unresolvedRefs` counters are reported as graph-health signals.

Languages: Go and TypeScript/JavaScript, behind a `LanguageAdapter` interface. Java, Rust and
C/C++ are additive — the grammars already ship with the parser stack.

## Multi-SWE-bench

```bash
# 1. produce predictions (the official {org, repo, number, fix_patch} JSONL)
sydes bench --dataset multi-swe-bench.jsonl --limit 20 --graph on \
  --provider anthropic --model claude-sonnet-5

# 2. score with the official harness (needs Docker + the Python package)
sydes score --dataset multi-swe-bench.jsonl --predictions runs/bench/graph/predictions.jsonl

# 3. compare the arms
sydes report -a runs/bench/base -b runs/bench/graph -o runs/report.md
```

Each instance gets a workspace cloned at `base.sha` from a cached bare mirror. The task text is
built from `title`, `body` and `resolved_issues` only — `fix_patch` and `test_patch` are the
answer key and never reach the agent, which is asserted by a test. Test-file changes are
excluded from the emitted patch, since the harness applies its own test patch on top.

`--exec docker:<image>` runs commands inside the instance image while the agent and the graph
work on a host copy, so no Node has to be installed into the benchmark images.

Scoring stays with the upstream harness: it owns the images and the definition of "resolved".

## Layout

```
src/graph/      model, indexer, Go + TS adapters, resolver, store, ranked query API
src/agent/      loop, tools, ledger, enrichment middleware, verification
src/llm/        provider-neutral tool-calling: openai | anthropic | ollama | mock | replay
src/telemetry/  trace events, metric derivation, A/B report
src/bench/      Multi-SWE-bench dataset, workspaces, runner, harness wrapper
src/exec/       local and docker execution environments
fixtures/       small Go and TS repos used as golden graphs and agent workspaces
```

## Documentation

- [docs/metrics.md](docs/metrics.md) — what is measured, and the attribution rule that stops the
  graph from taking credit for work it did not do
- [docs/decisions.md](docs/decisions.md) — parsing stack, why the graph is in-process, why every
  edge carries a confidence tier

## Status

Working: the graph, the agent loop and its tools, all four enrichments, the ledger, the
telemetry and A/B report, verification, the Multi-SWE-bench runner and the harness wrapper.
47 tests cover them, including a benchmark instance that runs end-to-end offline against a local
git mirror.

Not yet done: the experiment itself. It needs a model strong enough to use tools well — the
local `llama3.1:8b` smoke run exercises the plumbing but is not evidence either way. Java, Rust
and C/C++ adapters are pending, as is the learned relevance prior, which the spec places in the
future.
