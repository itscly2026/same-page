// Local benchmark instrumentation. Execute each statement once and retain D1's
// own rows_read/rows_written metadata, including adapters that request raw rows.
export function measureD1(binding: D1Database) {
  const totals = { sql: 0, rowsRead: 0, rowsWritten: 0 };
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const record = (result: D1Result) => { totals.sql++; totals.rowsRead += result.meta.rows_read; totals.rowsWritten += result.meta.rows_written; };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
      if (key === "all" || key === "run") return async () => { const result = await target.all(); record(result); return result; };
      if (key === "first") return async (column?: string) => { const result = await target.all<Record<string, unknown>>(); record(result); return column ? result.results[0]?.[column] ?? null : result.results[0] ?? null; };
      if (key === "raw") return async (options?: { columnNames?: boolean }) => {
        const result = await target.all<Record<string, unknown>>(); record(result);
        const rows = result.results.map(row => Object.values(row));
        return options?.columnNames ? [Object.keys(result.results[0] ?? {}), ...rows] : rows;
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    originals.set(proxy, statement); return proxy;
  };
  const DB = new Proxy(binding, { get(target, key) {
    if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
    if (key === "batch") return async (statements: D1PreparedStatement[]) => { const results = await target.batch(statements.map(statement => originals.get(statement) ?? statement)); results.forEach(record); return results; };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { DB, totals };
}
