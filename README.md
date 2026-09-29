# JevScout: Faster Claude Code and Codex Workflows with Jev

**Reduce large MCP responses in Claude Code. Skip routine Codex decision turns with reviewed operations and verified execution.**

JevScout is an open-source toolkit that uses [TypeSafe's Jev](https://docs.typesafe.ai/primitives) to reduce time and agent overhead in two workflows:

- **Claude Code MCP context management:** a `PostToolUse` hook semantically ranks large Model Context Protocol (MCP) responses, keeps relevant source text verbatim, and provides exact local recovery. If Jev is unavailable or uncertain, the original response passes through unchanged.
- **Codex operation execution:** a library for applications that drive Codex app-server sessions maps requests to reviewed, fixed repository operations. Host code authorizes, executes, and verifies the operation, then records the result in the conversation. Unsupported or uncertain requests continue through normal Codex handling.

JevScout is independent open-source software, not an official TypeSafe product.

| Component | Status |
| --- | --- |
| Claude Code hook with Jev ranking (default) | **Ready for opt-in use.** In our end-to-end validation, it reduced agent time by 38% and agent cost by 26% without a correctness loss. It preserves exact recovery and passes results through unchanged when Jev is unavailable or uncertain. |
| Codex operation adapter (library) | **Ready for opt-in use** in hosts that drive a Codex app-server session. On six frozen requests, it preserved correctness and reduced task-plus-follow-up time by 62% and Codex tokens (including cached input) by 55% versus warm Codex with the same operation catalog. These results apply to the tested operations. |
| Keyword-only mode (`JEVSCOUT_HOOK_MODE=lexical`) | **Not recommended.** Can drop facts that are worded differently from the request. |
| Shell hook (`gh`, `curl`, … rewritten through a filter) | Experimental; spike-tested only, installed only with `--with-shell`. |
| Codex MCP proxy | **Experimental.** Not validated for this release. |
| Local `search`, `github`, `check` commands | Experimental; mixed pilot results. |

TypeSafe usage is billed separately from the agent cost and token figures above. See [Evaluation](#evaluation) and the [Codex results](#codex-operation-adapter) for scope and measurement details.

<p align="center">
  <img src="assets/jevscout-demo.gif" alt="JevScout demo: a 169 KB MCP result that Claude Code would read in chunks is ranked by Jev, and the agent answers from a 3-segment verbatim packet in 2 turns instead of 5 (−51% time, −42% cost on this task; −38% time, −26% cost across all 7 validation tasks)" width="720">
</p>

## Quick install

Paste one of these prompts into your agent. It runs each step, shows you the output, and asks before enabling the hook or implementing the adapter.

### For Claude Code

Requires Node.js 24+, git, and a TypeSafe API key. Paste into Claude Code:

```text
Install JevScout, a Claude Code hook that uses TypeSafe's Jev to condense large MCP results.
Run each step and show me the output.

1. Check prerequisites: `node --version` (must be 24 or newer) and `git --version`.
   Stop and tell me if either is missing.
2. Install or update it in a fixed location (the hook records this path):
   - If ~/.local/share/jevscout does not exist:
     git clone https://github.com/yctimlin/JevScout.git ~/.local/share/jevscout
   - Otherwise: git -C ~/.local/share/jevscout pull --ff-only
   Then run: cd ~/.local/share/jevscout && npm install   (this also builds dist/)
3. Preview the settings change and show it to me:
   node ~/.local/share/jevscout/dist/cli.js hook install --scope user --dry-run
   Ask me to confirm before continuing.
4. After I confirm, install it:
   node ~/.local/share/jevscout/dist/cli.js hook install --scope user
5. Check whether my TypeSafe key is set, without revealing it:
   test -n "$TYPESAFE_API_KEY" && echo set || echo missing
   Never print the key, ask me to paste it, or write it to any file. If it is missing,
   tell me to get a key at https://typesafe.ai and add `export TYPESAFE_API_KEY=...`
   to my shell profile myself.
6. Tell me to restart Claude Code. Until the key is set, the hook passes results through unchanged.
   To uninstall later: node ~/.local/share/jevscout/dist/cli.js hook uninstall --scope user
```

### For Codex

The [operation adapter](#codex-operation-adapter) is added to an application that drives a Codex app-server session. Open that project in Codex and paste:

```text
Integrate JevScout's Codex operation adapter into this project. Do not commit.

1. Confirm this project drives a Codex app-server session (a JSON-RPC client for
   `codex app-server` that starts threads and turns). If it does not, stop and explain
   that the adapter needs such a host; do not build one without asking me.
2. Check `node --version` is 24 or newer, then add the dependency with npm:
   npm install github:yctimlin/JevScout
   Confirm node_modules/jevscout/dist/codex-operations.js exists.
3. Read node_modules/jevscout/docs/codex-operation-adapter.md in full. It is the host
   contract; follow it exactly.
4. Propose an operation catalog from this repository's own scripts: id, purpose, writes,
   completion, effect ("read" or "write", counting generated files and caches) and fixed
   argv. Only local, fixed commands; nothing that publishes, deploys, pushes or needs the
   network. Show it as a table and wait for my approval.
5. After I approve, implement the integration:
   - One adapter per thread, created with createCodexOperationSession from
     'jevscout/codex-operations', using the thread's existing sandbox policy unchanged,
     after the transport is initialized with experimental API support.
   - Call dispatch() with a stable request ID before starting a normal turn, serialized
     with the host's turns. On "deferred", continue the normal Codex turn with the
     original request. On "cancelled", do not start a fallback turn. On "attention",
     show it to the user and never retry automatically. Persist results.
   - authorize(): recheck permissions, pin SHA-256 hashes of the reviewed package
     manifest, lockfile and resolved executables, and obtain any consent this host
     requires (command/exec does not go through thread approvals).
   - verify(): inspect the actual output and return passed, findings or failed;
     do not treat exit code 0 alone as success.
   - Read the key only from process.env.TYPESAFE_API_KEY. Never print it or write it
     to any file.
6. Add tests with a mocked rpc and fetcher: no key defers without calling the transport,
   a write operation under a read-only policy defers, and "attention" is not retried.
7. Run the tests and show me the diff.
```

Both prompts install from this GitHub repository. Manual steps: [Claude Code hook](#install-the-claude-code-mcp-hook), [Codex adapter](docs/codex-operation-adapter.md).

## At a glance

| Question | Answer |
| --- | --- |
| What is JevScout? | A Claude Code MCP context hook and a Codex operation adapter, both powered by Jev. |
| How does it help Claude Code? | Jev selects relevant segments from large MCP responses, including paraphrased facts. Selected text stays verbatim, with omission markers, source positions, and exact recovery. |
| How does it help Codex? | Jev selects a reviewed repository operation so host code can execute and verify it without a full Codex decision turn. The result is recorded for later conversation turns. |
| What happens when Jev is unavailable? | The Claude hook leaves the original tool result unchanged. The Codex adapter defers the request to normal Codex handling. |
| What do I need? | The Claude integration uses MCP hooks. The Codex library requires an application that already drives Codex app-server sessions and supplies authorization and verification callbacks. |
| Which connectors can the Claude hook handle? | MCP servers for GitHub, Notion, Linear, Slack, fetch services, issue search, and similar text sources. |

## Use cases

For Claude Code workflows that receive large external-context results:

- Reading long GitHub issue searches, pull requests, and comment threads.
- Finding a fact in a large changelog, Markdown or reStructuredText document, or JSON response.
- Reducing MCP context usage while keeping an exact recovery path to the original response.
- Selecting evidence from text that uses different words from the user's request.

The context hook does not replace Claude Code's built-in `Read`, `Bash`, or `WebFetch` tools. Its evaluated path is the MCP `PostToolUse` hook.

For Codex app-server hosts, the operation adapter handles explicit requests to run reviewed commands: check formatting, apply formatting without lint fixes, run a unit suite, or build local package artifacts. Host code checks permissions and results; requests outside the catalog continue through Codex.

## Install the Claude Code MCP hook

Requires Node.js 24+, git, Claude Code (tested with 2.1.281), and a TypeSafe API key.

To install with a prompt, see [Quick install](#for-claude-code).

1. Get an API key from [TypeSafe](https://typesafe.ai) and export it in the shell that starts Claude Code, for example in your shell profile:
   ```sh
   export TYPESAFE_API_KEY=...
   ```
   The key is read from the environment only; JevScout never writes it to any file.
2. Clone and build JevScout (the package is not published to npm yet):
   ```sh
   git clone https://github.com/yctimlin/JevScout.git ~/.local/share/jevscout
   cd ~/.local/share/jevscout && npm install       # also builds dist/
   ```
3. Choose one installation scope. Preview the settings change with `--dry-run` before installing.

   For all your projects, use user scope (`~/.claude/settings.json`, backed up before changes):
   ```sh
   node ~/.local/share/jevscout/dist/cli.js hook install --scope user --dry-run
   node ~/.local/share/jevscout/dist/cli.js hook install --scope user
   ```

   For one project, first change to that project's directory. Project scope writes its `.claude/settings.json`:
   ```sh
   cd /path/to/your-project
   node ~/.local/share/jevscout/dist/cli.js hook install --scope project --dry-run
   node ~/.local/share/jevscout/dist/cli.js hook install --scope project
   ```
4. Restart Claude Code so it picks up the key and the hook.

To uninstall a user-scoped hook, run `node ~/.local/share/jevscout/dist/cli.js hook uninstall --scope user`. For a project-scoped hook, run the same command with `--scope project` from that project's directory. Uninstall removes only JevScout's entries.

`install` adds a `PostToolUse` hook for `mcp__.*` and one allow rule for the read-only recovery command, and prints what will be sent to TypeSafe. It records the absolute path of this checkout, so keep the checkout where it is. To update, run `git pull --ff-only && npm install` in the checkout. Without `TYPESAFE_API_KEY` the hook does nothing: results pass through unchanged.

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

Yes, as a library rather than an installable hook. For Codex, the [operation adapter](#codex-operation-adapter) library is ready for opt-in use in applications that drive a Codex app-server session. The Codex MCP proxy is experimental and has not been validated.

## Privacy and data

The hook sees every MCP text result, including private connector content. When a large result is condensed, JevScout sends its segment text and your request (tool arguments and latest prompt, without URLs) to `api.typesafe.ai`, using `TYPESAFE_API_KEY`. Originals are stored locally under `~/.cache/jevscout/outputs` (or `JEVSCOUT_CACHE_DIR`) with owner-only permissions and are deleted after 7 days (`JEVSCOUT_OUTPUT_TTL_DAYS`, `0` keeps them). To keep everything local, do not set the key (results then pass through unchanged) or use `JEVSCOUT_HOOK_MODE=lexical`, which is not recommended (see above).

Other settings: `JEVSCOUT_HOOK_SCOPE` (`oversized` by default, or `all`), `JEVSCOUT_HOOK_MIN_OVERSIZED_BYTES` (default 100000), `JEVSCOUT_HOOK_MIN_BYTES` (default 8000, used with `all`), `JEVSCOUT_HOOK_BUDGET_BYTES` (6000), `JEVSCOUT_HOOK_TIMEOUT_MS` (8000), `JEVSCOUT_HOOK_MODEL` (TypeSafe model). The hook reads Claude Code's oversize notice by its current wording; if a Claude Code update changes it, large results pass through unchanged.

## Codex operation adapter

> **Status:** ready for opt-in use as a library for Codex app-server hosts. Confirmed on a frozen request set; not a general Codex speed-up.

Many Codex requests are really "run this known command": check formatting, apply the formatter, run the unit suite, build the package. Codex normally spends a full agent turn working out and running the command. The operation adapter lets Jev map the request to one of your reviewed, fixed operations instead. If Jev's confidence reaches 0.80 and your host authorizes it, the command runs natively through the Codex app server, your code verifies the evidence, and a host receipt is recorded in the thread so later turns know what happened. Otherwise nothing runs and Codex handles the request normally.

```ts
import { createCodexOperationSession } from 'jevscout/codex-operations';
```

The selection payload sent to TypeSafe contains the request text and each operation's ID, purpose, declared writes, and completion description. The adapter does not add execution arguments (`argv`), the working directory (`cwd`), sandbox policy, or API credentials to that payload. Paths or other details included in the request or descriptions are sent as part of that text. Jev selects an operation ID; the host supplies the executable arguments and retains authorization, consent, sandbox policy, and verification.

On six frozen requests across two repositories (36 runs), Jev with native execution was correct in 12/12 runs, as were warm Codex and a keyword-rule baseline. It reduced task-plus-follow-up time by 62% and Codex tokens (including cached input) by 55% versus warm Codex, and out-of-scope requests fell back safely. TypeSafe usage is separate. See the [adapter guide](docs/codex-operation-adapter.md) for the host contract and the [evaluation notes](docs/evaluation.md#codex-operation-adapter) for the limits of this result.

To integrate it with a prompt, see [Quick install](#for-codex).

## Codex MCP proxy (experimental)

> **Status:** the Codex MCP proxy is experimental and has not been validated for this release.

In the tested Codex CLI version, `PostToolUse` does not transparently replace a successful MCP result. The experimental MCP proxy wraps one stdio server: `node dist/cli.js mcp-proxy -- <server command>`. It adds an optional `jevscout_intent` argument to compatible tool schemas, removes it before forwarding the call, and adds `jevscout_recover` for exact local recovery.

The proxy uses the tool name, usable text from its arguments, and any supplied `jevscout_intent` to rank large text responses with Jev. It passes the original through when Jev is unavailable or uncertain. It cannot see the user's broader request unless Codex includes it in the tool arguments. This path has separate performance characteristics and remains experimental.

```toml
# ~/.codex/config.toml (experimental)
[mcp_servers.fetch]
command = "node"
args = ["/path/to/jevscout/dist/cli.js", "mcp-proxy", "--source", "fetch", "--", "uvx", "mcp-server-fetch"]
env_vars = ["TYPESAFE_API_KEY"]
```

`env_vars` forwards the TypeSafe key from Codex's environment to the local MCP proxy without writing its value to this configuration. Results over 8,000 bytes are eligible for Codex proxy selection; this is separate from the Claude Code hook's 100 KB oversized-result default. When Jev is used, response text and the tool's relevance request go to `api.typesafe.ai` as described above.

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
