---
name: publishing
description: >-
  Load before you publish a workflow, offer or mention publishing, count a run
  the user started as publishing evidence, or repair a workflow that is already
  published.
recommended_tool_groups:
  - workflows
  - executions
---

# Publishing

**Publishing is never required for testing.** Never publish a workflow as a
precondition for running it.

Do not proactively offer, recommend, or mention publishing until a successful
execution has run every required node on the claimed path without mocked
credentials, simulated node output, fixture overrides, or temporary pin data
for those nodes. A successful verification that used any of these is not
publish-readiness evidence. If the user explicitly asks to publish before a
live execution succeeds, warn that the live path remains untested, then follow
the requested publish flow.

`publish_workflow` enforces this. While the latest verification left
nodes unreached or simulated, the call is refused and returns
`verificationDisclosure` — the coverage facts, generated from the run. Relay
those facts to the user and offer a live end-to-end test. Publish only if they
still ask, by calling publish again with `acknowledgeUnverified: true`. Never
set that flag to skip the disclosure. The user also sees the same facts in the
publish approval prompt, so a summary that contradicts them is visible to them.

Execution evidence can come from a run you started or a run the user started.
If the user says they ran the workflow manually, run
`list_executions` through `call_tool` with `workflowId`, identify the relevant run, and inspect
it by running `get_execution` through `call_tool` with `executionId`. The user's statement alone is
not execution evidence. A user-run execution satisfies the publishing gate only
when the inspected result confirms success and that every required node on the
claimed path ran. Do not count it if mocked, simulated, fixture, or pinned output
was used. You may offer publishing after that confirmation.

## When to publish

For a **new, unpublished** workflow (`activeVersionId: null`), only run
`publish_workflow` through `call_tool` when the user explicitly asks to publish.
Never publish a brand-new workflow automatically.

For an **already-published** workflow (`activeVersionId` is non-null, or
`claim.liveState === "live-stale"` / `publishState.live === "stale"`), republish
your fix automatically once the build and verification succeed and no required
setup items remain open, unless the user explicitly asked to keep the change as
a draft.

## Fixing a workflow that is already published

A repair or edit of a workflow that is already published is different from a new
workflow. That workflow runs in production right now, and your save creates a
draft (`live-stale`). Until the updated draft is published, production continues
running the older broken version.

For a repair or edit on a published workflow:

- When `claim.liveState === "live-stale"` (or `get_workflow(workflowId)` shows a
  non-null `activeVersionId` that differs from `versionId`) and no required
  setup items remain open, run `publish_workflow` through `call_tool`
  immediately without asking whether to publish. If verification simulated
  side-effect nodes or left branches unreached, pass
  `acknowledgeUnverified: true` on `publish_workflow` and state the simulated or
  unreached nodes concisely in your summary.
- Leave the edit as an unpublished draft only when required credentials or
  setup placeholders remain open, verification failed with an unresolved error,
  or the user explicitly asked not to publish yet. In those cases, do NOT report
  the workflow as fixed or live in production — state clearly that the change is
  saved in the draft only.
