import Studio, { type Run, type Workspace } from "./Studio";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8787";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;
  const taskParam = params.task;
  const initialRunId = Array.isArray(taskParam) ? taskParam[0] : taskParam;
  let initialRuns: Run[] = [];
  let initialWorkspaces: Workspace[] = [];

  if (initialRunId) {
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
  }

  return (
    <Studio
      initialRunId={initialRunId || null}
      initialRuns={initialRuns}
      initialWorkspaces={initialWorkspaces}
    />
  );
}
