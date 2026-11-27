---
name: post-build-flow
description: >-
  Load after a direct workflow_builder_build_workflow succeeds, or when the
  message contains workflow-setup-required.
  One-off builds use one-off-operations instead.
recommended_tool_groups:
  - workflows
  - executions
---

# Post-Build Flow

Use this skill after `workflow_builder_build_workflow` succeeds on a direct orchestrator build,
especially when the build result contains `postBuildFlow.required: true`, or when
the current message contains `<workflow-setup-required>`.

One-off builds (`postBuildFlow.reason: "direct-one-off-build-succeeded"`) hand
off to the `one-off-operations` skill instead. If both sets of instructions are
in context for a one-off build, the one-off flow wins.

User-visible text stays in the user's conversation language.

Load these references when their step comes up:

- `trigger-input-data-shapes` — trigger `inputData` shapes (or read
  `knowledge-base/reference/trigger-input-data-shapes.md` in a sandbox workspace).
- `credential-choices` — before any credential or auth-type question during setup.
- `credential-recipe-research` — for Simplified Custom Auth: load the
  `credential-recipe-research` reference and follow it before you compose
  `credentialHints` for `setup_workflow`.
- `publishing` — before you publish, offer publishing, count a user-run
  execution as evidence, or repair a published workflow.
- `trigger-url-sharing` — before you share a Webhook, Form or Chat Trigger URL.

## Order

Verify and set up first. Republish automatically when editing a workflow that was
already published and has no open setup blockers; keep brand-new workflows as
drafts unless the user asks to publish. Do not ask unsolicited follow-up
questions about live tests, publishing, or error workflows.

## After workflow_builder_build_workflow succeeds

1. Read `workflowId`, `workItemId`, `triggerNodes`, `verificationReadiness`,
   `setupRequirement`, `publishState`, and `postBuildFlow`. Without a `workflowId`, explain that
   the build did not submit.
   - Inspect the saved workflow (`get_workflow_as_code`, or
     the bound source file) against the requested outcome. A save does not prove
     the workflow is good. If it misses the outcome or has a dead-end shape, load
     `workflow-builder`, patch the same `workflowId` and `workItemId`, then
     inspect and verify again.
   - If `verificationReadiness.status === "already_verified"`, do not repeat
     verification. Read the saved claim first.
2. Act on readiness:
   - If `verificationReadiness.status === "ready"`, run
     `workflow_builder_verify_built_workflow` with the `workflowId`, the
     `workItemId` when you have it, and trigger-appropriate `inputData`. Call it
     once per trigger when `triggerNodes` has several entries.
   - If `verificationReadiness.status === "needs_setup"` and the persistent setup
     panel is enabled, verify first when verification has not run, then announce
     setup with `setup_workflow`. With the panel disabled, run `setup_workflow`
     with the workflow ID; the user configures it in the inline setup card.
   - If `verificationReadiness.status === "not_verifiable"`, give the readiness
     guidance as a warning or manual-test note. This is a warning completion
     state, not a verified state and not a blocker.
3. Judge coverage, not status. Relay `simulationNote`, `nodesNotReached`,
   `resolvedParameterWarnings` and `skippedParameterChecks` concisely to the user.
4. If `setupRequirement.status === "required"` and setup has not run for this
   build, call `setup_workflow` with the workflowId. The
   inline setup card in the n8n Assistant panel is the user-visible surface.
5. When `setup_workflow` returns `announced: true`, summarize the panel state
   and end the turn. When it returns `deferred: true`, `skippedByUser` or
   `partial: true`, respect the decision and report what remains.
6. Check the conversation for test data that any live runs left in external
   systems, and follow
   [Cleaning up after a live test](#cleaning-up-after-a-live-test).
7. Publishing:
   - If the workflow was **already published** before your edit
     (`claim.liveState === "live-stale"` or `publishState.live === "stale"`) and
     no required setup items remain open, load `publishing` and run
     `publish_workflow` through `call_tool` (with `acknowledgeUnverified: true`
     when verification used simulations) so the live workflow runs the fix
     without asking first.
   - For a **new, unpublished** workflow, only run `publish_workflow` through
     `call_tool` when the user explicitly asks to publish, and load the
     `publishing` reference first.
8. Only load `error-workflows` when the user explicitly asks to create or attach
   an error workflow. Do not ask unsolicited opt-in questions after publishing.

Do not proactively offer, recommend, or mention publishing for a new unpublished
workflow until a successful execution has run every required node on the claimed
path without mocked credentials, simulated node output, fixture overrides, or
temporary pin data.

## Setup follow-up

When the current message contains `<workflow-setup-required>`, call
`setup_workflow` with the payload `workflowId`. If the result
has `announced: true`, follow [Setup panel](#setup-panel) and end the turn. Then
continue with step 6 above.

## Setup panel

Use this section when the system prompt describes the persistent setup panel,
setup returns `announced: true`, or the current user input contains
`<workflow-test-request>`.

- Setup items can appear during the build, and the user can complete them at
  once. Call it the "setup panel", without a position.
- Verify what can be simulated before asking the user to finish setup. Missing
  credentials do not block this. A simulated result is not a live connection.
- After `announced: true`, summarize open items and validation warnings, then
  end the turn. Do not wait, poll, or open a trigger-test card.
- On a later turn, trust `<workflow-setup-state>` over earlier results. When
  nothing is open and there are no warnings, verify the saved configuration
  again with `workflow_builder_verify_built_workflow`.
- On `<workflow-test-request>`, use the workflow ID in the current block. If
  required items remain open, report them and end the turn. Otherwise run
  `run_workflow` with suitable trigger input without asking again. Read the
  output; for failures, use `debug_execution` and fix the same workflow from the
  current saved source, check artifacts from the failed run, then test again.

A setup card that was already open keeps its apply and trigger-test resume
flow.

## Mocked verification live-test follow-up

After setup, if the latest verification used mocked credentials, simulated node
output, fixture overrides, temporary pin data, or another mocked input, note
concisely which nodes were simulated rather than stopping to ask a separate
question. Do not run a live test with real side effects unless the user
explicitly asks (including `<workflow-test-request>`).
Do not offer publishing as an alternative or describe the workflow as ready to
use or publish while it is an unpublished new workflow.

If the user explicitly asks for a live test, run it with `run_workflow` and
report it separately from the mocked verification. If it fails, the workflow is
unresolved.

## Cleaning up after a live test

A live run against real credentials leaves real artifacts: a row in a sheet, a
message in a channel. Test data you created is yours to clean up, from any turn.

1. Name what it left behind, read back from the effect node's output: which
   record, where, and how to recognise it.
2. Offer to remove it yourself, through a one-off cleanup workflow
   (`one-off-operations`) when no tool does it directly.
3. Ask before deleting.

If the user declines, note that the item is still there and do not re-ask.
When the live run was the point (a one-off operation), what it wrote is the
deliverable: offer to clean up the workflow, never the result.

## Claiming success

`workflow_builder_verify_built_workflow` returns a `claim`. Its `level` decides
what you may say:

- `verified` — you may call the workflow verified, tested, or working.
- `partial`, `unproven`, or `failed` — you may not. Name what is unconfirmed.

For multi-trigger builds, `claim` combines saved passes; verify
`claim.pendingTriggers` within the attempt limit. `claim.liveState` (`live-current`,
`live-stale`, `unpublished`) decides separately whether you may call the
workflow live.

Without a claim, do not say "fixed", "verified", "tested", "working" or "ready"
unless a passing `run_workflow` or an inspected user-run execution exercised the
claimed path. A build, a save, `validate_workflow` or your own narration is not
execution evidence. For a produced artifact, read the real output first. If you
could not verify something, say "I couldn't verify X because Y".
