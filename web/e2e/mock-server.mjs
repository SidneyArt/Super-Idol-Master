import { createServer } from "node:http";

import {
  approval,
  conversation,
  notification,
  run,
  settings,
  system,
  workspaces,
} from "./mock-data.mjs";

const heldAgentResponses = new Set();
const port = Number(process.env.STUDIO_MOCK_API_PORT || 8787);

function json(response, value, status = 200) {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") return json(response, {});
  const url = new URL(request.url, "http://127.0.0.1:8787");
  const path = url.pathname;

  if (path === "/api/runs") return json(response, { runs: [run] });
  if (path === "/api/workspaces") return json(response, request.method === "POST" ? workspaces[1] : { workspaces });
  if (path === "/api/settings") return json(response, settings);
  if (path === "/api/ui-preferences") {
    const preferences = request.method === "PUT"
      ? await body(request)
      : {
          backgroundAnimationEnabled: false,
          notificationsEnabled: true,
          defaultApprovalMode: "request",
        };
    return json(response, preferences);
  }
  if (path === "/api/system") return json(response, system);
  if (path === "/api/notifications") {
    return json(response, request.method === "DELETE" ? {} : { notifications: [notification] });
  }
  if (/^\/api\/notifications\/\d+\/read$/.test(path)) return json(response, {});
  if (/^\/api\/notifications\/\d+$/.test(path)) return json(response, {});
  if (path === "/api/notifications/read-all") {
    return json(response, { readAt: "2026-07-30T10:00:00.000Z" });
  }
  if (path === "/api/agent-controls") {
    return json(response, request.method === "PUT" ? {} : {
      coordinatorMode: "request",
      taskMode: "request",
      approvals: [approval],
    });
  }
  if (/^\/api\/approvals\/\d+\/(approve|reject)$/.test(path)) return json(response, {});
  if (path === "/api/dispatcher/generations") return json(response, { generations: [] });
  if (path === "/api/dispatcher/task-batches") return json(response, { batches: [] });
  if (path === "/api/dispatcher/messages") {
    if (request.method === "POST") {
      return json(response, { ...conversation(), workspaces });
    }
    return json(response, conversation());
  }
  if (path === "/api/dispatcher/sessions/current") {
    const payload = await body(request);
    return json(response, conversation(payload.sessionId));
  }
  if (path === "/api/dispatcher/sessions") return json(response, conversation("session-b"));
  if (path === "/api/dispatcher/cancel") return json(response, {});
  if (path === "/api/runs/run-1") {
    return json(response, {
      run,
      events: [{
        id: 1,
        eventType: "stage",
        stage: 2,
        message: "姿态质量检查完成",
        createdAt: "2026-07-30T09:00:00.000Z",
      }],
      agentRoleRuns: [],
      agentWorkflowPlan: null,
    });
  }
  if (path === "/api/runs/run-1/agent/messages") {
    if (request.method === "POST") {
      const payload = await body(request);
      if (payload.message?.includes("保持请求")) {
        heldAgentResponses.add(response);
        response.on("close", () => heldAgentResponses.delete(response));
        return;
      }
      return json(response, {
        ...conversation(),
        detail: { run, events: [], agentRoleRuns: [], agentWorkflowPlan: null },
      });
    }
    return json(response, conversation());
  }
  if (path === "/api/runs/run-1/agent/cancel") {
    json(response, {});
    for (const held of heldAgentResponses) {
      json(held, {
        ...conversation(),
        detail: { run, events: [], agentRoleRuns: [], agentWorkflowPlan: null },
      });
    }
    heldAgentResponses.clear();
    return;
  }
  if (path === "/api/runs/run-1/agent/sessions/current") {
    const payload = await body(request);
    return json(response, conversation(payload.sessionId));
  }
  if (path === "/api/runs/run-1/agent/sessions") return json(response, conversation("session-b"));
  if (/^\/api\/runs\/run-1\/agent\/sessions\//.test(path)) return json(response, conversation());

  return json(response, { error: `Unhandled mock endpoint: ${request.method} ${path}` }, 404);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Studio mock API listening on http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
