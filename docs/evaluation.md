# Evaluation

This page summarizes how the Claude Code hook and the Codex MCP proxy were evaluated, what we
found, and what the results do not show. The decision rule was fixed before the first
evaluation run and was not changed after seeing results.

## Question and rule

Does condensing large MCP results make agents faster and cheaper on external-context tasks
without losing correctness? For each host, a JevScout arm passes only if, against the
no-JevScout arm and using per-task medians:

1. Correct runs are not fewer on any task.
2. No task's median time or median cost is more than 10% worse, including a small control task.
3. Geometric means across tasks are below 1.0 for both time and cost.

A host that fails stays experimental and is not recommended.

## Setup

- **Frozen inputs.** A local MCP server served recorded real documents (changelogs, GitHub
  search results and comment threads, Node.js, CPython and Kubernetes documentation, npm
  registry metadata) through tools such as `fetch_url`, `search_issues`, and
  `get_issue_comments`. Every run saw identical inputs. Most tools returned full content, as
  many connectors do. One round-2 tool paginated like `mcp-server-fetch` (5,000 characters per
  call by default).
- **Answers a model cannot already know.** Most questions target one fictional fact inserted
  about halfway into a real document. Others ask for a real millisecond timestamp from npm
  metadata. An early comparison, made before this rule, measured the model's prior knowledge
  of a public changelog rather than retrieval; that is why fictional facts are used.
- **Control.** A small document below the condensing threshold checks that the hook adds no
  overhead when it does nothing.
- **Claude Code** 2.1.281 with `claude-sonnet-5`. Each run used a fresh empty directory, no
  user settings, plugins, or CLAUDE.md, only the fixture MCP server, built-in web tools
  disabled, and the same tool allowlist in every arm (including shell tools that Claude Code's
  own oversize notice suggests).
- **Codex** CLI 0.156.1 with `gpt-6-sol` at reasoning effort `high`, in an isolated Codex home
  and a shell that does not load the user's profile.
- **Protocol.** Five repetitions per task and arm (ten for the round-2 control), seeded
  randomized blocks with every arm once per task per block, one run at a time, and a frozen
  JevScout build per round. Correctness is checked by pattern on the final answer. Cost is
  Claude-reported, or computed from token counts at `gpt-6-sol` list prices for Codex.

## Claude Code hook: passed every round

Lexical selection against no hook:

| | Round 1 (5 tasks) | Round 2, held out (6 tasks) | Round 2 rerun on 0.3.0 |
| --- | ---: | ---: | ---: |
| Time (geometric mean) | −32% | −47% | −43% |
| Cost (geometric mean) | −20% | −34% | −30% |
| Tasks worse by more than 10% | none | none | none |
| Correct, hook / no hook | 25/25 vs 25/25 | 35/35 vs 34/35 | 35/35 vs 32/35 |

Round 2 used new documents that were not inspected while tuning, with fictional facts placed
mechanically at the midpoint and numbers from a seeded generator. Per task on the 0.3.0 build:

| Task | Time | Cost | Correct (hook / no hook) |
| --- | ---: | ---: | --- |
| reStructuredText docs (54 KB) | −48% | −31% | 5/5 vs 5/5 |
| GitHub issue search JSON (147 KB) | −58% | −40% | 5/5 vs 5/5 |
| npm metadata (4.2 MB) | −22% | −5% | 5/5 vs 5/5 |
| GitHub comment thread (207 KB) | −57% | −42% | 5/5 vs 5/5 |
| Paginating server (60 KB document) | −57% | −49% | 5/5 vs 2/5 |
| Small control (10 repetitions) | +6% | +0% | 10/10 vs 10/10 |

The largest gains came where Claude Code would otherwise replace a large result with a notice
asking the agent to read a saved copy completely, in chunks. Optional Jev ranking was tested in
round 1 and added nothing measurable over lexical selection (−29% time, −19% cost).

The 0.3.0 rerun followed a live check with the real `mcp-server-fetch` server and live GitHub
data. That check exposed two unhandled shapes: JSON after a text preamble, and JSON arrays cut
off by a character limit. After fixing them, three live runs per arm (not an evaluation)
showed median 5 turns, 32 s, and $0.135 with the hook, against 11 turns, 187 s, and $0.224
without it.

## Codex MCP proxy: failed, not recommended

| Round | Result against direct access |
| --- | --- |
| 1 | Large-document tasks: time −42%, −34%, −15%, +4%; cost −56%, −72%, −47%, −52%. The small control was 11% slower (19.3 s against 17.4 s, with heavily overlapping run times), which breaks rule 2. |
| 2 | Large full-content tasks: time −18% to −32%, cost −40% to −61%; control 0%. The paginating task was 44% slower, which breaks rule 2. On that task direct access answered wrongly in 4 of 5 runs: after Codex truncated a large page, the model concluded the fact was absent. |

Codex keeps roughly the first and last 10K tokens of a large tool result and shows a warning;
a repeated call can surface the middle. The rule does not account for a fast arm that is
usually wrong, and it was not changed after the fact.

## Corrections

- In round 2, one fictional comment kept the original author's profile URLs while changing the
  login, so raw JSON named two authors and agents without the hook often picked the wrong one.
  The fixture was rebuilt so every identity field matched, that task was rerun on both hosts,
  and its original correctness difference is not claimed.
- Two unhandled result shapes were found by the live check, not by the fixtures, and were fixed
  before the 0.3.0 rerun.

## What this does not show

- One agent model per host, and a small task set built by the JevScout authors, even when held
  out.
- Frozen fixtures, not live connectors, apart from the small live check.
- Only MCP text results above the size threshold are affected; Claude Code's built-in tools are
  not covered.
- Percentages are geometric means of per-task median ratios over five runs, not a general
  estimate of savings for any workload.

The harness and fixtures are not published: the fixtures contain third-party documents under
their own licenses, and live sources change over time.
