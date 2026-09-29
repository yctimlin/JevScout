# JevScout: Claude Code MCP Context Management Hook

**Semantic context compression and exact recovery for large Model Context Protocol (MCP) responses in Claude Code.**

JevScout is an open-source Claude Code `PostToolUse` hook for managing large MCP tool responses. Built around [TypeSafe's Jev](https://docs.typesafe.ai/primitives), it semantically ranks document sections, JSON records, issue searches, comment threads, changelogs, and other external context before they fill the Claude Code context window. The hook keeps relevant source text verbatim, marks omitted sections, and provides exact local recovery. If Jev cannot run, the original result reaches Claude Code unchanged. JevScout is independent open-source software, not an official TypeSafe product.

| Component | Status |
| --- | --- |
| Claude Code hook with Jev ranking (default) | **Ready for opt-in use.** In our end-to-end validation, it reduced agent time by 38% and agent cost by 26% without a correctness loss. It preserves exact recovery and passes results through unchanged when Jev is unavailable or uncertain. |
| Keyword-only mode (`JEVSCOUT_HOOK_MODE=lexical`) | **Not recommended.** Can drop facts that are worded differently from the request. |
| Shell hook (`gh`, `curl`, … rewritten through a filter) | Experimental; spike-tested only, installed only with `--with-shell`. |
| Codex MCP proxy | **Experimental.** Not validated for this release. |
| Local `search`, `github`, `check` commands | Experimental; mixed pilot results. |

<p align="center">
  <img src="assets/jevscout-demo.gif" alt="JevScout demo: a 169 KB MCP result that Claude Code would read in chunks is ranked by Jev, and the agent answers from a 3-segment verbatim packet in 2 turns instead of 5 (−51% time, −42% cost on this task; −38% time, −26% cost across all 7 validation tasks)" width="720">
</p>

## At a glance

| Question | Answer |
| --- | --- |
| What is JevScout? | A Claude Code hook that reduces large MCP responses before they consume the agent's context window. |
| What makes selection semantic? | TypeSafe's Jev scores response previews for relevance and inspects promising segments, including paraphrased facts and meaning-based matches. |
| What is preserved? | Verbatim selected text, omission markers, source positions, and exact local recovery. |
| What happens when Jev is unavailable? | The hook fails open and leaves the original tool result unchanged. |
| Which connectors can it handle? | MCP servers for GitHub, Notion, Linear, Slack, fetch services, issue search, and similar text sources. |

## Use cases

JevScout is designed for Claude Code workflows that receive large external-context results, including:

- Reading long GitHub issue searches, pull requests, and comment threads.
- Finding a fact in a large changelog, Markdown or reStructuredText document, or JSON response.
- Reducing MCP context usage while keeping an exact recovery path to the original response.
- Selecting evidence from text that uses different words from the user's request.

It does not replace Claude Code's built-in `Read`, `Bash`, or `WebFetch` tools. The evaluated path is the Claude Code MCP `PostToolUse` hook.

## Install the Claude Code MCP hook

Requires Node.js 24+, Claude Code (tested with 2.1.281), and a TypeSafe API key.

1. Get an API key from [TypeSafe](https://typesafe.ai) and export it in the shell that starts Claude Code, for example in your shell profile:
   ```sh
   export TYPESAFE_API_KEY=...
   ```
   The key is read from the environment only; JevScout never writes it to any file.
2. Install the hook (the package is not published yet; from a checkout):
   ```sh
   pnpm install && pnpm build
   node dist/cli.js hook install --scope project   # writes .claude/settings.json (backup first)
   node dist/cli.js hook install --scope user      # or ~/.claude/settings.json
   node dist/cli.js hook uninstall --scope project # removes only JevScout's entries
   node dist/cli.js hook install --dry-run         # print the result without writing
   ```
3. Restart Claude Code so it picks up the key and the hook.

`install` adds a `PostToolUse` hook for `mcp__.*` and one allow rule for the read-only recovery command, and prints what will be sent to TypeSafe. It records the absolute path of this checkout, so keep the checkout where it is; after publication, install the package globally or in the project rather than through `npx`. Without `TYPESAFE_API_KEY` the hook does nothing: results pass through unchanged.

## What the hook does

- **Only large, oversized results.** By default the hook acts only when a result exceeds Claude Code's own limit (Claude Code would otherwise replace it with a notice asking the agent to read a saved copy completely, in chunks) **and** is at least 100 KB. Smaller results pass through unchanged: inline results are cheap, and just over the limit Claude Code's own saved-copy flow is cheap too. `JEVSCOUT_HOOK_MIN_OVERSIZED_BYTES` changes the floor; `JEVSCOUT_HOOK_SCOPE=all` also condenses inline results over 8,000 bytes.
- **Jev judges response segments.** Results are split by shape: JSON records (including JSON after a text preamble, truncated arrays, and large nested maps), markdown or reStructuredText sections with their heading path, or line windows. Jev scores short segment previews across the response, then scores the most promising segments in full. Keyword matches only break ties. The packet (at most 6,000 bytes) keeps the chosen parts verbatim.
- **Saved copies:** the hook condenses Claude Code's saved copy of an oversized result, reading it only from the current session's `tool-results` directory.
- **Your request** is the tool's arguments plus your latest prompt, without URLs or the tool's own name.
- **When Jev finds nothing likely relevant** (best estimate below 0.5), the original result passes through unchanged, so Claude Code's normal flow applies.
- **Recovery:** `node dist/cli.js output <id> --segment N | --grep TEXT | --all` returns exact original text. `--grep` accepts literal text or, if that finds nothing, a regular expression.
- **Fails open:** with no key, a TypeSafe error or timeout (one retry for server errors), or any other problem, the original result is left unchanged. Images and other non-text results are never touched.
- **Not covered:** Claude Code's built-in `Read`, `Bash`, and `WebFetch` output cannot be replaced by hooks (WebFetch already returns a model summary).

### How it works

1. Claude Code receives a text response from an MCP server.
2. The hook checks whether the response is an oversized saved result and meets the configured size floor.
3. Jev scores previews of the response segments against the tool request and latest user prompt.
4. JevScout sends a compact, source-faithful packet to Claude Code and keeps the full response locally for recovery.

The default path is reversible: small responses, low-confidence results, missing credentials, provider failures, and timeouts continue through Claude Code's normal handling.

## Evaluation

JevScout is evaluated end to end against the host's normal no-hook behavior. In our latest validation of large MCP workflows, the default hook reduced agent time by **38%** and agent cost by **26%**, with no observed correctness loss. TypeSafe usage is billed separately from agent cost.

Readiness checks cover correctness, per-task time and cost, aggregate time and cost, fallback behavior, and exact recovery. Packet size alone is not treated as a productivity result.

The current hook scope is deliberately narrow:

- Inline MCP results and oversized results below 100 KB pass through unchanged.
- Oversized results at or above 100 KB are condensed only after Jev relevance ranking.
- Missing credentials, provider errors, timeouts, and low-confidence rankings pass through unchanged.
- TypeSafe usage is billed separately from the agent's reported cost.

### Category-level results

The following results compare JevScout with Claude Code's normal no-hook path. Percentages show the
change in median agent time and reported agent cost; negative values mean less time or cost.

| Scenario | Result size | Correctness (Jev / no hook) | Agent time | Agent cost |
| --- | ---: | ---: | ---: | ---: |
| Semantic paraphrase in documentation | 176 KB | 5/5 vs 5/5 | −43% | −29% |
| Issue search with similar records | 170 KB | 5/5 vs 5/5 | −51% | −42% |
| Meaning-based retrieval in 100 comments | 196 KB | 5/5 vs 1/5 | −72% | −60% |
| Large npm metadata response | 5.2 MB | 5/5 vs 5/5 | −45% | −29% |

Responses below the 100 KB floor pass through unchanged. TypeSafe usage is separate from agent
cost: measured condensed tasks used 9K–81K TypeSafe tokens at 170–196 KB and about 300K tokens for
the 5.2 MB response.

The [evaluation notes](docs/evaluation.md) describe the public quality checks and operating limits.

## Frequently asked questions

### What is a Claude Code MCP context hook?

It is a Claude Code `PostToolUse` hook that can replace a large MCP text response with a smaller, relevant packet before the response occupies the agent's context window. JevScout is that hook, with semantic selection and exact recovery.

### Does JevScout summarize or rewrite source text?

No. Selected source values are kept verbatim. Jev chooses which segments are shown; the original response remains available through the local recovery command.

### What happens if I do not have a TypeSafe API key?

The default Jev mode passes the MCP result through unchanged. JevScout does not silently fall back to keyword-only condensing. `JEVSCOUT_HOOK_MODE=lexical` is an explicit local opt-in and is not recommended for paraphrased requests.

### Does JevScout send private connector data to TypeSafe?

When a qualifying result is condensed, the hook sends segment previews, candidate segment text, and the relevance request to `api.typesafe.ai`. Originals stay in the local cache with owner-only permissions. Use pass-through mode or lexical-only mode when content must remain local.

### What response sizes does the hook condense?

By default, only oversized MCP responses at or above 100 KB are condensed. Inline responses and smaller oversized responses pass through unchanged. `JEVSCOUT_HOOK_SCOPE=all` enables the older inline threshold behavior for users who explicitly need it.

### Does it work with Codex?

The Codex MCP proxy is experimental and has separate host limitations. The ready opt-in path documented here is the Claude Code MCP hook.

## Privacy and data

The hook sees every MCP text result, including private connector content. When a large result is condensed, JevScout sends its segment text and your request (tool arguments and latest prompt, without URLs) to `api.typesafe.ai`, using `TYPESAFE_API_KEY`. Originals are stored locally under `~/.cache/jevscout/outputs` (or `JEVSCOUT_CACHE_DIR`) with owner-only permissions and are deleted after 7 days (`JEVSCOUT_OUTPUT_TTL_DAYS`, `0` keeps them). To keep everything local, do not set the key (results then pass through unchanged) or use `JEVSCOUT_HOOK_MODE=lexical`, which is not recommended (see above).

Other settings: `JEVSCOUT_HOOK_SCOPE` (`oversized` by default, or `all`), `JEVSCOUT_HOOK_MIN_OVERSIZED_BYTES` (default 100000), `JEVSCOUT_HOOK_MIN_BYTES` (default 8000, used with `all`), `JEVSCOUT_HOOK_BUDGET_BYTES` (6000), `JEVSCOUT_HOOK_TIMEOUT_MS` (8000), `JEVSCOUT_HOOK_MODEL` (TypeSafe model). The hook reads Claude Code's oversize notice by its current wording; if a Claude Code update changes it, large results pass through unchanged.

## Codex (experimental)

> **Status:** the Codex adapter is experimental and has not been validated for this release.

Codex hooks cannot replace a successful tool result, so the adapter is an MCP proxy that wraps one stdio server: `node dist/cli.js mcp-proxy -- <server command>`. It uses the same Jev ranking and passes results through when Jev cannot run. It adds an optional `jevscout_intent` argument to each tool (removed before forwarding) and a `jevscout_recover` tool. Codex's own truncation keeps roughly the first and last 10K tokens of a result and can recover the middle with a repeated call.

```toml
# ~/.codex/config.toml (experimental)
[mcp_servers.fetch]
command = "node"
args = ["/path/to/jevscout/dist/cli.js", "mcp-proxy", "--source", "fetch", "--", "uvx", "mcp-server-fetch"]
```

## Experimental commands

JevScout also includes CLI commands for local source evidence and public GitHub issues. They are experimental and carry no performance claim. They require the [ripgrep](https://github.com/BurntSushi/ripgrep) `rg` binary on `PATH` (a shell alias or function named `rg` is not enough).

### Commands

```sh
jevscout search "task or question" --path . --mode auto --budget-bytes 8000
jevscout expand <pack-id> <evidence-id>
jevscout open <pack-id> <evidence-id> --before 30 --after 30
jevscout list <pack-id>
jevscout github search "query" --repo owner/name --mode auto
jevscout github open owner/name#123 --budget-bytes 20000
jevscout check --format json
```

Default output is compact, verbatim source text. Use `--format json` for full diagnostics, or `--report /path/to/new-report.json` to save them without sending them through the agent context. Reports refuse to overwrite existing files. Use `node src/cli.ts` in place of `jevscout` while developing.

| Search option | Default | Purpose |
| --- | --- | --- |
| `--path` | Current directory | Search root |
| `--mode` | `lexical` | `lexical`, `jev`, or `auto` |
| `--terms` | Words derived from query | Up to 12 comma-separated literal search terms |
| `--budget-bytes` | `8000` | Complete UTF-8 text output budget; evidence-record budget in JSON mode |
| `--format` | `text` | Compact source or full diagnostic JSON |
| `--report` | None | Save diagnostic JSON to a new local file |
| `--candidates` | `60` | Candidate excerpt cap, maximum 120 |
| `--model` | `jev-latest` | TypeSafe model; resolved version is reported |
| `--timeout-ms` | `8000` | Total deadline for Jev ranking |

Text output contains exact, numbered source ranges; hashes, duplicate queries, metrics, and long omitted lists stay out of the agent context. `list` retrieves references on demand. `open` retrieves adjacent lines when a partial range is insufficient. The text byte budget covers **complete stdout**, preserving every displayed line verbatim. A full candidate may be narrowed around a matching line to fit the budget; it is labeled as an excerpt and retains its original recovery ID. JSON/report output includes `evidence`, `omitted`, `usedMode`, warnings and metrics. In JSON mode the budget still covers evidence records only. Bytes are not model tokens.

### Public GitHub Evidence

JevScout can search a public repository's issues and pull requests before the results enter an agent's context:

```sh
pnpm start github search "Why do streamText result promises hang after abort?" \
  --repo vercel/ai --mode auto --budget-bytes 5000
pnpm start github search "streamText abort attemptClose" \
  --repo vercel/ai --mode github --evidence-sections
pnpm start github open vercel/ai#16852 --budget-bytes 20000
```

The first command calls GitHub's public issue-search API inside the CLI, optionally asks Jev four separate questions per hit (relevance, answer-bearing evidence, possible premise conflict, and instruction attempt), then returns a bounded packet with issue/PR URLs, state, updated time, and verbatim excerpts. Unshown issue numbers remain in the packet; `github open` fetches the full body and the first page of up to 20 issue comments only when needed; if the item has more comments, the output says how many were not shown. PR review comments are not fetched. A possible conflict remains visible. An instruction-attempt score is a warning, **not** a security boundary.

This command does **not** automatically read `GITHUB_TOKEN`; it is limited to publicly accessible repositories. GitHub search has public rate limits. `--mode github` keeps native GitHub order without calling TypeSafe; `--mode jev` forces evaluation; `auto` evaluates only when multiple full excerpts do not fit. Missing TypeSafe credentials or a failed evaluation preserve GitHub order. In Jev mode, the query, titles, and up to 3,000 characters of each issue body go to `api.typesafe.ai`; `--model` selects the TypeSafe model and JSON output reports the resolved version. Displayed bodies are capped at 1,000 characters each, with a 5,000-byte total output budget by default. `--format json` or `--report /path/to/new-file.json` preserves structured metadata and scores without forcing it into the agent's immediate context.

`--follow-links` is an opt-in, deterministic link follower: when a shown PR body says `Fixes #N` or `Closes #N` for the same repository, up to two such issues are fetched and placed next to the PR, labeled as author claims. It makes no TypeSafe request and has not been evaluated in a matched agent run.

`--evidence-sections` is an opt-in, deterministic selector for long GitHub bodies. It searches heading/paragraph spans for query terms and shows up to two exact source ranges, with character offsets and a visible gap marker when text is omitted. The full URL and `github open` recovery path remain available. A partial-body label records provenance; open the full item when a needed fact is absent, not solely because the body is partial. This selector makes no extra TypeSafe request.

Notion, Linear, private GitHub, and general web search are not integrated in this command; use the hook for those connectors.

### Claim check

`jevscout check` reads **one JSON object from stdin** and scores supplied evidence spans against claims. It does not fetch files, URLs, or other locators. `source` is an opaque citation string.

```sh
printf '%s\n' '{"task":"How does fetchOnce fail closed?","claims":[{"id":"redirects","text":"fetchOnce refuses HTTP redirects."}],"evidence":[{"id":"e1","source":"src/fetch.ts","text":"return fetch(url, { redirect: \"error\" });"}]}' \
  | jevscout check
```

Input shape: `{task, claims:[{id,text}], evidence:[{id,source,text}]}`. Limits are explicit: at most 8 claims, 8 spans, 2000-character task, 500-character claims, 1500-character spans, and 65,536-byte stdin. Oversized input is rejected; content is not silently dropped. Empty `evidence` returns every claim as `unresolved` without calling TypeSafe. Nonempty evidence requires `TYPESAFE_API_KEY` and one System One call; a missing key or provider failure is an error, not a guessed verdict.

Each claim is `supported`, `contradicted`, `mixed`, or `unresolved` from independent Noul questions: whether each exact span **directly supports** the claim, and whether it **directly contradicts** it, in the task context. Question IDs are not sent to the model; instructions point at `state.claims[i].text` and `state.evidence[j].text`. Source text is data. Provisional thresholds are **support ≥ 0.80** and **conflict ≥ 0.80**. A span at or above a threshold can be quoted; mixed keeps both sides. An unresolved claim includes up to three ranked below-threshold evidence leads for review without changing the verdict. At most two exact quotes per side include source id, locator, code-point offsets, and the verbatim text. Quotes are always the whole supplied span (offsets `0` to its length); the checker does not select sub-spans. These statuses describe **supplied evidence**, not verified runtime behavior. Model probabilities do not prove that a claim is true.

Text output lists claim-to-evidence references and prints each selected source span once. `--format json` keeps diagnostics, thresholds, warnings, and TypeSafe `usage`. The text byte budget covers complete stdout and omits whole quotes rather than truncating them; JSON retains the quotes. In check mode, the task, claims, and supplied evidence text are sent to TypeSafe; source locators stay local. No connector, hook, cache, or database is used.

Expansion reads the original source after checking its hash. If any part of the source file changed, search again. Pack references live in `~/.cache/jevscout`, or `JEVSCOUT_CACHE_DIR`. They contain absolute repository paths and source hashes but no source text or API key. There is no automatic cache eviction yet; deleting that directory invalidates old pack IDs. Jev judgments are not cached in this prototype.

### How it works

1. `rg` finds literal query terms in supported text/code files, respecting ignore rules even outside Git repositories.
2. Files at most 3,000 bytes and 100 lines are kept whole. Larger files become bounded excerpts: up to 4 lines before and 8 after a hit. Windows merge only with substantial overlap, up to 40 lines, so adjacent topics can be judged separately. Mixed-case API names remain searchable alongside their component words.
3. Lexical ranking counts distinct matched terms. Optional Jev ranking asks one independent Noul relevance question per candidate, including exceptions and contradictory evidence as useful context.
4. Selection uses the leading request to choose source, test, benchmark, or docs evidence; later mentions of supporting tests do not override an implementation question. A named implementation file gets priority only when its relevance is competitive. A few shortlist slots preserve later windows in top files that add query concepts, while most slots cover different files. Declaration files and root-level test files do not displace runtime source on behavior questions. For failure questions, control-flow windows with `catch`, `throw`, or `abort` get priority after the primary implementation. A result larger than 2,200 output bytes or the remaining budget may be narrowed to a matching range with an explicit partial label. All shortlisted candidates retain local expansion references. No probability threshold deletes them.

Jev calls contain at most 24 candidate excerpts and 48 KB of serialized excerpt text per batch. At most two calls run concurrently under one deadline. Malformed responses, timeouts, or HTTP errors abort in-flight sibling requests and abandon the partial ranking. Original candidates remain available in lexical order. On a failed run, partial provider usage is unknown and may still be billable.

### Limits and data flow

- This is lexical retrieval followed by optional semantic ranking. No embeddings, automatic synonym expansion, AST graph, or inferred call graph. Unknown terminology and distant dependencies can be missed.
- Ripgrep initially reports at most 50 matching lines per file. Files reaching that cap are rescanned locally so later matches can become candidates. Files remain limited to 256 KiB and search output is bounded. Candidate windows are shortlisted across files, up to the configured cap. Excerpts over 12,000 UTF-8 bytes are skipped. Candidate truncation is reported, and retrieval is still not exhaustive.
- Hidden files, common build/dependency directories, common lockfiles, and files named `.env*`, `credentials*`, or `secrets*` are excluded. These exclusions are not a secret scanner. Supported file extensions are listed in `src/retrieve.ts`.
- In `jev`/eligible `auto` mode, the query, selected relative paths, source positions, and excerpt text go to `https://api.typesafe.ai/v1/systemone`. Redirects are refused. No other provider or telemetry endpoint is used.
- `check` sends the task, claim texts, and evidence texts in one System One call. Source locators are not fetched and are not sent. A missing key or invalid response is a failure, not a partial verdict.
- Ranking does not establish truth, completeness, or authority. Required project instructions must be read separately. Always verify a fix with the relevant tests and inspect omitted context when needed.
- JevScout is an independent open-source prototype, not an official TypeSafe product. API access is separate from this MIT-licensed code.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
```

TypeScript source uses Node's native type stripping for development; distributed packages contain compiled JavaScript because Node does not strip TypeScript inside `node_modules`. Tests use Node's built-in test runner and need the `rg` binary on `PATH`. No API key is required for unit tests.

Research informed the scope: [TypeSafe primitives](https://docs.typesafe.ai/primitives), [jev-reranker](https://github.com/shinpr/jev-reranker), and [RTK](https://github.com/rtk-ai/rtk). JevScout's initial implementation is independent; its intended contribution is the discovery-to-evidence workflow and honest evaluation, rather than another generic API client.

Licensed under [MIT](LICENSE).
