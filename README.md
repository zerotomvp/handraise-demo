# handraise-demo

A GitHub Actions workflow that **blocks on a typed human decision in Slack** and resumes with the verdict — powered by [Handraise](https://github.com/zerotomvp/handraise), typed human-feedback infrastructure for agents (blocking MCP tool → native Slack card → structured response → queryable ledger).

## What this demonstrates

The `gate` workflow runs the [`zerotomvp/handraise-gate`](https://github.com/zerotomvp/handraise-gate) action, which talks to Handraise's hosted MCP server (`https://handraise.hack.zmvp.dev/mcp`):

1. The action calls the `request_feedback` tool (`type: approval`) with the run's metadata (repo, run URL, actor) and an assignee.
2. Handraise delivers a native Slack approval card to the assignee and holds the request open.
3. The action polls `fetch_response` until a human taps **Approve** or **Reject** (up to ~10 minutes).
4. The verdict is *typed*, not a comment to parse: `{approved: boolean, comment?: string}`.
   - **Approved** → the gate step exits 0 and the workflow proceeds to the (stand-in) deploy step.
   - **Rejected, timed out, or cancelled** → the gate step exits 1 and the workflow fails visibly.

The hosted endpoint requires a shared demo token to *create* requests (it's pinned in the sandbox Slack workspace — this keeps the public internet from spamming approval cards). The workflow reads it from the `GATE_TOKEN` repo secret and passes it to the action as the `token` input.

## Run it

1. Go to the **Actions** tab → **gate** → **Run workflow**.
2. Set `assignee` to your Slack user id, `@handle`, or email in the Handraise sandbox workspace (default: `georgiosd`) and optionally edit the `title`.
3. Watch the run block on the *handraise-gate* step, answer the card in Slack, and watch the run resume (or fail) with your verdict.

## Honest note: this burns a runner

While the gate waits, a hosted runner sits occupied (up to ~10 minutes here). That's an acceptable cost for a demo, but it's not the end-state design.

**Roadmap:** the same gate as a GitHub [deployment protection rule](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment#deployment-protection-rules) — the workflow pauses runner-free at an environment boundary, Handraise resolves the approval in Slack, and a callback resumes the deployment. Same typed verdict, zero runner-minutes spent waiting.

## Files

- [`.github/workflows/gate.yml`](.github/workflows/gate.yml) — the workflow: checkout → [`zerotomvp/handraise-gate@v1`](https://github.com/zerotomvp/handraise-gate) → stand-in deploy.
