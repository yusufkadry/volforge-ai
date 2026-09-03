import assert from "node:assert/strict";
import test from "node:test";
import { supervisionIssues } from "../lib/execution-health";

test("position supervision distinguishes successful lifecycle actions from unresolved failures", () => {
  assert.equal(supervisionIssues([{ event_type: "spread_exit_submitted" }, { event_type: "entry_resubmitted" }]).length, 0);
  assert.deepEqual(supervisionIssues([
    { event_type: "spread_mark_skipped" },
    { event_type: "spread_exit_ack_pending" },
    { event_type: "mismatched_leg_close_error" },
  ]).map((action) => action.event_type), ["spread_mark_skipped", "spread_exit_ack_pending", "mismatched_leg_close_error"]);
});
