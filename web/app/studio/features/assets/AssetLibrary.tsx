"use client";

import Image from "next/image";
import { Box, Download, Library, LoaderCircle, Trash2, X } from "lucide-react";
import { lazy, Suspense, type Dispatch, type SetStateAction } from "react";

import { API_BASE } from "../../shared/api-client";
import type { Workspace, WorkspaceAsset, WorkspaceAssetFilter } from "../../shared/contracts";
import { formatFileSize } from "../../shared/formatters";
import { ClientTime } from "../../shared/ui";

const ModelViewer = lazy(() => import("../../../components/ModelViewer"));

export function AssetLibrary({ workspace, assets, filter, selectedAsset, loading, confirmationOpen, close, setFilter, selectAsset, openTask, downloadUrl, previewUrl, requestDelete }: {
  workspace: Workspace | null;
  assets: WorkspaceAsset[];
  filter: WorkspaceAssetFilter;
  selectedAsset: WorkspaceAsset | null;
  loading: boolean;
  confirmationOpen: boolean;
  close: () => void;
  setFilter: Dispatch<SetStateAction<WorkspaceAssetFilter>>;
  selectAsset: Dispatch<SetStateAction<string | null>>;
  openTask: (runId: string) => void;
  downloadUrl: (value: string | null) => string;
  previewUrl: (value: string) => string;
  requestDelete: (asset: WorkspaceAsset) => void;
}) {
  const filtered = assets.filter((asset) => filter === "all" ? true : filter === "2d" || filter === "3d" ? asset.group === filter : asset.kind === filter);
  const filters: Array<[WorkspaceAssetFilter, string]> = [["all", "全部"], ["2d", "2D 图片"], ["3d", "全部 3D"], ["model", "静态模型"], ["topology", "拓扑模型"], ["rigged", "绑定模型"]];
  return <div className="modal-backdrop asset-library-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !confirmationOpen) close(); }}><section className="asset-library-modal" role="dialog" aria-modal="true" aria-labelledby="asset-library-title"><header className="asset-library-header"><div><span>WORKSPACE ASSETS</span><h2 id="asset-library-title">{workspace?.name || "工作空间"} · 资产库</h2><p>集中预览和管理当前工作空间内各任务生成的 2D 与 3D 资产。</p></div><button className="icon-button" type="button" onClick={close} aria-label="关闭资产库"><X size={19} /></button></header><div className="asset-library-body"><aside className="asset-library-browser"><nav className="asset-library-filters" aria-label="资产类型筛选">{filters.map(([value, label]) => { const count = value === "all" ? assets.length : assets.filter((asset) => value === "2d" || value === "3d" ? asset.group === value : asset.kind === value).length; return <button type="button" key={value} className={filter === value ? "active" : ""} onClick={() => { setFilter(value); selectAsset(null); }}><span>{label}</span><em>{count}</em></button>; })}</nav><div className="asset-library-list" aria-label="资产列表">{loading && <div className="asset-library-empty"><LoaderCircle className="spinning" size={22} /><span>正在读取资产…</span></div>}{!loading && filtered.map((asset) => <button type="button" className={`asset-library-card ${selectedAsset?.id === asset.id ? "selected" : ""}`} key={asset.id} onClick={() => selectAsset(asset.id)}><span className={`asset-library-thumb ${asset.group}`}>{asset.group === "2d" ? <Image src={previewUrl(asset.previewUrl)} alt={asset.runName} width={160} height={100} unoptimized /> : <Box size={24} />}<small>{asset.kind === "image" ? "PNG" : "GLB"}</small></span><span className="asset-library-card-copy"><strong>{asset.runName}</strong><small>{asset.label} · {formatFileSize(asset.size)}</small><ClientTime value={asset.createdAt} /></span></button>)}{!loading && !filtered.length && <div className="asset-library-empty"><Library size={24} /><strong>暂无此类资产</strong><span>完成对应生成阶段后，资产会自动出现在这里。</span></div>}</div></aside><div className="asset-library-detail">{selectedAsset ? <><header className="asset-library-detail-header"><div><span>{selectedAsset.label}</span><h3>{selectedAsset.runName}</h3><p>{selectedAsset.filename} · {formatFileSize(selectedAsset.size)}{selectedAsset.size === null ? " · 重启本地服务后可管理删除" : ""}</p></div><div><button className="secondary-button" type="button" onClick={() => openTask(selectedAsset.runId)}>打开任务</button><a className="secondary-button" href={downloadUrl(selectedAsset.downloadUrl)} download><Download size={15} />下载</a><button className="danger-button" type="button" disabled={selectedAsset.size === null} title={selectedAsset.size === null ? "后端尚未重启，当前仅支持预览和下载" : "删除资产"} onClick={() => requestDelete(selectedAsset)}><Trash2 size={15} />删除</button></div></header><div className={`asset-library-preview-frame preview-frame ${selectedAsset.group === "3d" ? "model-preview" : ""}`}>{selectedAsset.group === "2d" ? <Image className="asset-preview-image" src={previewUrl(selectedAsset.previewUrl)} alt={`${selectedAsset.runName} ${selectedAsset.label}`} width={1600} height={1600} unoptimized /> : <Suspense fallback={<div className="model-loading"><LoaderCircle className="spinning" size={24} /><span>正在加载 3D 资产…</span></div>}><ModelViewer src={previewUrl(selectedAsset.previewUrl)} label={`${selectedAsset.runName} ${selectedAsset.label}`} rigged={selectedAsset.rigged} animationApiBase={API_BASE} /></Suspense>}</div></> : <div className="asset-library-detail-empty"><Library size={32} /><h3>选择一个资产进行预览</h3><p>2D 图片和 3D 模型会使用任务生成页相同的预览方式。</p></div>}</div></div></section></div>;
}
