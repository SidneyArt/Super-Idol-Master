import type { JobType } from "./contracts";

export function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatMemory(value: number | null | undefined) {
  if (!Number.isFinite(value) || Number(value) <= 0) return null;
  return `${(Number(value) / (1024 ** 3)).toFixed(1)} GB`;
}

export function formatFileSize(value: number | null) {
  if (value === null) return "大小未知";
  if (!Number.isFinite(value) || value < 1) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(1)} MB`;
  return `${(value / (1024 ** 3)).toFixed(1)} GB`;
}

export function formatTokenCount(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  }
  return String(value);
}

export function jobName(type: JobType) {
  return {
    none: "本地流程",
    "2d": "2D 图片",
    qa: "SDPose",
    "3d": "Pixal3D",
    topology: "AutoRemesher",
    rig: "SkinTokens",
  }[type];
}
