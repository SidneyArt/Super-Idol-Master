import Studio, { type Run, type Workspace } from "./Studio";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8787";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;
  const taskParam = params.task;
  const initialRunId = Array.isArray(taskParam) ? taskParam[0] : taskParam;
  const workspaceParam = params.workspace;
  const initialWorkspaceId = Array.isArray(workspaceParam) ? workspaceParam[0] : workspaceParam;
  const notificationParam = params.notification;
  const notificationValue = Array.isArray(notificationParam) ? notificationParam[0] : notificationParam;
  const initialNotificationId = notificationValue && Number.isInteger(Number(notificationValue))
    ? Number(notificationValue)
    : null;
  let initialRuns: Run[] = [];
  let initialWorkspaces: Workspace[] = [];

  try {
    const [runsResponse, workspacesResponse] = await Promise.all([
      fetch(`${API_BASE}/api/runs`, { cache: "no-store" }),
      fetch(`${API_BASE}/api/workspaces`, { cache: "no-store" }),
    ]);
    if (runsResponse.ok) initialRuns = (await runsResponse.json() as { runs: Run[] }).runs;
    if (workspacesResponse.ok) initialWorkspaces = (await workspacesResponse.json() as { workspaces: Workspace[] }).workspaces;
  } catch {
    // The client performs the same requests and shows the normal connection error if the backend is unavailable.
  }

  // Drop any task ID that is no longer in the run list (e.g.: a deleted task
  // revisited via a stale URL).  Passing null here lets the Studio component
  // land on the home screen instead of a "任务不存在" stub.
  if (initialRunId && !initialRuns.find((run) => run.id === initialRunId)) {
    return (
      <Studio
        initialRunId={null}
        initialWorkspaceId={initialWorkspaceId || null}
        initialNotificationId={initialNotificationId}
        initialRuns={initialRuns}
        initialWorkspaces={initialWorkspaces}
      />
    );
  }

  return (
    <Studio
      initialRunId={initialRunId || null}
      initialWorkspaceId={initialWorkspaceId || null}
      initialNotificationId={initialNotificationId}
      initialRuns={initialRuns}
      initialWorkspaces={initialWorkspaces}
    />
  );
}
