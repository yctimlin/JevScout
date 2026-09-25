---
name: jevscout
description: Find compact, source-linked evidence for noisy code investigations or public GitHub issue/PR research before large results enter agent context, or score already-collected excerpts against claims with jevscout check. Use ordinary rg for exact symbols and small lookups.
---

# JevScout

Run the CLI directly against the repository so candidate text does not enter the conversation before selection:

```sh
jevscout search "why duplicate webhook events create two payments" --path . --mode auto
```

Requires the JevScout CLI, Node.js 24+, and `rg`. If the CLI is not installed, a source checkout can run `node /path/to/jevscout/src/cli.ts` with the same arguments. Do not guess that path.

`lexical` mode is entirely local. `jev` ranks with TypeSafe; `auto` skips the API when the evidence already fits or there is only one candidate. Jev modes send candidate source excerpts, relative paths, and the query to TypeSafe. Use them within the user's authorized data scope; the API key stays in `TYPESAFE_API_KEY`.

- Describe the investigation in the query. Use `--terms eventId,idempotency,webhook` to supply known retrieval terms when natural-language words miss code. Jev cannot recover candidates that lexical search never found.
- Read the mode header and notices; detailed `usedMode`, warnings and metrics are in `--format json` or a local `--report` file. A missing key or failed request returns lexical results, not a successful Jev ranking.
- Default output contains verbatim, numbered source lines. A `complete file` excerpt can support a conclusion directly; avoid rereading it solely for citations. A partial excerpt says so; use `jevscout open <pack-id> <evidence-id> --before 30 --after 30` only when nearby source is needed. `--format json` exposes full diagnostics. A relevance probability is not proof of correctness or source authority. Examine conflicting evidence and follow callers or dependencies before editing.
- Use `jevscout list <pack-id>` only when the shown evidence is insufficient. Inspect a relevant omitted reference with `jevscout expand <pack-id> <evidence-id>`. Expansion is local and refuses stale source hashes. Stop discovery once sufficient source evidence is available.
- If nothing fits, increase `--budget-bytes` or expand an omitted reference. If discovery is incomplete, broaden terms/path or return to ordinary search. Never interpret an empty result as proof that behavior is absent.
- Required project instructions still need to be read directly. Do not run JevScout before every tool call or use it to approve actions.

To score already-collected excerpts against claims, pipe one JSON object to `jevscout check` (`{task, claims:[{id,text}], evidence:[{id,source,text}]}`). Use it for bounded, multi-claim evidence that the agent already has; it adds a TypeSafe call and has not shown end-to-end savings on a held-out task. The command does not fetch `source`. Empty evidence yields `unresolved`. Nonempty evidence needs `TYPESAFE_API_KEY` and fails closed if TypeSafe is missing or errors. Treat `supported` / `contradicted` / `mixed` / `unresolved` as evidence labels under provisional 0.80 thresholds, not proof of runtime behavior. Inspect shared evidence snippets before reopening a source for an unresolved claim; the threshold may leave a useful contradiction unclassified. `--format json` keeps diagnostics and TypeSafe usage. Quotes that appear in text output are verbatim.

For public GitHub issue/PR research, call `jevscout github search "question" --repo owner/name --mode auto` instead of loading a raw GitHub search response into context. The output includes URLs, state, updated time, and evidence flags. A `possible_conflict` is a lead to inspect, not a proven contradiction; an `instruction-like` flag is not a security guarantee. For long issue bodies, opt into `--evidence-sections` to see up to two verbatim query-matching ranges with source character offsets. A partial-body label alone does not require another read: check whether each fact needed for the task is present in the displayed spans, then use `jevscout github open owner/name#123` only for missing facts. `github open` shows at most 20 comments and says when more exist. `--follow-links` adds same-repository issues that a shown PR claims to fix or close; those links are author claims. This does not establish that omitted content is irrelevant or safe. The CLI does not use GitHub credentials and cannot access private repositories. Jev mode sends public issue excerpts to TypeSafe.

Report actual task completion time and outcomes when evaluating usefulness. Output bytes and retrieval coverage alone do not establish agent token savings or faster completed work.
