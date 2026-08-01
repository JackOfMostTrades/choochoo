import { Literal, sql } from "@sequelize/core";

/**
 * Tests whether a JSON array column contains `value`.
 *
 * This replaces Postgres' `Op.contains` (`@>`), which Sequelize compiles to the
 * literal `@>` operator and so cannot run on MariaDB. MariaDB also has no
 * `MEMBER OF` -- that is MySQL 8 only -- so `JSON_CONTAINS` is the only option.
 *
 * The COALESCE matters: `JSON_CONTAINS(NULL, ...)` is NULL rather than false,
 * and NULL stays falsy when negated by `Op.not`, which would make
 * `NOT contains(...)` wrongly exclude rows whose column is NULL.
 *
 * Returns a Literal, which is a valid leaf anywhere in a `WhereOptions` tree,
 * so it composes inside the existing `Op.and`/`Op.or`/`Op.not` nesting.
 */
export function jsonArrayContains(
  attributeName: string,
  value: number | string,
): Literal {
  // JSON.stringify produces the JSON scalar MariaDB expects as the candidate
  // document. MariaDB has no `CAST(... AS JSON)`, so this must be a string.
  return sql`COALESCE(JSON_CONTAINS(${sql.attribute(attributeName)}, ${JSON.stringify(value)}), 0) = 1`;
}
