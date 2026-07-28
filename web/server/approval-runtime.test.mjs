import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApprovalRuntime } from "./approval-runtime.mjs";

test("global UI preferences persist and provide the default approval mode", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const runtime = createApprovalRuntime({ db });

    assert.deepEqual(runtime.preferences(), {
      backgroundAnimationEnabled: false,
      notificationsEnabled: true,
      defaultApprovalMode: "request",
    });
    assert.equal(runtime.permission("task", "new-task"), "request");

    runtime.setPermission("coordinator", "global", "auto");
    assert.equal(runtime.preferences().defaultApprovalMode, "auto");

    assert.deepEqual(runtime.updatePreferences({
      backgroundAnimationEnabled: true,
      notificationsEnabled: false,
      defaultApprovalMode: "auto",
    }), {
      backgroundAnimationEnabled: true,
      notificationsEnabled: false,
      defaultApprovalMode: "auto",
    });
    assert.deepEqual(runtime.preferences(), {
      backgroundAnimationEnabled: true,
      notificationsEnabled: false,
      defaultApprovalMode: "auto",
    });
    assert.equal(runtime.permission("coordinator", "global"), "auto");
    assert.equal(runtime.permission("task", "new-task"), "auto");

    runtime.setPermission("task", "existing-task", "request");
    assert.equal(runtime.permission("task", "existing-task"), "request");
  } finally {
    db.close();
  }
});

test("global approval preference rejects an unknown mode", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const runtime = createApprovalRuntime({ db });
    assert.throws(
      () => runtime.updatePreferences({ defaultApprovalMode: "always" }),
      /未知 Agent 权限模式/,
    );
    assert.throws(
      () => runtime.updatePreferences({ notificationsEnabled: "false" }),
      /通知设置必须为布尔值/,
    );
    assert.throws(
      () => runtime.updatePreferences({ backgroundAnimationEnabled: "true" }),
      /背景动画设置必须为布尔值/,
    );
  } finally {
    db.close();
  }
});
