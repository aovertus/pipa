# STU-722 LFG run report

Date: 2026-10-20. Harness/model: OpenCode / `openai/gpt-6.1-sol`.

## Result

Implemented installation-wide model persistence, ordinary request selection, routine snapshots, native Slack picker, manifest command/scope, and setup documentation.
The initial checkout collision was resolved with the user's authorization: unrelated no-reply work is preserved in stash `deferred no-reply changes before STU-722`. The stash and pre-existing `tmp/` evaluation data remain untouched.
Production Pipa and Slack were not modified or restarted.

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

## Live smoke limitation

No distinct isolated Slack app/profile with app and bot tokens, installed `/pipa`, `commands`, and an authorized channel/user was supplied for this run. No second listener was started with production credentials.
Consequently live modal behavior, completed provider/model metadata for A/B, real retained conversation history, and persistence after a test-profile restart remain unverified. Historical provider preflight and HTTP acceptance are not substituted for that evidence. Follow `CONTRIBUTING.md`'s isolated smoke procedure to close the gap.

## Shipping follow-through

Implementation returned to LFG after local checks. Simplification, code review, shipping, and CI outcomes are recorded below as those stages run.
