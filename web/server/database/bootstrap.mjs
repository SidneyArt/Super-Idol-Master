import { existsSync } from "node:fs";
import { join } from "node:path";

export function bootstrapDatabase({ db, generatedDir }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const defaultWorkspace = db.prepare("SELECT id FROM workspaces WHERE id = 'default'").get();
  if (!defaultWorkspace) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO workspaces (id, name, description, created_at, updated_at)
      VALUES ('default', '默认工作空间', '由现有角色任务自动迁移而来', ?, ?)
    `).run(now, now);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      pipeline_type TEXT NOT NULL DEFAULT 'text_to_model',
      name TEXT NOT NULL,
      positive_prompt TEXT NOT NULL DEFAULT '',
      negative_prompt TEXT NOT NULL DEFAULT '',
      current_stage INTEGER NOT NULL DEFAULT 0 CHECK(current_stage BETWEEN 0 AND 6),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed')),
      qa_status TEXT NOT NULL DEFAULT 'pending' CHECK(qa_status IN ('pending', 'passed', 'failed')),
      generation_status TEXT NOT NULL DEFAULT 'idle' CHECK(generation_status IN ('idle', 'running', 'succeeded', 'failed')),
      generation_message TEXT NOT NULL DEFAULT '',
      generation_progress INTEGER NOT NULL DEFAULT 0 CHECK(generation_progress BETWEEN 0 AND 100),
      generation_prompt_id TEXT,
      generation_current_node TEXT,
      preview_path TEXT,
      job_type TEXT NOT NULL DEFAULT 'none',
      image_path TEXT,
      source_image_path TEXT,
      source_preview_path TEXT,
      model_path TEXT,
      topology_path TEXT,
      rigged_model_path TEXT,
      qa_score INTEGER,
      qa_summary TEXT NOT NULL DEFAULT '',
      qa_metrics TEXT NOT NULL DEFAULT '{}',
      qa_overlay_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      stage INTEGER NOT NULL CHECK(stage BETWEEN 0 AND 6),
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS run_events_run_id_idx ON run_events(run_id, id DESC)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS animation_assets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      duration REAL NOT NULL,
      track_count INTEGER NOT NULL,
      bone_count INTEGER NOT NULL,
      mapped_bone_count INTEGER NOT NULL,
      compatible INTEGER NOT NULL DEFAULT 0,
      bone_names TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  
  function addColumn(name, definition) {
    const columns = db.prepare("PRAGMA table_info(runs)").all();
    if (!columns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
    }
  }
  
  addColumn("qa_status", "TEXT NOT NULL DEFAULT 'pending'");
  addColumn("generation_status", "TEXT NOT NULL DEFAULT 'idle'");
  addColumn("generation_message", "TEXT NOT NULL DEFAULT ''");
  addColumn("generation_progress", "INTEGER NOT NULL DEFAULT 0");
  addColumn("generation_prompt_id", "TEXT");
  addColumn("generation_current_node", "TEXT");
  addColumn("job_type", "TEXT NOT NULL DEFAULT 'none'");
  addColumn("image_path", "TEXT");
  addColumn("model_path", "TEXT");
  addColumn("rigged_model_path", "TEXT");
  addColumn("qa_score", "INTEGER");
  addColumn("qa_summary", "TEXT NOT NULL DEFAULT ''");
  addColumn("qa_metrics", "TEXT NOT NULL DEFAULT '{}'");
  addColumn("qa_overlay_path", "TEXT");
  addColumn("workspace_id", "TEXT NOT NULL DEFAULT 'default'");
  addColumn("pipeline_type", "TEXT NOT NULL DEFAULT 'text_to_model'");
  addColumn("source_image_path", "TEXT");
  addColumn("source_preview_path", "TEXT");
  addColumn("topology_path", "TEXT");
  
  function migrateTopologyStage() {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get()?.sql || "";
    if (!/current_stage\s+BETWEEN\s+0\s+AND\s+5/i.test(schema)) return;
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec(`
        CREATE TABLE runs_topology_v2 (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL DEFAULT 'default',
          pipeline_type TEXT NOT NULL DEFAULT 'text_to_model',
          name TEXT NOT NULL,
          positive_prompt TEXT NOT NULL DEFAULT '',
          negative_prompt TEXT NOT NULL DEFAULT '',
          current_stage INTEGER NOT NULL DEFAULT 0 CHECK(current_stage BETWEEN 0 AND 6),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed')),
          qa_status TEXT NOT NULL DEFAULT 'pending' CHECK(qa_status IN ('pending', 'passed', 'failed')),
          generation_status TEXT NOT NULL DEFAULT 'idle' CHECK(generation_status IN ('idle', 'running', 'succeeded', 'failed')),
          generation_message TEXT NOT NULL DEFAULT '',
          generation_progress INTEGER NOT NULL DEFAULT 0 CHECK(generation_progress BETWEEN 0 AND 100),
          generation_prompt_id TEXT,
          generation_current_node TEXT,
          preview_path TEXT,
          job_type TEXT NOT NULL DEFAULT 'none',
          image_path TEXT,
          source_image_path TEXT,
          source_preview_path TEXT,
          model_path TEXT,
          topology_path TEXT,
          rigged_model_path TEXT,
          qa_score INTEGER,
          qa_summary TEXT NOT NULL DEFAULT '',
          qa_metrics TEXT NOT NULL DEFAULT '{}',
          qa_overlay_path TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
        INSERT INTO runs_topology_v2 (
          id, workspace_id, pipeline_type, name, positive_prompt, negative_prompt,
          current_stage, status, qa_status, generation_status, generation_message,
          generation_progress, generation_prompt_id, generation_current_node,
          preview_path, job_type, image_path, source_image_path, source_preview_path,
          model_path, topology_path, rigged_model_path, qa_score, qa_summary,
          qa_metrics, qa_overlay_path, created_at, updated_at
        )
        SELECT id, workspace_id, pipeline_type, name, positive_prompt, negative_prompt,
          CASE WHEN current_stage >= 4 THEN current_stage + 1 ELSE current_stage END,
          CASE WHEN current_stage >= 4 THEN 'active' ELSE status END,
          qa_status, generation_status, generation_message, generation_progress,
          generation_prompt_id, generation_current_node, preview_path, job_type,
          image_path, source_image_path, source_preview_path, model_path, NULL,
          CASE WHEN current_stage >= 4 THEN NULL ELSE rigged_model_path END,
          qa_score, qa_summary, qa_metrics, qa_overlay_path, created_at, updated_at
        FROM runs;
        CREATE TABLE run_events_topology_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          stage INTEGER NOT NULL CHECK(stage BETWEEN 0 AND 6),
          message TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
        );
        INSERT INTO run_events_topology_v2 (id, run_id, event_type, stage, message, created_at)
        SELECT id, run_id, event_type, CASE WHEN stage >= 4 THEN stage + 1 ELSE stage END, message, created_at
        FROM run_events;
        DROP TABLE run_events;
        DROP TABLE runs;
        ALTER TABLE runs_topology_v2 RENAME TO runs;
        ALTER TABLE run_events_topology_v2 RENAME TO run_events;
        CREATE INDEX run_events_run_id_idx ON run_events(run_id, id DESC);
        CREATE INDEX IF NOT EXISTS runs_workspace_id_idx ON runs(workspace_id, updated_at DESC);
      `);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
  
  migrateTopologyStage();
  db.prepare("UPDATE runs SET workspace_id = 'default' WHERE workspace_id IS NULL OR workspace_id = ''").run();
  db.prepare("UPDATE runs SET pipeline_type = 'text_to_model' WHERE pipeline_type IS NULL OR pipeline_type = ''").run();
  db.exec("CREATE INDEX IF NOT EXISTS runs_workspace_id_idx ON runs(workspace_id, updated_at DESC)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatcher_generations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      character_count INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed')),
      message TEXT NOT NULL DEFAULT '',
      preview_path TEXT,
      output_path TEXT,
      request_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )
  `);
  const dispatcherGenerationColumns = db.prepare("PRAGMA table_info(dispatcher_generations)").all();
  if (!dispatcherGenerationColumns.some((column) => column.name === "session_id")) {
    db.exec("ALTER TABLE dispatcher_generations ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
  }
  if (!dispatcherGenerationColumns.some((column) => column.name === "request_json")) {
    db.exec("ALTER TABLE dispatcher_generations ADD COLUMN request_json TEXT NOT NULL DEFAULT '{}'");
  }
  db.exec("CREATE INDEX IF NOT EXISTS dispatcher_generations_workspace_idx ON dispatcher_generations(workspace_id, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS dispatcher_generations_session_idx ON dispatcher_generations(workspace_id, session_id, updated_at DESC)");
  db.prepare("UPDATE dispatcher_generations SET status = 'failed', message = '本地服务重启，合集图生成已中断', updated_at = ? WHERE status = 'running'").run(new Date().toISOString());
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatcher_task_batches (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL,
      run_ids TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS dispatcher_task_batches_session_idx ON dispatcher_task_batches(workspace_id, session_id, created_at DESC)");
  
  db.prepare(`
    UPDATE runs SET generation_status = 'failed', generation_message = '本地服务重启，原 DGX 任务已中断'
    WHERE generation_status = 'running'
  `).run();
  
  // Never advance a stage during startup repair. Only move backward when a stage's
  // required upstream artifact is missing.
  for (const row of db.prepare("SELECT id, current_stage, qa_status, preview_path, image_path, model_path, topology_path, rigged_model_path FROM runs").all()) {
    let imagePath = row.image_path;
    const migratedImage = join(generatedDir, `${row.id}.png`);
    if (!imagePath && row.preview_path && existsSync(migratedImage)) imagePath = migratedImage;
    const hasImage = Boolean(imagePath && existsSync(imagePath));
    const hasModel = Boolean(row.model_path && existsSync(row.model_path));
    const hasTopology = Boolean(row.topology_path && existsSync(row.topology_path));
    const hasRig = Boolean(row.rigged_model_path && existsSync(row.rigged_model_path));
    let stage = Number(row.current_stage || 0);
    if (stage >= 2 && !hasImage) stage = 1;
    if (stage >= 3 && row.qa_status !== "passed") stage = 2;
    if (stage >= 4 && !hasModel) stage = 3;
    if (stage >= 5 && !hasTopology) stage = 4;
    if (stage >= 6 && !hasRig) stage = 5;
    const status = stage === 6 && hasRig ? "completed" : "active";
    db.prepare(`
      UPDATE runs SET image_path = ?, current_stage = ?, status = ?, updated_at = updated_at
      WHERE id = ?
    `).run(imagePath || null, stage, status, row.id);
  }
  
}
