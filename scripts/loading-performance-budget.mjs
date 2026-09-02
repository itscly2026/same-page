export function evaluateLoadingBudget(records, budgets) {
  return records.flatMap((record) => {
    const budget = budgets[record.journey];
    return typeof budget === "number" && record.duration > budget
      ? [{ ...record, budget }]
      : [];
  });
}
