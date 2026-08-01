import { Op, Sequelize, WhereOptions } from "@sequelize/core";
import { MariaDbDialect } from "@sequelize/mariadb";
import { jsonArrayContains } from "./json_query";

describe("jsonArrayContains", () => {
  // A connection is never opened; this only exercises SQL generation.
  const sequelize = new Sequelize({
    dialect: MariaDbDialect,
    database: "test",
    user: "test",
    password: "test",
  });

  function whereSql(where: WhereOptions): string {
    return sequelize.queryGenerator.whereQuery(where);
  }

  it("compiles to a null-safe JSON_CONTAINS", () => {
    const sql = whereSql({ [Op.and]: [jsonArrayContains("playerIds", 5)] });
    expect(sql).toContain("JSON_CONTAINS(");
    expect(sql).toContain("`playerIds`");
    expect(sql).toContain("COALESCE(");
    // The candidate must be a JSON scalar string; MariaDB has no CAST(.. AS JSON).
    expect(sql).toContain("'5'");
  });

  it("composes inside Op.or alongside ordinary attribute clauses", () => {
    const sql = whereSql({
      [Op.or]: [jsonArrayContains("playerIds", 7), { ownerId: 7 }],
    });
    expect(sql).toContain("JSON_CONTAINS(");
    expect(sql).toContain("`ownerId` = 7");
    expect(sql).toContain(" OR ");
  });

  it("composes inside Op.not", () => {
    const sql = whereSql({
      [Op.not]: jsonArrayContains("abandonedPlayerIds", 3),
    });
    expect(sql).toContain("NOT");
    expect(sql).toContain("`abandonedPlayerIds`");
  });

  it("negation is null-safe, so a NULL column is treated as not containing", () => {
    // Without the COALESCE, JSON_CONTAINS(NULL, ..) is NULL, which stays falsy
    // under NOT and would wrongly drop rows with a NULL array.
    const sql = whereSql({ [Op.not]: jsonArrayContains("notes", 1) });
    expect(sql).toContain("COALESCE(");
  });
});
