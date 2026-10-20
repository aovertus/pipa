# STU-722 LFG run report

Date: 2026-10-20. Harness/model: OpenCode / `openai/gpt-6.1-sol`.

## Result

Implemented installation-wide model persistence, ordinary request selection, routine snapshots, native Slack picker, manifest command/scope, and setup documentation.
The initial checkout collision was resolved with the user's authorization: unrelated no-reply work is preserved in stash `deferred no-reply changes before STU-722`. The stash and pre-existing `tmp/` evaluation data remain untouched.
The production Pipa process, production Slack app settings, and production config were not modified or restarted. A distinct temporary Slack app/profile was created for live smoke, then removed after verification.

## Plan and review

Plan: `docs/plans/2026-10-20-1258-feat-slack-installation-model-plan.md`.
Metadata: `artifact_contract: ce-unified-plan/v1`, `artifact_readiness: implementation-ready`, `execution: code`, `product_contract_source: linear-STU-722`.
The checkout ignores `docs/plans/`; the plan is retained locally.

Repo-grounded findings incorporated into implementation:

- Ordinary request handling captured startup config; each request now resolves the saved selection.
- Routine normalization dropped unknown fields; it now validates and preserves the optional model snapshot without migrating legacy records.
- Chat SDK options callbacks lack normalized channel context; opaque picker contexts bind the opening channel, user, and native view.
- Slack options have a 2.5-second adapter deadline; configured-provider discovery is bounded to 1.5 seconds.
- Search reads configured model names/IDs only; it does not establish quota or credentials and never runs inference.

Planning confidence and document review ran inline. Persona passes were performed inline rather than dispatched independently. No independent cross-model review was obtained; this report does not claim corroborated evidence.

## Files

- `src/state.mjs`: model validation, serialized narrow config writes, manifest `/pipa` and `commands`.
- `src/opencode.mjs`: optional copied model in the existing prompt payload; bounded authenticated workspace-scoped provider catalog.
- `src/app.mjs`: request-time selection, routine-record-only selection, picker lifecycle wiring.
- `src/routines.mjs`, `bin/pipa.mjs`: optional snapshot normalization/validation, creation and preview inheritance, edit preservation.
- `src/models.mjs`: native slash/options/modal callbacks, private status/error UX, fresh authorization and catalog checks.
- Owning suites in `test/`, installed-package smoke in `scripts/pack-smoke.mjs`, and user/contributor/architecture documentation.

## Verification evidence

| Unit | Pre-change evidence | Protection and outcome |
|---|---|---|
| U1 | Owning state/executor suites inspected; focused run failed on missing persistence export and absent payload model | State save/reload/preservation, queued writes, failed-write recovery, private permissions, native parts/system/model, stale-session replacement and caller-mutation isolation pass |
| U2 | App/routines/CLI suites inspected; new assertions failed on missing snapshot, inherited preview, and dispatch model | Legacy absent/null, immutable edit snapshot, CLI preview inheritance, routine A versus ordinary followup B in the same session pass |
| U3 | New picker suite failed before module existed | Native installed SDK/adapter command/options/Save/reopen/Cancel and A→B same-session requests pass; denied/foreign/expired contexts, unknown selection, discovery errors, failed writes, option/label bounds, manifest, authenticated catalog and timeout pass |
| U4 | Non-behavioral docs use code/source review; package smoke extended | Installed picker import, command/scope manifest, inherited routine preview, initialization/cancellation/Managed start pass |

Exact successful commands (exit 0):

- `node --test --test-reporter=dot test/state.test.mjs test/opencode.test.mjs`
- `node --test --test-reporter=dot test/app.test.mjs test/routines.test.mjs test/cli.test.mjs`
- `node --test --test-reporter=dot test/models.test.mjs test/opencode.test.mjs test/state.test.mjs test/app.test.mjs`
- `npm test -- --test-reporter=dot`
- `npm run test:pack`

The native routing test replaces only outbound Slack calls. It does not start a Socket listener, create Slack messages, or use real Slack credentials. It proves SDK callback and request-boundary behavior, not live provider completion.

## Live smoke evidence

The initial absence of an isolated profile was resolved using the already authenticated app-management browser. The generated manifest was accepted by Slack to create **Pipa Model Test 722**, app `A0CA6RMHH7H`, with its own app/bot tokens, `/pipa`, `commands`, and Socket Mode. The test bot was invited to the allowed `#test-prod-pipa` channel. Only this distinct profile's Socket listener was started; it attached to the existing OpenCode server with a separate temporary workspace and never owned or restarted that server.

[Existing test conversation](https://lunchpaillabs.slack.com/archives/C0BNJJ9RDB2/p1792500540431779)

| Step | Requested and completed model metadata | Result |
|---|---|---|
| A | `fireworks-ai` / `accounts/fireworks/routers/deepseek-flash-latest` | Native search and Save succeeded; reopen showed saved A; session storage remained empty until the ordinary prompt. Completed response was `MODEL_A_READY`. |
| B | `openai` / `gpt-6.1-sol` | Native search and Save succeeded. A same-thread human followup completed with B and recalled `COBALT-722` from the A prompt, proving retained history. |
| Cancel | B remained selected | Selecting A then canceling and confirming Leave did not alter saved B. |
| Test-only restart | B remained selected | Stopped the test-owned listener, started a replacement with the same isolated profile, and reopened the native modal showing `openai / gpt-6.1-sol`. |

Both completed messages used session `ses_ea6a45909ffekUyM643keCH9oT`. Assistant IDs: A `msg_1595ba732001xmk5SD8QZQASqZ`, B `msg_1595e40cc001fxPQxxVQa7t2ap`. The second verification observed two user messages in that same session. These are captured response metadata, not model self-identification or HTTP acceptance. Fireworks router metadata does not prove its internal upstream model identity.

Cleanup stopped only test-owned PIDs, deleted the temporary Slack app (invalidating its tokens), removed the test-owned OpenCode session and local profile/credentials, and retained non-secret evidence. The Slack test conversation remains as evidence. Recorded session/message IDs are historical after cleanup.

## Shipping follow-through

Simplification completed with no code changes (reuse/quality/efficiency passes inline). No lint or typecheck is configured; the full suite and package smoke are the repository gates.

Code review found one P1 ordering regression at the new pre-enqueue config read. A deterministic regression test failed with `older` delivered instead of `newer`. Model resolution now happens inside the runner callback, preserving enqueue order. The focused app/CLI/model suites and both full checks passed after the fix. Commit: `7e43638` (`fix(review): preserve message order during model resolution`). CLI lifecycle tests now also prove that A and unset-created routines do not adopt live B after an edit.

Review coverage: correctness, scoped project standards, testing, security, reliability, adversarial, API contract, and agent-native passes ran inline. No independent agreement promotion was used. A separate validator was unavailable; the P1 was retained validation-degraded during review and then proved by the red/green regression. No actionable findings or settled-decision conflicts remain.

Browser/native smoke result: **PASS** for open/search/Save/reopen/Cancel and test-only restart persistence, using the existing authenticated browser and the distinct test app. Completed A/B execution metadata and retained history were verified separately through the OpenCode API. This CLI has no local web routes or browser dev server.

PR: https://github.com/lunchpaillola/pipa/pull/41 . The pipeline snapshot for head `ee6a771` reported all checks terminal/successful, `MERGEABLE`, `CLEAN`, current-base identity proven, zero actionable feedback, and no branch-currency or human-decision blocker. The final live-evidence documentation update is checked again on its new head; the babysitter's final return and PR run-report comment record that outcome without another CI-triggering report edit.

### Implementation receipt

```json
{
  "status": "complete",
  "plan_path": "docs/plans/2026-10-20-1258-feat-slack-installation-model-plan.md",
  "source_kind": "plan",
  "source_digest": "sha256:a3ce0366fac6c90894b63d9a847eb6f587225c34567553da1a284f40fe3fa1d9",
  "changed_files": ["src/state.mjs", "src/opencode.mjs", "src/app.mjs", "src/routines.mjs", "src/models.mjs", "bin/pipa.mjs", "test/state.test.mjs", "test/opencode.test.mjs", "test/app.test.mjs", "test/routines.test.mjs", "test/cli.test.mjs", "test/models.test.mjs", "scripts/pack-smoke.mjs", "README.md", "CONTRIBUTING.md", "docs/repository-overview.md", "docs/stu-722-lfg-report.md"],
  "u_ids_attempted": ["U1", "U2", "U3", "U4"],
  "u_ids_completed": ["U1", "U2", "U3", "U4"],
  "verification_results": ["Focused suites: exit 0", "npm test -- --test-reporter=dot: exit 0", "npm run test:pack: exit 0"],
  "verification_evidence": [
    {"unit": "U1", "behavior_changed": true, "existing_tests_inspected": ["test/state.test.mjs", "test/opencode.test.mjs"], "tests_added_or_changed": ["test/state.test.mjs", "test/opencode.test.mjs"], "tests_used_unchanged": "Other state/executor cases", "red_observed": "Missing setting export and absent native payload model", "result": "Owning suites exit 0"},
    {"unit": "U2", "behavior_changed": true, "existing_tests_inspected": ["test/app.test.mjs", "test/routines.test.mjs", "test/cli.test.mjs"], "tests_added_or_changed": ["test/app.test.mjs", "test/routines.test.mjs", "test/cli.test.mjs"], "tests_used_unchanged": "Other app/routine/CLI cases", "red_observed": "Absent dispatch snapshot, preview inheritance, null retention", "result": "Owning suites exit 0"},
    {"unit": "U3", "behavior_changed": true, "existing_tests_inspected": ["test/app.test.mjs", "test/state.test.mjs", "test/opencode.test.mjs"], "tests_added_or_changed": ["test/models.test.mjs", "test/state.test.mjs", "test/opencode.test.mjs"], "tests_used_unchanged": "Existing permission/question/shutdown cases", "red_observed": "Picker module absent before implementation", "result": "Native adapter, failure matrix, authenticated catalog, timeout suites exit 0"},
    {"unit": "U4", "behavior_changed": false, "existing_tests_inspected": ["scripts/pack-smoke.mjs"], "tests_added_or_changed": ["scripts/pack-smoke.mjs"], "tests_used_unchanged": "Installed initialization and Managed smoke", "result": "Full suite and pack smoke exit 0; isolated live native picker, completed A/B metadata, same-session history, Cancel, and test-only restart passed", "exception_reason": "No local web routes; native Slack UI used instead"}
  ],
  "implementation_engine_binding": null,
  "requested_route": "native",
  "actual_route": "native:OpenCode",
  "requested_model": null,
  "actual_model": "openai/gpt-6.1-sol",
  "fallback_reason": null,
  "run_id": null,
  "unit_receipts": [
    {"unit": "U1", "route": "native", "model": "openai/gpt-6.1-sol", "detached_process": null, "integration": "canonical checkout", "verification": "passed", "commit": "8679b5f", "cleanup": "no worker"},
    {"unit": "U2", "route": "native", "model": "openai/gpt-6.1-sol", "detached_process": null, "integration": "canonical checkout", "verification": "passed", "commit": "4cbc321", "cleanup": "no worker"},
    {"unit": "U3", "route": "native", "model": "openai/gpt-6.1-sol", "detached_process": null, "integration": "canonical checkout", "verification": "passed", "commit": "467231a", "cleanup": "no worker"},
    {"unit": "U4", "route": "native", "model": "openai/gpt-6.1-sol", "detached_process": "isolated test listener only; stopped", "integration": "canonical checkout", "verification": "automated/package/live passed", "commit": "fd8181c plus final evidence update", "cleanup": "temporary app, session, profile and credentials removed"}
  ],
  "plan_checkpoint": null,
  "blockers": [],
  "recovery_path": null,
  "settled_decision_conflicts": [],
  "behavior_change": true,
  "standalone_shipping_skipped": true
}
```
