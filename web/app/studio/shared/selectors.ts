import type {
  ApprovalRequest,
  Assets,
  ChatMessage,
  DispatcherGeneration,
  DispatcherTaskBatch,
  Run,
  WorkspaceAsset,
  WorkspaceAssetKind,
} from "./contracts";

export type DispatcherTimelineItem =
  | { kind: "message"; createdAt: string; item: ChatMessage }
  | { kind: "generation"; createdAt: string; item: DispatcherGeneration }
  | { kind: "taskBatch"; createdAt: string; item: DispatcherTaskBatch }
  | { kind: "approval"; createdAt: string; item: ApprovalRequest };

function timelineTime(createdAt: string) {
  const timestamp = Date.parse(createdAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compareTimelineItems(
  left: DispatcherTimelineItem,
  right: DispatcherTimelineItem,
) {
  const timeDifference = timelineTime(left.createdAt) - timelineTime(right.createdAt);
  if (timeDifference) return timeDifference;

  const rank = (entry: DispatcherTimelineItem) => entry.kind === "message"
    ? entry.item.role === "user" ? 0 : 3
    : entry.kind === "generation" ? 1
      : entry.kind === "taskBatch" ? 2
        : 3;
  return rank(left) - rank(right)
    || String(left.item.id).localeCompare(
      String(right.item.id),
      undefined,
      { numeric: true },
    );
}

export function buildDispatcherTimeline(
  messages: ChatMessage[],
  generations: DispatcherGeneration[],
  approvalRequests: ApprovalRequest[],
  taskBatches: DispatcherTaskBatch[],
): DispatcherTimelineItem[] {
  const sortedMessages = [...messages].sort((left, right) => {
    const difference = timelineTime(left.createdAt) - timelineTime(right.createdAt);
    if (difference) return difference;
    if (left.role !== right.role) return left.role === "user" ? -1 : 1;
    return left.id - right.id;
  });
  const approvalsByAssistant = new Map<number, ApprovalRequest[]>();
  const batchesByAssistant = new Map<number, DispatcherTaskBatch[]>();
  const generationsByAssistant = new Map<number, DispatcherGeneration[]>();
  const unanchoredApprovals: ApprovalRequest[] = [];
  const unanchoredBatches: DispatcherTaskBatch[] = [];
  const unanchoredGenerations: DispatcherGeneration[] = [];

  const followingAssistant = (createdAt: string) => {
    const itemTime = timelineTime(createdAt);
    return sortedMessages.find((message) => {
      if (
        message.role !== "assistant"
        || timelineTime(message.createdAt) < itemTime
      ) return false;
      const assistantTime = timelineTime(message.createdAt);
      return !sortedMessages.some((candidate) => (
        candidate.role === "user"
        && timelineTime(candidate.createdAt) > itemTime
        && timelineTime(candidate.createdAt) <= assistantTime
      ));
    });
  };

  function anchor<T extends { createdAt: string }>(
    items: T[],
    anchored: Map<number, T[]>,
    unanchored: T[],
    tieBreaker?: (left: T, right: T) => number,
  ) {
    [...items]
      .sort((left, right) => (
        timelineTime(left.createdAt) - timelineTime(right.createdAt)
        || tieBreaker?.(left, right)
        || 0
      ))
      .forEach((item) => {
        const assistant = followingAssistant(item.createdAt);
        if (!assistant) {
          unanchored.push(item);
          return;
        }
        const group = anchored.get(assistant.id) || [];
        group.push(item);
        anchored.set(assistant.id, group);
      });
  }

  anchor(
    approvalRequests,
    approvalsByAssistant,
    unanchoredApprovals,
    (left, right) => left.id - right.id,
  );
  anchor(taskBatches, batchesByAssistant, unanchoredBatches);
  anchor(generations, generationsByAssistant, unanchoredGenerations);

  const base: DispatcherTimelineItem[] = [
    ...messages.map((item) => ({
      kind: "message" as const,
      createdAt: item.createdAt,
      item,
    })),
    ...unanchoredGenerations.map((item) => ({
      kind: "generation" as const,
      createdAt: item.createdAt,
      item,
    })),
    ...unanchoredBatches.map((item) => ({
      kind: "taskBatch" as const,
      createdAt: item.createdAt,
      item,
    })),
    ...unanchoredApprovals.map((item) => ({
      kind: "approval" as const,
      createdAt: item.createdAt,
      item,
    })),
  ].sort(compareTimelineItems);

  return base.flatMap((entry) => {
    if (entry.kind !== "message" || entry.item.role !== "assistant") return [entry];
    return [
      entry,
      ...(approvalsByAssistant.get(entry.item.id) || []).map((item) => ({
        kind: "approval" as const,
        createdAt: item.createdAt,
        item,
      })),
      ...(batchesByAssistant.get(entry.item.id) || []).map((item) => ({
        kind: "taskBatch" as const,
        createdAt: item.createdAt,
        item,
      })),
      ...(generationsByAssistant.get(entry.item.id) || []).map((item) => ({
        kind: "generation" as const,
        createdAt: item.createdAt,
        item,
      })),
    ];
  });
}

export function preferredHomeWorkspaceId(
  items: Array<{ id: string; taskCount: number }>,
) {
  return [...items]
    .filter((item) => item.id !== "default")
    .sort((first, second) => second.taskCount - first.taskCount)[0]?.id
    || items.find((item) => item.id === "default")?.id
    || items[0]?.id
    || "default";
}

export function workspaceAssetsFromRuns(
  items: Array<Pick<Run, "id" | "workspaceId" | "name" | "updatedAt" | "previewPath" | "assets">>,
  workspaceId: string,
): WorkspaceAsset[] {
  const definitions: Array<{
    kind: WorkspaceAssetKind;
    label: string;
    ready: keyof Pick<Assets, "imageReady" | "modelReady" | "topologyReady" | "riggedReady">;
    download: keyof Pick<Assets, "imageDownloadUrl" | "modelDownloadUrl" | "topologyDownloadUrl" | "riggedDownloadUrl">;
    rigged: boolean;
  }> = [
    { kind: "image", label: "2D 概念图", ready: "imageReady", download: "imageDownloadUrl", rigged: false },
    { kind: "model", label: "静态 GLB", ready: "modelReady", download: "modelDownloadUrl", rigged: false },
    { kind: "topology", label: "拓扑 GLB", ready: "topologyReady", download: "topologyDownloadUrl", rigged: false },
    { kind: "rigged", label: "绑定 GLB", ready: "riggedReady", download: "riggedDownloadUrl", rigged: true },
  ];
  return items
    .filter((run) => run.workspaceId === workspaceId)
    .flatMap((run) => definitions.flatMap((definition) => {
      const downloadUrl = run.assets[definition.download];
      if (!run.assets[definition.ready] || !downloadUrl) return [];
      const group = definition.kind === "image" ? "2d" : "3d";
      return [{
        id: `${run.id}:${definition.kind}`,
        workspaceId,
        runId: run.id,
        runName: run.name,
        kind: definition.kind,
        group,
        label: definition.label,
        downloadUrl,
        previewUrl: definition.kind === "image" && run.previewPath
          ? run.previewPath
          : downloadUrl,
        filename: `${run.name}.${definition.kind === "image" ? "png" : "glb"}`,
        size: null,
        createdAt: run.updatedAt,
        rigged: definition.rigged,
      }];
    }));
}

export type RunPreview = {
  kind: "source" | "image" | "qa" | "model" | "topology" | "rigged" | "empty";
  label: string;
  url: string | null;
};

export function selectRunPreview(
  run: Pick<Run, "previewPath" | "qaOverlayPath" | "assets"> | null,
  stage: number,
): RunPreview {
  if (!run) return { kind: "empty", label: "等待资产", url: null };
  if (stage >= 5 && run.assets.riggedReady && run.assets.riggedDownloadUrl) {
    return { kind: "rigged", label: "绑骨 GLB", url: run.assets.riggedDownloadUrl };
  }
  if (stage >= 4 && run.assets.topologyReady && run.assets.topologyDownloadUrl) {
    return { kind: "topology", label: "拓扑 GLB", url: run.assets.topologyDownloadUrl };
  }
  if (stage >= 3 && run.assets.modelReady && run.assets.modelDownloadUrl) {
    return { kind: "model", label: "静态 GLB", url: run.assets.modelDownloadUrl };
  }
  if (stage === 2 && run.qaOverlayPath) {
    return { kind: "qa", label: "SDPose 覆盖图", url: run.qaOverlayPath };
  }
  if (run.previewPath) {
    return { kind: "image", label: "2D 概念图", url: run.previewPath };
  }
  if (run.assets.sourceImageReady && run.assets.sourceImageDownloadUrl) {
    return { kind: "source", label: "角色输入", url: run.assets.sourceImageDownloadUrl };
  }
  return { kind: "empty", label: "等待资产", url: null };
}
