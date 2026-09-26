# Evaluation

JevScout evaluates the complete Claude Code workflow, not only the size of a returned packet. A
candidate configuration is checked against Claude Code's normal no-hook behavior on the same
external-context tasks.

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

Keyword-only selection is an explicit opt-in and is not recommended for paraphrased requests.
The Codex MCP proxy and shell hook remain experimental integrations with separate behavior.

## Limits

Performance depends on the agent model, connector response shape, document size, and task wording.
Frozen fixtures do not represent every live connector, and TypeSafe charges are separate from
agent cost. A successful evaluation supports the tested scope; it is not a universal latency or
cost guarantee.

The repository does not include third-party fixture copies. The published code and tests cover the
selection, fallback, recovery, privacy, and configuration contracts described above.
