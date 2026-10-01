import { readFileSync } from "node:fs";
const path = process.argv[2];
if (!path) throw new Error("Provide an exported plugin operational JSONL log");
const categories = new Set([
  "crude_refined",
  "natural_gas",
  "futures",
  "marine",
  "drilling",
]);
const outcomes = new Set([
  "completed",
  "entitlement",
  "authentication",
  "rate_limit",
  "unavailable",
  "upstream_error",
  "invalid_argument",
]);
const report = {
  population:
    "Unclassified tool calls and browser-navigation handoff proxies; neither is a person or logical research task.",
  tool_calls: 0,
  completed_tool_calls: 0,
  excluded_internal_calls: 0,
  handoff_navigation_proxies: 0,
  dataset_call_mix: {},
  outcomes: {},
  research_tasks: null,
  usable_task_rate: null,
  repeat_usage_distinct_days: null,
  handoff_per_research: null,
  signup_per_handoff: null,
  api_key_creation_per_signup: null,
  first_authenticated_per_key: null,
  paid_per_signup: null,
  paid_per_research: null,
  attributable_mrr: null,
  paid_by_initial_dataset: null,
  threshold_readout:
    "Not evaluable: distinct external research tasks and authoritative conversion joins have not been verified.",
};
for (const line of readFileSync(path, "utf8").split("\n")) {
  let event;
  try {
    event = JSON.parse(line.slice(line.indexOf("{")));
  } catch {
    continue;
  }
  if (!categories.has(event.dataset_category)) continue;
  if (
    event.event === "plugin_handoff_visit" &&
    event.population === "browser_navigation_proxy"
  ) {
    report.handoff_navigation_proxies++;
    continue;
  }
  if (event.event !== "plugin_tool_call" || !outcomes.has(event.outcome))
    continue;
  if (event.population === "internal_test") {
    report.excluded_internal_calls++;
    continue;
  }
  report.tool_calls++;
  if (event.outcome === "completed") report.completed_tool_calls++;
  report.dataset_call_mix[event.dataset_category] =
    (report.dataset_call_mix[event.dataset_category] ?? 0) + 1;
  report.outcomes[event.outcome] = (report.outcomes[event.outcome] ?? 0) + 1;
}
console.log(JSON.stringify(report, null, 2));
