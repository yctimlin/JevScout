# Codex operation adapter

> **Status:** ready for opt-in use as a library for hosts that drive a Codex app-server session.
> It was confirmed on a frozen request set (see [Evaluation](evaluation.md#codex-operation-adapter));
> it is not a general Codex speed-up, and interactive approvals were not part of that evaluation.

`createCodexOperationSession` lets TypeSafe's Jev decide whether a Codex user request is a direct
request to run one of your **reviewed, fixed repository operations**, such as "check formatting
without changing anything" or "run the unit suite". If it is, and the confidence reaches 0.80, the
host runs that operation natively through the Codex app server and records a host receipt in the
thread. Otherwise nothing runs and Codex handles the request normally.

Jev chooses only among operation IDs. It receives the request text and each operation's purpose,
declared writes, and completion description. Executable arguments, working directory,
permissions, and API keys are never sent to TypeSafe and never come from the model.

The adapter is a library for applications that already drive a Codex app-server session. It does
not install into the Codex CLI or desktop app, run a background service, or change model settings.

## Requirements

- An app-server transport initialized with experimental API support for `thread/inject_items`.
- `rpc.request(method, params)` must not retry side-effectful RPCs automatically.
- One adapter per thread, serialized with the host's normal turns.
- `TYPESAFE_API_KEY`. Without it, every request is deferred to normal Codex handling.

The host remains responsible for idle-thread coordination, earlier user constraints, trusted
catalog provenance, and consent.

## Usage

```ts
import { createCodexOperationSession } from 'jevscout/codex';

const adapter = createCodexOperationSession({
  rpc: existingAppServerClient,
  threadId,
  cwd,
  sandboxPolicy: currentThreadSandboxPolicy,
  operations: [{
    id: 'format:check',
    purpose: 'Report formatting problems without changing files.',
    writes: 'None.',
    completion: 'Formatter check output listing files with problems, or none.',
    effect: 'read',
    argv: ['npm', 'run', 'format:check'],
  }],
  key: process.env.TYPESAFE_API_KEY,
  authorize: async (operation, request, signal) => {
    // These checks belong to the embedding application, not to Jev.
    return host.canRunReviewedOperation(operation, request, signal);
  },
  verify: async (operation, execution) => {
    return host.verifyOperationEvidence(operation, execution); // 'passed' | 'findings' | 'failed'
  },
});

const request = { id: stableUserRequestId, text: userText };
const result = await adapter.dispatch(request, abortSignal);
if (result.kind === 'deferred') {
  // No native operation was submitted. Keep the original user request intact.
  await host.continueNormalCodexTurn(request);
} else {
  await host.presentAndPersistOperationResult(result);
}
```

## Host obligations

**Authorization.** `authorize` must recheck current permissions, scope, catalog freshness, and
command prerequisites. Fixed argv can still invoke mutable package scripts or binaries. Pin the
reviewed versions of script manifests, lockfiles, and resolved executable targets (including
installed dependencies), or apply equivalent provenance checks; comparing argv alone is not enough.

**Consent.** The standalone `command/exec` request carries no thread ID or thread approval policy,
so the normal turn approval flow does not cover it. `authorize` must obtain any consent the host
requires before returning true. The evaluation used only `approvalPolicy: never`.

**Sandbox.** A false value, exception, timeout, or write operation under a read-only policy
prevents execution. The adapter copies the caller's native sandbox policy unchanged. It never adds
writable roots or network access and never uses the unsandboxed `thread/shellCommand` API. An
operation's `effect` includes generated files and caches, not only source changes. Supply a
compatible policy up front; do not weaken it after a model decision.

**Verification.** `verify` must inspect actual evidence and return `passed`, `findings`, or
`failed`. For a formatting check, exit 1 with recognized diagnostics can be `findings`; for a build,
check the declared output files. A zero exit code alone does not prove the task is complete.
`passed` with a nonzero exit is downgraded to `failed`.

**Output cap.** Captured output is capped (default 65,536 bytes; the evaluation used 1,000,000) and
flagged as possibly truncated. `verify` sees the capped text and must treat a missing summary line
conservatively. The byte cut can split a multi-byte UTF-8 character. Configure and validate the cap
for your operations before relying on the evaluation's performance.

## Result states

- `deferred`: no command ran, because the key is missing, the provider failed, Jev was not
  confident, the policy is read-only, or the host did not authorize. Normal Codex handling may
  proceed under the host's existing permissions.
- `cancelled`: cancelled before execution. Do not start a fallback turn.
- `completed`: a host-verified `passed` or `findings` result was acknowledged in thread history.
  The receipt describes host execution, not model-generated work.
- `attention`: the command may have run, but verification failed, cancellation followed
  submission, or the history acknowledgement is uncertain. Never turn this into an automatic retry
  or blind fallback. Reconcile it from the receipt, workspace state, and thread history.

## Request IDs and restarts

The same request ID and text return the same promise and result within a live adapter. This also
applies to `deferred` and pre-execution `cancelled` results: repeating an ID does not retry
selection after the provider recovers. A deliberate new attempt needs a new ID, coordinated with
any normal Codex fallback the host already started. Never use a new ID to retry an `attention`
result blindly. Different text under an existing ID is rejected, concurrent requests are rejected
instead of interleaved, and receipt capacity is bounded without silently evicting IDs.

In-memory IDs are not a durable exactly-once guarantee. Persist and reconcile operation status
across application or adapter restarts; the native process ID is derived from the thread and
request IDs, and re-dispatch after a restart is untested.

Cancellation after submission asks the app server to terminate that process; it does not undo
writes. Transport failures keep execution `unknown`. History injection is not retried, because the
server may have recorded the first request even if its acknowledgement was lost.

## Known limits

- Selection sees only the current request text. It does not read the rest of the conversation or
  infer permissions from history.
- The receipt, including up to two capped output streams, is injected into the thread as an
  assistant message labelled as data. That adds follow-up cost and is a prompt-injection surface
  that has not been tested adversarially.
- `verify` receives no abort signal and may keep running after its callback timeout.
- A non-OK TypeSafe response with a non-JSON body is reported without its HTTP status.

## Data sent to TypeSafe

Each dispatch sends one request to `api.typesafe.ai`: the user request text, and the ID, purpose,
declared writes, and completion description of each catalog operation. TypeSafe usage is billed
separately from Codex usage and is returned on each result.
