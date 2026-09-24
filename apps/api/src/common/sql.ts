import { getTableName, sql, type Column } from 'drizzle-orm';

/**
 * A fully qualified column reference ("table"."column") for use inside correlated
 * subqueries. Drizzle renders `${table.col}` unqualified when the outer query selects from a
 * single table, and PostgreSQL would then resolve it against the subquery's own table.
 */
export function qcol(column: Column) {
  return sql.raw(`"${getTableName(column.table)}"."${column.name}"`);
}
