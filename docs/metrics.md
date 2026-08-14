# Metrics and how to read them

Every run writes `trace.jsonl` (raw events) and `metrics.json` (derived numbers) into its run
directory. `sydes report -a <baseline> -b <candidate>` aggregates both sides and renders the
comparison.

## Two ways to measure, and when to use each

**`sydes graph-eval` — no model calls, no cost.** The benchmark ships an answer key: `fix_patch`
names exactly the files a correct change touches. So graph quality can be measured directly,
without an agent in the loop. For each instance, each gold file in turn plays the foothold the
agent found, and we ask how much of the *rest* of the gold set the graph reaches:

```bash
sydes graph-eval --dataset multi-swe-bench.jsonl --limit 200 --lang go
```

```
  k   graph recall   precision   directory baseline   lift
   5          66.7%       21.7%                66.7%      +0%
  10         100.0%       21.4%                66.7%     +50%
```

The **directory baseline** — "just look at the other files in the same folder" — is scored on
every run and is not a strawman: on a small repo it is genuinely competitive, because
everything is nearby. The graph has to beat it. Instances whose gold patch touches one file,
or only creates new files, are reported as skipped rather than silently scored as zero.

Use this to iterate on resolution quality in seconds. Use the A/B run below to find out
whether better structure actually changes what the agent does.

## The question these numbers answer

> Can structural knowledge make the coding agent reach the correct change surface with less
> exploration and greater confidence?

The graph is only worth having if it **replaces** work. Adding structural context while
exploration stays flat is a failure, and the report is built to say so out loud.

## The metric that is easiest to fake, and how it is pinned down

`graphSuggestionsFollowed` could be inflated trivially: surface every file in the repository,
then claim credit whenever the agent opens one. The ledger prevents that with a **first-writer-wins**
rule.

Each path gets exactly one source recorded, the first time anything puts it in front of the model:

| Source   | Meaning |
| -------- | ------- |
| `task`   | The task text itself named the file. |
| `search` | A `grep` or `glob` result listed it. |
| `model`  | The model wrote the path in its own message before any tool showed it. |
| `graph`  | A graph lookup or enrichment surfaced it, and nothing above had. |
| `unseen` | The agent opened it without anything surfacing it first — a raw guess. |

When the agent later reads or edits that path, the access is attributed to the recorded source.
A file that grep already listed stays credited to grep no matter how often the graph mentions
it afterwards. Files, not accesses, are counted: reading the same file five times is one
attribution.

## Cost, and why tokens alone mislead

An agent loop re-sends the whole conversation every turn, so total input ≈ the sum of context
sizes, and **a token introduced at turn `t` of a `T`-turn run is billed `T − t + 1` times**.
Measured on this repository, more than half of all input tokens were the static prefix — the
system prompt and tool schemas — re-sent unchanged on every turn.

That prefix is exactly what prompt caching is for, and cached tokens bill at a fraction of the
input rate. A metric that counts a cached token and a fresh token as equal is therefore
actively misleading once caching is on, so `RunMetrics` records them separately:

| Field | Meaning |
| --- | --- |
| `inputTokens` | Uncached input, billed at full rate |
| `cacheReadTokens` | Prefix served from cache, billed at a fraction |
| `cacheWriteTokens` | Prefix written to cache, billed at a premium |
| `totalTokens` | Everything actually sent, cached or not |
| `cacheHitRate` | `cacheRead / all input` |
| `costUsd` | Priced per model; `costKnown` is false when no rate is configured |

A measured run against `gpt-5-mini` reached a **77% cache hit rate**, cutting cost roughly 59%
against the same run billed at uncached rates. Prices live in `src/llm/pricing.ts`; override
them with a JSON file via `SYDES_PRICING` when rates change. An unknown model prices at zero
and is flagged rather than guessed at.

**Caching and context trimming are in direct opposition.** Trimming rewrites history, which
changes the cached prefix and invalidates every entry after the edit. Since the re-sent prefix
is most of the input and cached tokens are cheap, growing context is usually cheaper than
trimming it — so trimming fires only at `contextTrimCeiling`, takes a large bite when it does,
and records a `context_trim` event so the assumption stays testable.

## What the report compares

Headline metrics feed the verdict:

- `resolveRate` — correctness (verified tests, or the official harness's resolved count)
- `costUsd` — what the run actually cost
- `modelCalls`, `totalTokens` — model cost
- `toolCalls`, `uniqueFilesInspected` — exploration

Cost is deliberately **excluded** from the exploration index: it moves with model choice and
cache behaviour, so folding it in would let a cheaper model look like less exploration. It is
reported and judged on its own.

The verdict is computed, not written by hand:

1. If correctness dropped, the result is a failure regardless of savings.
2. Else if the exploration index (mean ratio of model calls, tool calls, unique files
   inspected and total tokens) fell more than 5%, the graph replaced work.
3. Otherwise it did not pay for itself.

Supporting metrics — `repeatedReads`, `failedReads`, `failedReadsRecovered`, `searchCalls`,
`maxContextTokens`, `enrichmentBytes`, `graphLookupMsTotal` — explain *where* any change came
from. `enrichmentBytes` is deliberately marked lower-is-better: it is the cost side of the
enrichment layer, and it should be visibly small next to the tokens it saves.

## Running the experiment

Both arms must use the same model, the same budgets and the same task set. The only difference
is `--graph on|off`, which also removes the graph tools from the schema and the graph paragraph
from the system prompt, so the baseline is an ordinary coding agent rather than one told about
a capability it does not have.

```bash
sydes bench --dataset data.jsonl --limit 20 --graph off --provider anthropic --model claude-sonnet-5
sydes bench --dataset data.jsonl --limit 20 --graph on  --provider anthropic --model claude-sonnet-5
sydes report -a runs/bench/base -b runs/bench/graph -o runs/report.md
```

For correctness rather than the local `verified` proxy, score both predictions files with the
official harness (`sydes score`) and use its resolved counts.

## Correctness oracles

Two checks run after every edit and cost no model tokens, so they are reported separately from
the exploration story:

| Field | Meaning |
| --- | --- |
| `unknownSymbolsFlagged` | Identifiers an edit introduced that refer to nothing real |
| `compileChecks` | Compiler / type-checker runs |
| `compileFailures` | Of those, how many caught a broken build |
| `compileScoped` | How many were narrowed by the graph rather than run project-wide |

`compileFailures` is marked **higher-is-better**: a caught failure is a bug that never reached
the test suite or the patch. The gate for this layer is hallucinated-symbol edits going to
zero and the invalid-patch rate falling, not exploration.

The compiler runs in both arms — the graph only changes *what it covers*, so `compileScoped`
is the graph's contribution and is measured as such. The symbol check is graph-only by
construction, since it needs the symbol table; that asymmetry is the hypothesis, not a
confound, and it is recorded explicitly.

**False positives are the whole design risk here.** The symbol check is validated against a
zero-false-positive bar on real code (91 files of Go and TypeScript in-repo). If that bar ever
breaks, the check should be disabled (`enrichment.symbolCheck`) rather than tolerated — a
checker the model learns to ignore is worse than none.

## Ablations

Individual enrichment middlewares can be switched off (`--no-enrichment`, or the
`enrichment.*` config keys) to test each claim separately: the read footer, failed-read
recovery, empty-search hints and post-edit impact each assert that structure removes a round
of exploration, and each should be able to fail that assertion independently.

## Graph health

`sydes index <repo>` reports `heuristicEdges` and `unresolvedRefs`. Heuristic edges are
name-matched guesses shown to the model marked `~uncertain`; a rising share of them means
resolution quality is degrading, which will show up as wasted reads long before it shows up in
the resolve rate.
