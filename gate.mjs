#!/usr/bin/env node
// handraise-gate: block a CI run on a typed human approval delivered over Slack.
//
// Calls the hosted Handraise MCP server's `request_feedback` tool (type: approval),
// then polls `fetch_response` until a human approves/rejects or the gate times out.
// Exit 0 = approved (workflow proceeds). Exit 1 = rejected / timed out / cancelled.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.HANDRAISE_MCP_URL || "https://handraise.hack.zmvp.dev/mcp";
// Shared demo token gating request creation on the hosted server (pinned in the
// sandbox Slack). Optional: without it the gate still works against an open server.
const GATE_TOKEN = process.env.GATE_TOKEN;
const ASSIGNEE = process.env.GATE_ASSIGNEE;
const TITLE = process.env.GATE_TITLE || "CI gate: proceed?";
const GATE_DEADLINE_MS = 10 * 60 * 1000; // give up after ~10 minutes total

if (!ASSIGNEE) {
  console.error("::error::GATE_ASSIGNEE is not set (Slack user id, @handle, or email).");
  process.exit(1);
}

// --- helpers ---------------------------------------------------------------

function parseToolResult(result, toolName) {
  if (result.isError) {
    const text = result.content?.[0]?.text ?? JSON.stringify(result.content);
    throw new Error(`${toolName} returned a tool error: ${text}`);
  }
  const text = result.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`${toolName} returned no text content: ${JSON.stringify(result.content)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${toolName} returned non-JSON text: ${text}`);
  }
}

function fail(message) {
  console.error(`::error::Gate FAILED: ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`Gate PASSED: ${message}`);
  process.exit(0);
}

// Decide from a resolved request object; returns true if it handled the outcome.
function settleIfTerminal(state) {
  const status = state.status ?? state.state;
  if (status === "pending") return false;

  if (status === "cancelled" || status === "canceled") {
    fail(`request was cancelled by the server${state.reason ? ` (${state.reason})` : ""}.`);
  }
  if (status === "expired" || status === "timeout" || status === "timed_out") {
    fail("request expired before anyone responded.");
  }

  // Resolved: the typed approval response is {approved: boolean, comment?: string}.
  const response = state.response ?? state.result ?? state;
  const approved = response?.approved ?? state.approved;
  const comment = response?.comment ?? state.comment;
  if (approved === true) {
    pass(`approved by a human${comment ? ` — comment: ${comment}` : ""}.`);
  }
  if (approved === false) {
    fail(`rejected by a human${comment ? ` — comment: ${comment}` : ""}.`);
  }
  fail(`request finished in an unrecognized state: ${JSON.stringify(state)}`);
}

// --- main ------------------------------------------------------------------

const runMeta = [
  `**Repository:** ${process.env.GITHUB_REPOSITORY ?? "(local run)"}`,
  `**Run:** ${
    process.env.GITHUB_RUN_ID
      ? `[#${process.env.GITHUB_RUN_ID}](${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID})`
      : "(local run)"
  }`,
  `**Triggered by:** ${process.env.GITHUB_ACTOR ?? process.env.USER ?? "unknown"}`,
  `**Ref:** ${process.env.GITHUB_REF ?? "n/a"}`,
].join("\n");

const client = new Client({ name: "handraise-gate", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
  requestInit: GATE_TOKEN ? { headers: { Authorization: `Bearer ${GATE_TOKEN}` } } : undefined,
});

console.log(`Connecting to Handraise MCP server at ${MCP_URL} ...`);
await client.connect(transport);

console.log(`Requesting approval from ${ASSIGNEE}: "${TITLE}"`);
const started = Date.now();

let state;
try {
  const result = await client.callTool({
    name: "request_feedback",
    arguments: {
      title: TITLE,
      type: "approval",
      payload: { summary_md: `### ${TITLE}\n\n${runMeta}` },
      assignees: [ASSIGNEE],
      timeout_s: 45,
      requester: {
        agent: "handraise-gate (GitHub Action)",
        origin: "action",
      },
    },
  });
  state = parseToolResult(result, "request_feedback");
} catch (err) {
  await client.close().catch(() => {});
  fail(`request_feedback call failed: ${err.message}`);
}

try {
  // The initial call may already be terminal (fast tap, cancellation, error).
  settleIfTerminal(state);

  const requestId = state.request_id ?? state.id;
  if (!requestId) {
    fail(`server returned pending but no request_id: ${JSON.stringify(state)}`);
  }
  console.log(`Request ${requestId} is pending — a Slack card is on its way to ${ASSIGNEE}. Waiting for a verdict...`);

  while (Date.now() - started < GATE_DEADLINE_MS) {
    const result = await client.callTool({
      name: "fetch_response",
      arguments: { request_id: requestId, wait_s: 40 },
    });
    state = parseToolResult(result, "fetch_response");
    settleIfTerminal(state);
    console.log(`Still pending (${Math.round((Date.now() - started) / 1000)}s elapsed)...`);
  }

  fail(`no response within ${GATE_DEADLINE_MS / 60000} minutes — treating as not approved.`);
} catch (err) {
  fail(`gate errored while waiting: ${err.message}`);
} finally {
  await client.close().catch(() => {});
}
