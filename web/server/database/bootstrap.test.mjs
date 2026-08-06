import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { bootstrapDatabase } from "./bootstrap.mjs";

test("database bootstrap installs the current schema and default workspace", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  bootstrapDatabase({ db, generatedDir: "/private/tmp/super-idol-master-bootstrap-test" });

  assert.equal(db.prepare("SELECT name FROM workspaces WHERE id = 'default'").get().name, "默认工作空间");
  assert.deepEqual(
    db.prepare("PRAGMA table_info(runs)").all().filter((column) => ["topology_path", "current_stage"].includes(column.name)).map((column) => column.name).sort(),
    ["current_stage", "topology_path"],
  );
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dispatcher_generations'").get());
});
