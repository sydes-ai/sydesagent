# Metrics and how to read them

Every run writes `trace.jsonl` (raw events) and `metrics.json` (derived numbers) into its run
directory. `sydes report -a <baseline> -b <candidate>` aggregates both sides and renders the
comparison.

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

## What the report compares

Headline metrics feed the verdict:

- `resolveRate` — correctness (verified tests, or the official harness's resolved count)
- `modelCalls`, `totalTokens` — model cost
- `toolCalls`, `uniqueFilesInspected` — exploration

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
