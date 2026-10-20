# Contributing

Issues and focused pull requests are welcome. Open an issue before starting a large change so the approach can be agreed on first.

## Development

Pipa requires Node.js 22 or newer.

```sh
npm ci
npm test
npm run test:pack
```

Keep changes small, include a regression test for behavior changes, and never commit Slack tokens or files from `~/.pipa`.

For model-selection changes, iterate with `node --test test/state.test.mjs test/opencode.test.mjs test/models.test.mjs test/app.test.mjs test/routines.test.mjs test/cli.test.mjs`, then run both required checks above.

### Isolated Slack model smoke

Use a distinct Slack test app and a separate `PIPA_HOME` (the parent of `.pipa`), with its own app/bot tokens, working directory, and channel/user allowlists. Install `/pipa` and grant `commands`, enable Socket Mode and interactivity, reinstall or reauthorize, and invite the test app to the allowed channel. Never run a second Socket listener with production credentials or restart production Pipa for a smoke test.

1. Open `/pipa model`, search and save model A, then reopen to verify the selection.
2. Send an ordinary request and inspect the completed OpenCode assistant message's provider/model metadata. HTTP acceptance or asking the model which model it is does not prove selection.
3. Save model B and reply in that same Slack thread. Verify completed metadata names B and that the session/history is retained.
4. Cancel another picker and verify no setting changed. Restart only the test profile and reopen to verify persistence.
5. Record selected IDs, completed metadata, and a short existing Slack conversation link separately from automated outcomes. Clean up only test-owned processes/state. Without the isolated app/profile, record the live-smoke gap rather than presenting adapter tests as live evidence.

## Releases

Pipa follows Semantic Versioning:

- New backward-compatible capability: minor release (`0.1.0` to `0.2.0`)
- Backward-compatible fix: patch release (`0.2.0` to `0.2.1`)
- Breaking change: discuss the version before release

To publish a release:

1. Update `package.json` and `package-lock.json` in the feature pull request.
2. Run `npm test` and `npm run test:pack`.
3. Merge after CI passes.
4. Tag the merge as `v<version>` and push the tag.
5. Run `npm publish --access public`.
6. Verify the published npm version, then create the matching GitHub release.
