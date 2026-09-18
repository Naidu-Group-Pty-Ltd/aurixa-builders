/**
 * A migration's version is the order it runs in, and nothing in this repository
 * checked that a migration sorts after the objects it needs. The fault that
 * prompted this shipped in a merged pull request: a file numbered
 * `20260917110000` altered a table created by `20261123000000`, so a rebuild
 * from this repository would have run it two months before the table existed.
 *
 * Every rule about what Postgres does or does not resolve at the statement was
 * MEASURED against PostgreSQL 16 rather than remembered, because the first
 * version of this analysis assumed `drop policy if exists … on t` required `t`
 * and produced 88 findings on this corpus, every one of them wrong.
 */
import { describe, expect, it } from "vitest";
import {
  stripUnresolved,
  canon,
  extractEvents,
  extractRequirements,
  versionOf,
  FOREIGN_SCHEMAS,
} from "../../../scripts/lib/migrationDependencyOrder.mjs";

const reqs = (sql: string) => extractRequirements(stripUnresolved(sql));
const forms = (sql: string) => reqs(sql).map((r) => `${r.form}:${r.name}`);

describe("what is not SQL the planner resolves is removed first", () => {
  it("keeps every offset, so a reported line is the line in the file", () => {
    const src = "alter table a;\n-- alter table b;\nalter table c;";
    const out = stripUnresolved(src);
    expect(out).toHaveLength(src.length);
    expect(out.split("\n")).toHaveLength(3);
  });

  it("strips line comments, block comments and strings", () => {
    expect(forms("-- alter table ghost")).toEqual([]);
    expect(forms("/* alter table ghost */")).toEqual([]);
    expect(forms("select 'alter table ghost';")).toEqual([]);
  });

  it("nests block comments, as Postgres does", () => {
    expect(forms("/* outer /* inner */ alter table ghost */")).toEqual([]);
  });

  it("reads a doubled quote as an escape rather than a close", () => {
    expect(forms("select 'it''s alter table ghost';")).toEqual([]);
  });

  /*
   * The rule that makes this analysis usable at all. A PL/pgSQL body is stored
   * as text and resolved when it RUNS, not when the function is created — so a
   * body naming a table a later migration creates is correct and ordinary.
   * Counting those would bury every real finding.
   */
  it("strips a dollar-quoted body, of any tag", () => {
    expect(forms("create function f() returns void as $$ begin insert into ghost values (1); end $$ language plpgsql;")).toEqual([]);
    expect(forms("create function f() returns void as $body$ alter table ghost add column c int; $body$ language plpgsql;")).toEqual([]);
  });

  it("does not mistake a bare $ for a dollar quote", () => {
    expect(stripUnresolved("select a$b from t;")).toBe("select a$b from t;");
  });
});

describe("a name is one object however it is spelled", () => {
  it("drops an explicit public schema so both spellings meet", () => {
    expect(canon("public.foo")).toBe("foo");
    expect(canon("foo")).toBe("foo");
    expect(canon('"Foo"')).toBe("foo");
  });

  it("keeps a real schema, because aml.cases is not cases", () => {
    expect(canon("aml.cases")).toBe("aml.cases");
  });
});

describe("the forms Postgres resolves at the statement", () => {
  it("counts the ones that require the object", () => {
    expect(forms("alter table t add column c int;")).toContain("alter table:t");
    expect(forms("create index i on t(c);")).toContain("create index on:t");
    expect(forms("create policy p on t for select using (true);")).toContain("create policy on:t");
    expect(forms("create trigger g after insert on t for each row execute function f();")).toContain("create trigger on:t");
    expect(forms("create table x (a int references t(id));")).toContain("references:t");
    expect(forms("insert into t (c) values (1);")).toContain("insert into:t");
    expect(forms("update t set c = 1;")).toContain("update:t");
    expect(forms("delete from t where c = 1;")).toContain("delete from:t");
    expect(forms("comment on table t is 'x';")).toContain("comment on:t");
    expect(forms("alter sequence s restart;")).toContain("alter sequence:s");
    expect(forms("alter type e add value 'x';")).toContain("alter type:e");
  });

  /*
   * Measured, not assumed: `drop policy if exists p on t` SUCCEEDS when `t`
   * does not exist — the guard covers the relation, not only the policy. So
   * does `alter table if exists`. Reading these as requirements is what
   * produced 88 wrong findings.
   */
  it("does not count a statement that tolerates the object's absence", () => {
    expect(forms("drop policy if exists p on t;")).toEqual([]);
    expect(forms("alter table if exists t add column c int;")).toEqual([]);
    expect(forms("drop policy p on t;")).toContain("drop policy on:t");
  });

  it("counts a view's own sources, because a view body is resolved as it is created", () => {
    expect(forms("create view v as select * from t;")).toContain("view body reads:t");
  });

  it("does not count a common table expression as a table", () => {
    const f = forms("create view v as with recent as (select 1) select * from recent;");
    expect(f).not.toContain("view body reads:recent");
  });

  it("does not count the tail of a WITH list either", () => {
    const f = forms("create view v as with a as (select 1), b as (select 2) select * from a join b on true;");
    expect(f).not.toContain("view body reads:a");
    expect(f).not.toContain("view body reads:b");
  });

  it("ignores a schema this repository does not own", () => {
    expect(FOREIGN_SCHEMAS.has("cron")).toBe(true);
    expect(FOREIGN_SCHEMAS.has("auth")).toBe(true);
    expect(forms("insert into cron.job (schedule) values ('x');")).toEqual([]);
  });
});

describe("creations and drops are a timeline, not a set", () => {
  it("records both, in the order they appear", () => {
    const e = extractEvents(stripUnresolved("drop table if exists t; create table t (a int);"));
    expect(e.map((x) => x.kind)).toEqual(["drop", "create"]);
  });

  it("reads `create or replace view` as a creation", () => {
    const e = extractEvents(stripUnresolved("create or replace view v as select 1;"));
    expect(e[0]).toMatchObject({ kind: "create", cls: "view", name: "v" });
  });
});

describe("the version is the order", () => {
  it("is the leading fourteen digits", () => {
    expect(versionOf("20261202090000_x.sql")).toBe("20261202090000");
    expect(versionOf("TEMPLATE_RLS_POLICY.sql")).toBeNull();
  });
});
