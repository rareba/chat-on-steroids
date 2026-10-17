# Keeping this fork current

This fork keeps the coding-provider integration and recovery safeguards as normal
commits on `main`. Upstream changes are merged, so both histories and our fixes
remain available. No upstream file snapshot replaces the fork's working tree.

For a fresh clone of `rareba/chat-on-steroids`, configure the original project once:

```sh
git remote add upstream https://github.com/totec448-spec/chat-on-steroids.git
```

For each update, start with a clean working tree and merge the original project:

```sh
git switch main
git fetch upstream
git merge --no-ff upstream/main
npm ci
npm run typecheck
npm test -- test/openai-api.test.ts test/openai-protocol.test.ts test/chat-models.test.ts test/chatgpt-dom-input.test.ts test/content-script.test.ts
npm run build
git push origin main
```

Resolve conflicts by preserving both upstream behavior and the fork's provider
contracts. Check cooldown persistence/expiry, exact model and effort selection,
tool round trips and error propagation. Never reset `main` to upstream or use a
force push to synchronize it. Existing integration worktrees name the public
fork remote `fork`; there, use `git push fork HEAD:main` instead of `origin`.

Before deployment, build a separate release, retain the previous runtime and
profile, wait for active requests to finish, and run a real coding/tool request
through the gateway. Build/test directories must use isolated user data.
