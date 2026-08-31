import fs from "node:fs";
import path from "node:path";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "./client.ts";
import * as schema from "./schema.ts";
import { TABLE_NAMES } from "./schema.ts";
import { openHarness, seedRun } from "./test-support.ts";

const exportedTables = (Object.values(schema) as unknown[]).filter((value): value is SQLiteTable => is(value, SQLiteTable));

describe("baseline migration", () => {
  it("is the single migration 0000_orchestration_core and ends with the schema_info row and guard triggers", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toEqual(["0000_orchestration_core"]);
    const sql = fs.readFileSync(path.join(MIGRATIONS_FOLDER, "0000_orchestration_core.sql"), "utf8");
    expect(sql).toContain("INSERT INTO `schema_info` (`id`, `application`, `schema`, `version`) VALUES (1, 'agentique-console', 'orchestration-core', 1)");
    expect(sql).toContain("CREATE TRIGGER `events_no_update`");
    for (const table of TABLE_NAMES) expect(sql, table).toContain(`CREATE TABLE \`${table}\``);
    expect(fs.readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith(".sql"))).toEqual(["0000_orchestration_core.sql"]);
  });

  it("creates exactly the required tables, matching schema.ts table by table and column by column", () => {
    const h = openHarness();
    try {
      const actualTables = (h.database.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      expect(actualTables).toEqual([...TABLE_NAMES].sort());
      expect(exportedTables.map(getTableName).sort()).toEqual([...TABLE_NAMES].sort());
      for (const table of exportedTables) {
        const expectedColumns = Object.values(getTableColumns(table)).map((c) => c.name).sort();
        // `table_xinfo` lists generated (virtual) columns too, which `table_info` hides.
        const actualColumns = (h.database.sqlite.prepare(`PRAGMA table_xinfo(${JSON.stringify(getTableName(table))})`).all() as { name: string }[]).map((c) => c.name).sort();
        expect(actualColumns, getTableName(table)).toEqual(expectedColumns);
      }
    } finally {
      h.close();
    }
  });

  it("matches the drizzle snapshot for every table and column", () => {
    const snapshot = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "0000_snapshot.json"), "utf8")) as { tables: Record<string, { name: string; columns: Record<string, unknown> }> };
    const snapshotTables = Object.values(snapshot.tables);
    expect(snapshotTables.map((t) => t.name).sort()).toEqual([...TABLE_NAMES].sort());
    for (const table of exportedTables) {
      const entry = snapshotTables.find((t) => t.name === getTableName(table));
      expect(entry, getTableName(table)).toBeDefined();
      expect(Object.keys(entry!.columns).sort()).toEqual(Object.values(getTableColumns(table)).map((c) => c.name).sort());
    }
  });
});

describe("database constraints", () => {
  it("enforces foreign keys", () => {
    const h = openHarness();
    try {
      expect(() =>
        h.database.sqlite
          .prepare("INSERT INTO conversations (id, workspace_id, title, active_run_id, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?)")
          .run("cv_000000000000000000000000", "ws_000000000000000000000000", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      h.close();
    }
  });

  it("rejects an unknown Invocation purpose, a removed Attempt kind, and a join with a Pattern at the database", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const now = "2026-01-01T00:00:00.000Z";
      const insertInvocation = (purpose: string, role = "orchestrator", position: string | null = '{"kind":"orchestrator"}', positionKey: string | null = "orchestrator") =>
        h.database.sqlite
          .prepare(
            "INSERT INTO invocations (id, run_id, plan_node_id, role, purpose, agent_definition_revision_id, continued_from_invocation_id, pattern_position, pattern_position_key, task_ids, alloc_cost_usd, alloc_tokens, alloc_attempts, allocation_source, final_reserve_use, status, wait_reason, failure_reason, result, created_at, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, '[]', 1, 1, 1, 'plan_node', NULL, 'pending', NULL, NULL, NULL, ?, NULL, NULL)",
          )
          .run(`inv_${"0".repeat(24)}`, s.run.id, s.root.id, role, purpose, s.definition.id, position, positionKey, now);
      expect(() => insertInvocation("turn")).toThrow(/CHECK constraint failed: invocations_purpose/);
      expect(() => insertInvocation("step")).toThrow(/CHECK constraint failed: invocations_role_purpose/);
      // The Pattern position: closed kinds, present unless a Gate Evaluator, the key agreeing with the JSON, the role agreeing with the kind.
      expect(() => insertInvocation("operator_input", "orchestrator", '{"kind":"turn"}', "turn")).toThrow(/CHECK constraint failed: invocations_pattern_position_kind/);
      expect(() => insertInvocation("operator_input", "orchestrator", null, null)).toThrow(/CHECK constraint failed: invocations_pattern_position_present/);
      expect(() => insertInvocation("operator_input", "orchestrator", '{"kind":"orchestrator"}', "single")).toThrow(/CHECK constraint failed: invocations_pattern_position_key_agrees/);
      expect(() => insertInvocation("operator_input", "orchestrator", '{"kind":"chain_step","index":1,"count":2}', "chain_step:1")).toThrow(/CHECK constraint failed: invocations_pattern_position_role/);
      expect(() => insertInvocation("operator_input")).not.toThrow();
      expect(() =>
        h.database.sqlite
          .prepare("INSERT INTO attempts (id, invocation_id, run_id, plan_node_id, number, kind, start_mode, resumed_from_attempt_id, status, failure_class, transcript_artifact_id, capacity_lease_id, result, created_at, started_at, ended_at) VALUES (?, ?, ?, ?, 1, 'turn', 'fresh', NULL, 'pending', NULL, NULL, NULL, NULL, ?, NULL, NULL)")
          .run(`att_${"0".repeat(24)}`, `inv_${"0".repeat(24)}`, s.run.id, s.root.id, now),
      ).toThrow(/CHECK constraint failed: attempts_kind/);
      expect(() =>
        h.database.sqlite
          .prepare("UPDATE plan_nodes SET status = 'running', wait_reason = NULL WHERE id = ?")
          .run(s.root.id),
      ).not.toThrow();
      expect(() =>
        h.database.sqlite
          .prepare(
            "INSERT INTO plan_nodes (id, run_id, created_in_revision_number, kind, pattern, title, source_path, status, wait_reason, fan_in_policy, input, shape, alloc_cost_usd, alloc_tokens, alloc_attempts, max_concurrency, max_wall_clock_ms, on_allocation_exhausted, run_on_dependency_failure, gate_acceptance_criterion_ids, output_artifact_ids, created_at, started_at, ended_at) VALUES (?, ?, 1, 'join', 'single', 'j', 'e1', 'pending', NULL, 'require_all', NULL, NULL, 0, 0, 0, NULL, NULL, NULL, 0, NULL, NULL, ?, NULL, NULL)",
          )
          .run(`pn_${"1".repeat(24)}`, s.run.id, now),
      ).toThrow(/CHECK constraint failed: plan_nodes_join_shape/);
      expect(() =>
        h.database.sqlite
          .prepare(
            "INSERT INTO plan_nodes (id, run_id, created_in_revision_number, kind, pattern, title, source_path, status, wait_reason, fan_in_policy, input, shape, alloc_cost_usd, alloc_tokens, alloc_attempts, max_concurrency, max_wall_clock_ms, on_allocation_exhausted, run_on_dependency_failure, gate_acceptance_criterion_ids, output_artifact_ids, created_at, started_at, ended_at) VALUES (?, ?, 1, 'join', NULL, 'j', 'e1', 'pending', NULL, 'best_effort', NULL, NULL, 0, 0, 0, NULL, NULL, NULL, 0, NULL, NULL, ?, NULL, NULL)",
          )
          .run(`pn_${"2".repeat(24)}`, s.run.id, now),
      ).toThrow(/CHECK constraint failed: plan_nodes_fan_in_policy/);
      // A pattern node's shape must agree with its Pattern column, and only the root holds the orchestrator role.
      const patternInsert = (pattern: string, shape: string, sourcePath: string) =>
        h.database.sqlite
          .prepare(
            "INSERT INTO plan_nodes (id, run_id, created_in_revision_number, kind, pattern, title, source_path, status, wait_reason, fan_in_policy, input, shape, alloc_cost_usd, alloc_tokens, alloc_attempts, max_concurrency, max_wall_clock_ms, on_allocation_exhausted, run_on_dependency_failure, gate_acceptance_criterion_ids, output_artifact_ids, created_at, started_at, ended_at) VALUES (?, ?, 1, 'pattern', ?, 'p', ?, 'pending', NULL, NULL, '{}', ?, 0, 0, 0, NULL, NULL, 'fail', 0, '[]', NULL, ?, NULL, NULL)",
          )
          .run(`pn_${Math.random().toString(16).slice(2, 26).padEnd(24, "0")}`, s.run.id, pattern, sourcePath, shape, now);
      expect(() => patternInsert("chain", '{"pattern":"single","role":"worker"}', "e3")).toThrow(/CHECK constraint failed: plan_nodes_pattern_shape/);
      expect(() => patternInsert("single", '{"pattern":"single","role":"orchestrator"}', "e4")).toThrow(/CHECK constraint failed: plan_nodes_orchestrator_only_root/);
      expect(() => patternInsert("chain", '{"pattern":"chain"}', "root")).toThrow(/CHECK constraint failed: plan_nodes_root_shape/);
    } finally {
      h.close();
    }
  });

  it("guards append-only and immutable tables with triggers", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const sqlite = h.database.sqlite;
      expect(() => sqlite.prepare("UPDATE events SET type = 'x' WHERE seq = 1").run()).toThrow(/events are append-only/);
      expect(() => sqlite.prepare("DELETE FROM events").run()).toThrow(/events are append-only/);
      expect(() => sqlite.prepare("UPDATE execution_plan_revisions SET source = '{}' WHERE run_id = ?").run(s.run.id)).toThrow(/immutable/);
      expect(() => sqlite.prepare("UPDATE plan_nodes SET pattern = 'chain' WHERE id = ?").run(s.root.id)).toThrow(/definition columns are immutable/);
      expect(() => sqlite.prepare("UPDATE agent_definition_revisions SET instructions = 'x' WHERE id = ?").run(s.definition.id)).toThrow(/immutable/);
      expect(() => sqlite.prepare("DELETE FROM budget_reservations").run()).toThrow(/historical records/);
      expect(() => sqlite.prepare("UPDATE plan_revision_nodes SET position = 9 WHERE run_id = ?").run(s.run.id)).toThrow(/immutable/);
      expect(() => sqlite.prepare("DELETE FROM plan_revision_nodes").run()).toThrow(/immutable/);
      expect(() => sqlite.prepare("UPDATE runs SET kind = 'other' WHERE id = ?").run(s.run.id)).toThrow(/immutable/);
      expect(() => sqlite.prepare("DELETE FROM schema_info").run()).toThrow(/never deleted/);
      // Approval uses are append-only and every insertion is re-checked against the Decision, Invocation, Attempt, and manifest rows.
      expect(() => sqlite.prepare("INSERT INTO approved_tool_call_uses (id, decision_id, tool, call_digest, run_id, plan_node_id, invocation_id, attempt_id, claimed_at) VALUES (?, ?, 'shell', ?, ?, ?, ?, ?, ?)").run(`acu_${"1".repeat(24)}`, `dec_${"1".repeat(24)}`, "a".repeat(64), s.run.id, s.root.id, `inv_${"1".repeat(24)}`, `att_${"1".repeat(24)}`, "2026-01-01T00:00:00.000Z")).toThrow(/approved_tool_call_use claims a resolved approve_once/);
      expect(() => sqlite.prepare("DELETE FROM approved_tool_call_uses").run()).not.toThrow();
      // Runtime-tool calls hold the per-Invocation replay and one-proposal rules as unique indexes (their append-only triggers are exercised with rows in the store test).
      expect((sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runtime_tool_calls' AND name LIKE 'runtime_tool_calls_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name)).toEqual(["runtime_tool_calls_attempt", "runtime_tool_calls_invocation_call", "runtime_tool_calls_one_proposal", "runtime_tool_calls_plan_node"]);
      expect((sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' AND name = 'tasks_replaced_once'").all() as { name: string }[]).map((r) => r.name)).toEqual(["tasks_replaced_once"]);
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'approved_tool_call_uses' ORDER BY name").all()).toEqual([{ name: "approved_tool_call_uses_claim_valid" }, { name: "approved_tool_call_uses_no_delete" }, { name: "approved_tool_call_uses_no_update" }]);
      // Budget Increases and Allocation Extensions are append-only and re-checked at insertion (execution-model §7.6).
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'budget_increases' ORDER BY name").all()).toEqual([{ name: "budget_increases_no_delete" }, { name: "budget_increases_no_update" }, { name: "budget_increases_valid" }]);
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'allocation_extensions' ORDER BY name").all()).toEqual([{ name: "allocation_extensions_no_delete" }, { name: "allocation_extensions_no_update" }, { name: "allocation_extensions_valid" }]);
      expect((sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'decisions' AND name = 'decisions_open_budget_increase_run'").all() as { name: string }[]).map((r) => r.name)).toEqual(["decisions_open_budget_increase_run"]);
      expect(() => sqlite.prepare("INSERT INTO budget_increases (id, run_id, decision_id, partition, added_cost_usd, added_tokens, added_attempts, created_at) VALUES (?, ?, ?, 'ordinary', 1, 0, 0, ?)").run(`binc_${"1".repeat(24)}`, s.run.id, `dec_${"1".repeat(24)}`, "2026-01-01T00:00:00.000Z")).toThrow(/authorized by the run''s operator-approved budget_increase decision|budget_increase decision/);
      expect(() => sqlite.prepare("INSERT INTO allocation_extensions (id, run_id, plan_node_id, reservation_id, added_cost_usd, added_tokens, added_attempts, trigger, created_at) VALUES (?, ?, ?, ?, 1, 0, 0, 'invocation', ?)").run(`aext_${"1".repeat(24)}`, s.run.id, s.root.id, `bres_${"1".repeat(24)}`, "2026-01-01T00:00:00.000Z")).toThrow(/allocation extension raises the active ordinary/);
    } finally {
      h.close();
    }
  });
});
