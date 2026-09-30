# Evaluation

JevScout evaluates the complete Claude Code workflow, not only the size of a returned packet. A
candidate configuration is checked against Claude Code's normal no-hook behavior on the same
external-context tasks.

In our latest end-to-end validation of large MCP workflows, the default hook reduced agent time by
38% and agent cost by 26% without an observed correctness loss. TypeSafe usage is billed separately
from agent cost. These figures describe the measured product scope and are not a universal latency
or cost guarantee.

## Release checks

A configuration is ready for opt-in use when it satisfies all of these checks:

1. Correctness is no lower on any task.
2. No task is materially slower or costlier than the no-hook path.
3. Aggregate time and agent cost improve across the task set.
4. Provider failures, missing credentials, low-confidence rankings, and malformed inputs leave the
   original result available to the agent.
5. Omitted source text can be recovered exactly from the local saved output.

The checks use repeated end-to-end runs with deterministic source fixtures and compare per-task
medians as well as aggregate results. TypeSafe usage is recorded separately from the agent's
reported cost.

## Current behavior

The Claude Code MCP hook applies the following scope by default:

- Inline results and oversized results below 100 KB pass through unchanged.
- Oversized results at or above 100 KB are split into source-faithful segments and ranked by Jev.
- A low-confidence Jev result passes through unchanged, allowing Claude Code's normal saved-copy
  flow to handle it.
- A missing API key, provider error, timeout, or malformed response fails open and leaves the
  original result unchanged.
- Exact omitted text remains available through the local recovery command.

- Jev ranks against the request built from the conversation: the tool's arguments, the agent's words
  before the call, and the latest prompt. Entries Claude Code adds itself are skipped. "continue",
  and short answers that Jev judges to continue the earlier request, include that earlier request.

Keyword-only selection is an explicit opt-in and is not recommended for paraphrased requests.
The Codex MCP proxy and shell hook remain experimental integrations with separate behavior. The
Codex operation adapter is a separate library, ready for opt-in use and described below.

## Request from the conversation (0.6.0)

Earlier versions ranked against the last user entry. In real sessions that entry is often "continue",
a short answer such as "current version", or a message Claude Code generated itself. Across 995 local
transcripts it was one of those at 42% of tool calls. Jev then picks sections about the wrong thing:
with "continue", it chose RFC 9110's "100 Continue".

- **Offline:** five real public documents (RFC 9110, Node.js fs and http, Python argparse, and a
  572 KB GitHub comment thread), 15 questions, 9 conversation patterns. The answer was in the packet
  128 times against 58 before, and a packet lacked the answer 3 times against 25. Two simpler rules
  failed their checks first: one on short topic changes, one on short answers.
- **Multi-turn Claude Code (68 runs):** the conversation request was never less correct (34/34,
  against 32/34 before). Total agent time fell by 21%, 40% and 50%, and cost by 17%, 29% and 36%, in
  three rounds. On two individual cases median wall time rose by more than 10%. On one of them the
  hook did not act in either arm (document below the size floor). On the other, the hook and model
  time were no higher, and the extra time came from outside the model and the hook.

## Codex operation adapter

The [Codex operation adapter](codex-operation-adapter.md) uses Jev for a different decision: whether a
Codex request asks to run one of the host's reviewed, fixed operations. It was checked against
Codex handling the same requests itself in a persistent (warm) session with the same operation
catalog, and against a fixed-keyword rule baseline.

On a frozen set of six self-contained requests across two repositories (one pinned Codex model,
two blocks, 36 runs), all three policies completed all 12 of their runs correctly. Compared with warm
Codex, Jev with host-executed native commands reduced task-plus-follow-up time by 61.8% and Codex
tokens (including cached input) by 54.8%. By block, the time reduction was 59.6% and 63.0%.

- Four supported request types ran through Jev and improved in both blocks. The fifth improved
  through Jev in one block; in the other, the TypeSafe call failed and normal Codex completed it.
  That run stays in the totals.
- The out-of-scope request (change one file only) fell back to normal Codex both times, with
  near-neutral time: once because Jev abstained, and once because the 0.80 gate rejected an
  incorrect low-confidence choice.
- Most of the saving comes from skipping one agent turn per single-command request, and about 88%
  of the baseline's counted tokens were cached input.
- The rule baseline handled only one wording, so part of the gap measures phrase coverage.
- TypeSafe usage was separate: 11,281 input and 1,248 output tokens for 11 successful calls, plus
  one failed call with unknown usage.

These are in-sample results on authored requests, not a general Codex speed-up. Interactive
approvals, restarts, and real host callbacks were not evaluated.

## Limits

Performance depends on the agent model, connector response shape, document size, and task wording.
Frozen fixtures do not represent every live connector, and TypeSafe charges are separate from
agent cost. A successful evaluation supports the tested scope; it is not a universal latency or
cost guarantee.

The repository does not include third-party fixture copies. The published code and tests cover the
selection, fallback, recovery, privacy, and configuration contracts described above.
