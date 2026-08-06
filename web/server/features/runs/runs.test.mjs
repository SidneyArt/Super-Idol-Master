import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createRunsFeature } from "./index.mjs";

function createDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO workspaces VALUES ('default', '默认工作空间', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'default',
      pipeline_type TEXT NOT NULL DEFAULT 'text_to_model', name TEXT NOT NULL,
      positive_prompt TEXT NOT NULL DEFAULT '', negative_prompt TEXT NOT NULL DEFAULT '',
      current_stage INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
      qa_status TEXT NOT NULL DEFAULT 'pending', generation_status TEXT NOT NULL DEFAULT 'idle',
      generation_message TEXT NOT NULL DEFAULT '', generation_progress INTEGER NOT NULL DEFAULT 0,
      generation_prompt_id TEXT, generation_current_node TEXT, preview_path TEXT,
      job_type TEXT NOT NULL DEFAULT 'none', image_path TEXT, source_image_path TEXT,
      source_preview_path TEXT, model_path TEXT, topology_path TEXT, rigged_model_path TEXT,
      qa_score INTEGER, qa_summary TEXT NOT NULL DEFAULT '', qa_metrics TEXT NOT NULL DEFAULT '{}',
      qa_overlay_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
    CREATE TABLE run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, event_type TEXT NOT NULL,
      stage INTEGER NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
  `);
  return db;
}

test("runs feature creates, lists and removes a run through its public interface", () => {
  const db = createDatabase();
  const runs = createRunsFeature({
    db,
    activeJobs: new Map(),
    cleanText(value, maxLength, field, required = false) {
      const text = typeof value === "string" ? value.trim() : "";
      if (required && !text) throw new Error(`${field}不能为空`);
      if (text.length > maxLength) throw new Error(`${field}不能超过 ${maxLength} 个字符`);
      return text;
    },
    exists: () => false,
    id: () => "run-1",
    now: () => "2026-01-02T00:00:00.000Z",
  });

  const created = runs.create({ name: " 测试角色 ", positivePrompt: "hero" });

  assert.equal(created.run.id, "run-1");
  assert.equal(created.run.name, "测试角色");
  assert.deepEqual(runs.list(), [created.run]);
  assert.equal(runs.get("run-1").events[0].eventType, "created");
  assert.deepEqual(runs.remove("run-1"), { ok: true });
  assert.deepEqual(runs.list(), []);
});

test("runs feature resets workflow state while retaining the run", () => {
  const db = createDatabase();
  const runs = createRunsFeature({
    db,
    activeJobs: new Map(),
    cleanText: (value) => typeof value === "string" ? value.trim() : "",
    exists: () => false,
    id: () => "run-reset",
    now: () => "2026-01-02T00:00:00.000Z",
  });
  runs.create({ name: "待重置角色" });
  db.prepare(`
    UPDATE runs SET current_stage = 4, status = 'completed', generation_status = 'succeeded',
      image_path = '/old/image.png', model_path = '/old/model.glb' WHERE id = 'run-reset'
  `).run();

  const reset = runs.reset("run-reset");

  assert.equal(reset.run.currentStage, 0);
  assert.equal(reset.run.status, "active");
  assert.equal(reset.run.assets.imageReady, false);
  assert.equal(reset.events[0].eventType, "reset");
});
