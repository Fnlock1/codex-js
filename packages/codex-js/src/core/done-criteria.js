export const DEFAULT_DONE_CRITERIA = Object.freeze([
  "Answer the user's latest request directly.",
  "Stop once the requested change or answer is complete.",
  "Report validation performed, or clearly say what was not verified.",
  "Do not keep calling tools just to look for extra work."
]);

export function normalizeDoneCriteria(value) {
  const criteria = (Array.isArray(value) ? value : [])
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);

  return criteria.length > 0 ? criteria : [...DEFAULT_DONE_CRITERIA];
}

export function createDoneCriteriaMessage(value, options = {}) {
  const criteria = normalizeDoneCriteria(value);
  const title = String(options.title ?? "Done criteria");

  return [
    `${title}:`,
    ...criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "When these criteria are satisfied, produce the final answer instead of continuing to call tools."
  ].join("\n");
}
