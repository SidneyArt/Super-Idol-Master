"use client";

import StudioApplication from "./studio/StudioApplication";
import type { Run, Workspace } from "./studio/shared/contracts";

export type { Run, Workspace } from "./studio/shared/contracts";

export type StudioProps = {
  initialRunId: string | null;
  initialWorkspaceId: string | null;
  initialNotificationId: number | null;
  initialRuns: Run[];
  initialWorkspaces: Workspace[];
};

export default function Studio(props: StudioProps) {
  return <StudioApplication {...props} />;
}
