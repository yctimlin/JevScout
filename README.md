# JevScout

**Condense large external tool results before they fill Claude Code's context.**

JevScout is an opt-in Claude Code hook. When an MCP tool (GitHub, Notion, Linear, Slack, fetch servers, and others) returns a large text result, the hook replaces it with a compact packet: the most relevant parts, verbatim, with gaps marked and a command to recover any omitted text exactly. Small results pass through untouched. It is independent open-source software, not an official TypeSafe product; TypeSafe's Jev ranking is optional and off by default.

| Component | Status |
| --- | --- |
| Claude Code MCP hook (lexical selection) | **Evaluated.** Passed two pre-registered rounds; recommended as an opt-in. |
| Claude Code shell hook (`gh`, `curl`, … rewritten through a filter) | Experimental; spike-tested only, installed only with `--with-shell`. |
| Jev ranking in the hook | Optional; no measurable gain over lexical selection in our tests. |
| Codex MCP proxy | **Experimental, not recommended.** Failed our pre-registered rule in both rounds. |
| Local `search`, `github`, `check` commands | Experimental; mixed pilot results. |

## Install the Claude Code hook

Requires Node.js 24+ and Claude Code (tested with 2.1.281). The package is not published yet; from a checkout:

```sh
pnpm install && pnpm build
node dist/cli.js hook install --scope project   # writes .claude/settings.json (backup first)
node dist/cli.js hook install --scope user      # or ~/.claude/settings.json
node dist/cli.js hook uninstall --scope project # removes only JevScout's entries
node dist/cli.js hook install --dry-run         # print the result without writing
```

`install` adds a `PostToolUse` hook for `mcp__.*` and one allow rule for the read-only recovery command. It records the absolute path of this checkout, so keep the checkout where it is. After publication, install the package globally or in the project; do not run `hook install` through `npx`, whose cache path is not stable. `hook settings` prints the same configuration if you prefer to edit settings yourself.

## What the hook does

- **Large MCP text results** (over 8,000 bytes) become a packet of at most 6,000 bytes. When a result exceeds Claude Code's own token limit, Claude Code replaces it with a notice asking the agent to read a saved copy completely in chunks; the hook condenses that saved copy instead, reading it only from the current session's `tool-results` directory.
- **Segments by shape:** JSON records (including JSON after a text preamble, truncated arrays, and large nested maps), markdown or reStructuredText sections with their heading path, or line windows. JSON records show their informative fields with values verbatim and say how many fields were hidden.
- **Relevance** comes from the tool's arguments (not URLs) and your latest prompt, with rare terms weighted more and exact keys (such as a version number) boosted. The packet says when distinctive terms appear nowhere in the output.
- **Recovery:** `node dist/cli.js output <id> --segment N | --grep TEXT | --all` returns exact original text. `--grep` accepts literal text or, if that finds nothing, a regular expression.
- **Fails open:** any error leaves the tool result unchanged. Images and other non-text results are never touched.
- **Not covered:** Claude Code's built-in `Read`, `Bash`, and `WebFetch` output cannot be replaced by hooks (WebFetch already returns a model summary).

## Results

Two pre-registered rounds with frozen fixtures ([protocol, results, and limits](docs/evaluation.md)). Each round compared the hook with no hook on the same tasks, five repetitions per arm, seeded randomized order, one run at a time, with `claude-sonnet-5`. Answers were fictional facts inserted into real documents (so a model could not know them), or real millisecond timestamps. The rule, fixed before the first run: correctness no lower on any task, no task more than 10% slower or costlier, and lower geometric-mean time and cost.

| | Round 1 (5 tasks) | Round 2, held out (6 tasks) | Round 2 rerun, release build |
| --- | ---: | ---: | ---: |
| Time (geometric mean) | −32% | −47% | −43% |
| Cost (geometric mean) | −20% | −34% | −30% |
| Tasks worse by more than 10% | none | none | none |
| Correct, hook / no hook | 25/25 vs 25/25 | 35/35 vs 34/35 | 35/35 vs 32/35 |

Largest gains came where Claude Code would otherwise ask the agent to read a large saved result in chunks (issue searches, comment threads, long docs: roughly −55% to −63% time). A small control document, below the threshold, was unchanged. A live check with the real `mcp-server-fetch` server and live GitHub JSON (three runs per arm, not an evaluation) found median 5 turns, 32 s, and $0.135 with the hook against 11 turns, 187 s, and $0.224 without it, after fixing two issues that check exposed (JSON behind a text preamble and truncated JSON arrays).

**Limits:** one agent model; tasks and fixtures built by the JevScout authors, even when held out; frozen fixtures rather than live connectors; percentages come from per-task medians of five runs. **Corrections we made along the way:** an early Codex comparison measured the model's prior knowledge rather than retrieval, which is why answers are now fictional facts; and a round-2 fixture gave one comment two author names, so that task was rebuilt and rerun and its original correctness difference is not claimed.

## Privacy and data

The hook sees every MCP text result, including private connector content. Originals are stored locally under `~/.cache/jevscout/outputs` (or `JEVSCOUT_CACHE_DIR`) with owner-only permissions and are deleted after 7 days (`JEVSCOUT_OUTPUT_TTL_DAYS`, `0` keeps them). Nothing leaves your machine unless you enable Jev: `JEVSCOUT_HOOK_MODE=auto` with `TYPESAFE_API_KEY` sends segment text and the relevance query to `api.typesafe.ai`.

Other settings: `JEVSCOUT_HOOK_MIN_BYTES` (default 8000), `JEVSCOUT_HOOK_BUDGET_BYTES` (6000), `JEVSCOUT_HOOK_TIMEOUT_MS` (4000, Jev only). The hook reads Claude Code's oversize notice by its current wording; if a Claude Code update changes it, large results pass through unchanged rather than failing.

## Codex (experimental, not recommended)

> **Warning:** the Codex adapter is not recommended. In our evaluation it failed the same pre-registered rule in both rounds, so it may make some tasks slower.

Codex hooks cannot replace a successful tool result, so the adapter is an MCP proxy that wraps one stdio server: `node dist/cli.js mcp-proxy -- <server command>`. It adds an optional `jevscout_intent` argument to each tool (removed before forwarding) and a `jevscout_recover` tool. Results with `gpt-6-sol`: on large full-content results it cut cost 40–72% and time on most tasks, but round 1's small control was 11% slower (noise-level, but over the limit), and round 2's paginated task was 44% slower. On that task direct access was faster mainly because it answered wrongly in 4 of 5 runs after Codex truncated a large page. Codex's own truncation keeps roughly the first and last 10K tokens of a result and can recover the middle with a repeated call. Details are in [the hook evaluation](docs/evaluation.md).

```toml
# ~/.codex/config.toml (experimental)
[mcp_servers.fetch]
command = "node"
args = ["/path/to/jevscout/dist/cli.js", "mcp-proxy", "--source", "fetch", "--", "uvx", "mcp-server-fetch"]
```

## Experimental commands

JevScout began as a CLI that finds local source evidence and public GitHub issues before an agent reads them. Those commands still work, but earlier pilots showed mixed results: some wins on tuned tasks, and regressions elsewhere. They are provided as-is, without a performance claim. They require the [ripgrep](https://github.com/BurntSushi/ripgrep) `rg` binary on `PATH` (a shell alias or function named `rg` is not enough).

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
