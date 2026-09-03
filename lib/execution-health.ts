const issueMarkers = ["_error", "_skipped", "_ack_pending", "persistence_pending", "mismatch"];

export function supervisionIssues(actions: Array<Record<string, unknown>>) {
  return actions.filter((action) => {
    const eventType = String(action.event_type ?? action.action ?? "").toLowerCase();
    return issueMarkers.some((marker) => eventType.includes(marker));
  });
}
