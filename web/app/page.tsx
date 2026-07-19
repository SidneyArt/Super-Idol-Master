"use client";

import Image from "next/image";
import { FormEvent, useEffect, useMemo, useState } from "react";
import ModelViewer from "./components/ModelViewer";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8787";

const stages = [
  { short: "IDEA", title: "角色描述", subtitle: "定义人物与风格", input: "人物设定与提示词", output: "角色规格", action: "确认角色身份、服装、视角和背景。" },
  { short: "2D", title: "概念图生成", subtitle: "ComfyUI · Qwen Image", input: "角色规格", output: "PNG 概念图", action: "DGX 执行 Qwen Image 工作流并下载真实 PNG。" },
  { short: "QA", title: "T-Pose 检查", subtitle: "DGX · SDPose", input: "2D 概念图", output: "关键点、评分与判定", action: "SDPose 自动检查单人全身、双臂水平、肘部伸直和左右对称。" },
  { short: "3D", title: "3D 模型生成", subtitle: "ComfyUI · Pixal3D", input: "合格 T-Pose PNG", output: "静态 GLB", action: "DGX 执行 Pixal3D 工作流并下载真实静态 GLB。" },
  { short: "RIG", title: "自动绑骨", subtitle: "ComfyUI · SkinTokens", input: "静态 GLB", output: "带骨骼 GLB", action: "DGX 执行 SkinTokens，生成 Mixamo 骨骼与蒙皮。" },
  { short: "OUT", title: "资产导出", subtitle: "真实文件交付", input: "已绑骨 GLB", output: "最终 GLB 与任务日志", action: "下载网站后端实际保存的产物，不生成占位链接。" },
];

type JobType = "none" | "2d" | "qa" | "3d" | "rig";
type JobStatus = "idle" | "running" | "succeeded" | "failed";

type Assets = {
  imageReady: boolean;
  modelReady: boolean;
  riggedReady: boolean;
  imageDownloadUrl: string | null;
  modelDownloadUrl: string | null;
  riggedDownloadUrl: string | null;
};

type Run = {
  id: string;
  name: string;
  positivePrompt: string;
  negativePrompt: string;
  currentStage: number;
  status: "active" | "completed" | "failed";
  qaStatus: "pending" | "passed" | "failed";
  qaScore: number | null;
  qaSummary: string;
  qaMetrics: Record<string, number>;
  qaOverlayPath: string | null;
  jobType: JobType;
  jobStatus: JobStatus;
  jobMessage: string;
  jobProgress: number;
  jobPromptId: string | null;
  jobCurrentNode: string | null;
  previewPath: string | null;
  assets: Assets;
  createdAt: string;
  updatedAt: string;
};

type RunEvent = { id: number; eventType: string; stage: number; message: string; createdAt: string };
type RunDetail = { run: Run; events: RunEvent[] };
type WorkflowCheck = { ready: boolean; missing: string[] };
type SystemState = {
  api: boolean;
  database: boolean;
  comfyui: {
    online: boolean;
    pipelineReady: boolean;
    latencyMs: number;
    url: string;
    version?: string;
    queue: { running: number; pending: number };
    workflows: Partial<Record<"2d" | "qa" | "3d" | "rig", WorkflowCheck>>;
  };
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

function jobName(type: JobType) {
  return { none: "本地流程", "2d": "Qwen Image", qa: "SDPose", "3d": "Pixal3D", rig: "SkinTokens" }[type];
}

export default function Home() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [viewStage, setViewStage] = useState(0);
  const [system, setSystem] = useState<SystemState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: "",
    positivePrompt: "",
    negativePrompt: "低质量，肢体畸形，遮挡，裁切，多人",
  });

  async function refreshRuns(preferredId?: string) {
    const data = await api<{ runs: Run[] }>("/api/runs");
    setRuns(data.runs);
    const nextId = preferredId || selectedId || data.runs[0]?.id || null;
    setSelectedId(nextId);
    if (!nextId) setDetail(null);
  }

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      try {
        const [runData, systemData] = await Promise.all([
          api<{ runs: Run[] }>("/api/runs"),
          api<SystemState>("/api/system?force=1"),
        ]);
        if (cancelled) return;
        setRuns(runData.runs);
        setSelectedId(runData.runs[0]?.id || null);
        setSystem(systemData);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法连接本地后端");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void initialize();
    const timer = window.setInterval(() => {
      void api<SystemState>("/api/system").then(setSystem).catch(() => setSystem(null));
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void api<RunDetail>(`/api/runs/${selectedId}`)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        setViewStage(data.run.currentStage);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "任务读取失败");
      });
    return () => { cancelled = true; };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || detail?.run.jobStatus !== "running") return;
    const timer = window.setInterval(() => {
      void api<RunDetail>(`/api/runs/${selectedId}`)
        .then((data) => {
          setDetail(data);
          setViewStage(data.run.currentStage);
          return api<{ runs: Run[] }>("/api/runs");
        })
        .then((data) => setRuns(data.runs))
        .catch((reason) => setError(reason instanceof Error ? reason.message : "DGX 状态读取失败"));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [selectedId, detail?.run.jobStatus]);

  const run = detail?.run;
  const current = run?.currentStage ?? 0;
  const stage = stages[viewStage];
  const progress = useMemo(() => Math.round((current / (stages.length - 1)) * 100), [current]);
  const completedCount = runs.filter((item) => item.status === "completed").length;
  const isCurrentView = viewStage === current;
  const visiblePreview = viewStage < 3
    ? viewStage === 2 && run?.qaOverlayPath ? run.qaOverlayPath : run?.previewPath
    : null;
  const useRiggedPreview = viewStage >= 4 && run?.assets.riggedReady === true;
  const modelPreviewUrl = viewStage >= 3 && run?.assets.modelReady
    ? downloadUrl(useRiggedPreview ? run.assets.riggedDownloadUrl : run.assets.modelDownloadUrl)
    : null;
  const hasPreview = Boolean(visiblePreview || modelPreviewUrl);

  async function runAction(path: string, fallback: string) {
    if (!run || busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await api<RunDetail>(`/api/runs/${run.id}/${path}`, { method: "POST" });
      setDetail(data);
      setViewStage(data.run.currentStage);
      await refreshRuns(run.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  async function resetRun() {
    if (!run || busy || !window.confirm("重置会清除当前任务的产物引用和进度，确定继续吗？")) return;
    await runAction("reset", "重置失败");
  }

  async function deleteRun() {
    if (!run || !window.confirm(`确定删除“${run.name}”及其历史记录吗？`)) return;
    setBusy(true);
    try {
      await api(`/api/runs/${run.id}`, { method: "DELETE" });
      setSelectedId(null);
      setDetail(null);
      await refreshRuns();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function createRun(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api<RunDetail>("/api/runs", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setShowCreate(false);
      setForm({ name: "", positivePrompt: "", negativePrompt: "低质量，肢体畸形，遮挡，裁切，多人" });
      setDetail(data);
      setViewStage(0);
      await refreshRuns(data.run.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }

  function workflowReady(kind: "2d" | "qa" | "3d" | "rig") {
    return system?.comfyui.workflows?.[kind]?.ready === true;
  }

  function downloadUrl(value: string | null) {
    return value ? `${API_BASE}${value}` : "#";
  }

  return (
    <main className="site-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">SIM</span>
          <span><strong>SUPER IDOL MASTER</strong><small>DGX CHARACTER PIPELINE</small></span>
        </div>
        <div className="system-badges">
          <span className="system-badge online"><i /> API</span>
          <span className="system-badge online"><i /> SQLITE</span>
          <span className={`system-badge ${system?.comfyui.pipelineReady ? "online" : "offline"}`}>
            <i /> DGX {system?.comfyui.online ? `${system.comfyui.latencyMs}ms` : "OFFLINE"}
          </span>
        </div>
      </header>

      <section className="dashboard-head">
        <div>
          <span className="eyebrow">STRICT STATE MACHINE / REAL COMFYUI OUTPUTS</span>
          <h1>角色资产生产控制台</h1>
          <p>每个阶段只有在 DGX 返回真实成功和真实产物后才会解锁。</p>
        </div>
        <div className="summary-grid">
          <div><span>总任务</span><strong>{runs.length}</strong></div>
          <div><span>已完成</span><strong>{completedCount}</strong></div>
          <div><span>当前进度</span><strong>{progress}%</strong></div>
        </div>
      </section>

      {error && <div className="error-banner" role="alert"><span>!</span>{error}<button onClick={() => setError("")}>关闭</button></div>}

      <div className="app-layout">
        <aside className="run-sidebar">
          <div className="sidebar-head">
            <div><span>PROJECT RUNS</span><h2>角色任务</h2></div>
            <button className="new-button" onClick={() => setShowCreate(true)} aria-label="新建角色任务">＋</button>
          </div>
          <div className="run-list">
            {loading && <p className="empty-note">正在读取本地数据库…</p>}
            {!loading && runs.length === 0 && <p className="empty-note">还没有任务，点击右上角创建。</p>}
            {runs.map((item) => (
              <button key={item.id} className={`run-item ${item.id === selectedId ? "selected" : ""}`} onClick={() => setSelectedId(item.id)}>
                <span className="run-item-top"><i className={item.status} />{item.jobStatus === "running" ? `${jobName(item.jobType)} 执行中` : item.status === "completed" ? "已完成" : "进行中"}<time>{formatTime(item.updatedAt)}</time></span>
                <strong>{item.name}</strong>
                <span className="run-item-progress"><i style={{ width: `${Math.round((item.currentStage / 5) * 100)}%` }} /></span>
                <small>阶段 {item.currentStage + 1} / 6 · {stages[item.currentStage].title}</small>
              </button>
            ))}
          </div>
          <div className="db-note"><b>SQLite</b><span>data/super-idol-master.db</span></div>
        </aside>

        <section className="workspace">
          {!run ? (
            <div className="empty-workspace"><b>＋</b><h2>创建第一个角色任务</h2><p>关闭网站后，任务和真实产物引用仍会保留。</p><button className="primary-button" onClick={() => setShowCreate(true)}>新建任务</button></div>
          ) : (
            <>
              <div className="workspace-title">
                <div><span>ACTIVE RUN</span><h2>{run.name}</h2><p>更新于 {formatTime(run.updatedAt)}</p></div>
                <div className="workspace-actions"><button onClick={resetRun} disabled={busy || run.jobStatus === "running"}>重置</button><button className="danger" onClick={deleteRun} disabled={busy || run.jobStatus === "running"}>删除</button></div>
              </div>

              <div className="pipeline-checks" aria-label="DGX 工作流依赖检查">
                {(["2d", "qa", "3d", "rig"] as const).map((kind) => (
                  <span key={kind} className={workflowReady(kind) ? "ready" : "missing"}><i />{jobName(kind)} {workflowReady(kind) ? "READY" : "MISSING"}</span>
                ))}
                <b>QUEUE {system?.comfyui.queue?.running || 0} / {system?.comfyui.queue?.pending || 0}</b>
              </div>

              <div className="progress-track" aria-label={`真实流程进度 ${progress}%`}><span style={{ width: `${progress}%` }} /></div>
              <div className="stage-grid">
                {stages.map((item, index) => {
                  const state = index < current || (index === current && run.status === "completed") ? "done" : index === current ? "active" : "pending";
                  let stateLabel = state === "done" ? "已完成" : state === "active" ? "当前" : "锁定";
                  if (index === current && run.jobStatus === "running") stateLabel = `${jobName(run.jobType)} 中`;
                  if (index === 2 && index === current && run.qaStatus === "failed") stateLabel = "未通过";
                  if (index === 2 && index < current) stateLabel = `已通过 ${run.qaScore ?? "-"}分`;
                  return (
                    <button
                      key={item.short}
                      className={`stage-card ${state} ${viewStage === index ? "viewed" : ""} ${index === 2 ? `qa-${run.qaStatus}` : ""}`}
                      onClick={() => setViewStage(index)}
                      aria-current={index === current ? "step" : undefined}
                      title="仅查看阶段详情，不会改变任务状态"
                    >
                      <span className="stage-topline"><b>{String(index + 1).padStart(2, "0")}</b><i>{stateLabel}</i></span>
                      <span className="stage-code">{item.short}</span><strong>{item.title}</strong><small>{item.subtitle}</small>
                    </button>
                  );
                })}
              </div>

              <div className="detail-grid">
                <div className="preview-panel">
                  <div className="panel-label"><span>ASSET PREVIEW</span><b>{modelPreviewUrl ? useRiggedPreview ? "RIGGED GLB / INTERACTIVE" : "STATIC GLB / INTERACTIVE" : viewStage === 2 && run.qaOverlayPath ? "SDPOSE OVERLAY" : run.previewPath ? "LATEST PNG" : "NO ASSET"}</b></div>
                  <div className={`preview-frame ${modelPreviewUrl ? "model-preview" : ""} ${hasPreview ? "" : "placeholder"} ${run.jobStatus === "running" ? "generating" : ""}`}>
                    {modelPreviewUrl ? (
                      <ModelViewer src={modelPreviewUrl} label={`${run.name} · ${useRiggedPreview ? "绑骨 GLB" : "静态 GLB"}`} rigged={useRiggedPreview} />
                    ) : visiblePreview ? (
                      <Image src={visiblePreview} alt={`${run.name} 的角色预览`} width={1328} height={1328} priority unoptimized />
                    ) : (
                      <div><b>{stage.short}</b><span>等待本阶段真实产物</span></div>
                    )}
                    {visiblePreview && <span className="preview-tag">{viewStage === 2 && run.qaOverlayPath ? "SDPOSE / DGX" : "QWEN IMAGE / LOCAL COPY"}</span>}
                    {run.jobStatus === "running" && <div className="generation-overlay"><i /><strong>{jobName(run.jobType)} · {run.jobProgress}%</strong><span>{run.jobMessage || "等待 ComfyUI 实时事件"}</span></div>}
                  </div>
                  <div className="asset-stack">
                    <span className={run.assets.imageReady ? "ready" : "waiting"}>PNG {run.assets.imageReady ? "READY" : "WAIT"}</span>
                    <span className={run.assets.modelReady ? "ready" : "waiting"}>STATIC GLB {run.assets.modelReady ? "READY" : "WAIT"}</span>
                    <span className={run.assets.riggedReady ? "ready" : "waiting"}>RIGGED GLB {run.assets.riggedReady ? "READY" : "WAIT"}</span>
                  </div>
                </div>

                <article className="stage-detail">
                  <div className="detail-kicker"><span>STAGE {String(viewStage + 1).padStart(2, "0")}</span><b>{stage.short}</b></div>
                  <h2>{stage.title}</h2>
                  <p className="detail-lead">{stage.action}</p>
                  <dl className="io-grid"><div><dt>输入</dt><dd>{stage.input}</dd></div><div><dt>输出</dt><dd>{stage.output}</dd></div></dl>

                  {!isCurrentView && viewStage < current && <div className="action-note passed"><span>真实阶段已完成</span><p>该阶段由后端任务成功和产物存在性共同确认。点击阶段卡片不会改变流程状态。</p></div>}
                  {!isCurrentView && viewStage > current && <div className="action-note warning"><span>阶段尚未解锁</span><p>必须先完成“{stages[current].title}”的真实 DGX 任务，不能手动跳过。</p></div>}
                  {isCurrentView && run.jobStatus === "running" && <div className="action-note generation-running"><span>{jobName(run.jobType)} 正在 DGX 执行</span><p>{run.jobMessage}</p></div>}
                  {isCurrentView && run.jobStatus === "failed" && <div className="action-note failed"><span>{jobName(run.jobType)} 执行失败</span><p>{run.jobMessage}</p></div>}

                  {viewStage === 2 && run.qaScore !== null && <div className={`qa-score ${run.qaStatus}`}>
                    <strong>{run.qaScore}</strong><span>/ 100</span><p>{run.qaSummary}</p>
                  </div>}
                  {viewStage === 2 && Object.keys(run.qaMetrics || {}).length > 0 && <div className="metric-grid">
                    <div><span>最小置信度</span><strong>{Math.round((run.qaMetrics.minConfidence || 0) * 100)}%</strong></div>
                    <div><span>水平误差</span><strong>{Math.round((run.qaMetrics.armHorizontalError || 0) * 100)}%</strong></div>
                    <div><span>左肘角度</span><strong>{run.qaMetrics.leftElbowAngle || 0}°</strong></div>
                    <div><span>右肘角度</span><strong>{run.qaMetrics.rightElbowAngle || 0}°</strong></div>
                  </div>}

                  {run.jobStatus === "running" && <div className="live-progress" aria-label={`ComfyUI 实时进度 ${run.jobProgress}%`}>
                    <div className="live-progress-head"><span>COMFYUI REAL EVENT PROGRESS</span><strong>{run.jobProgress}%</strong></div>
                    <div className="live-progress-track"><i style={{ width: `${run.jobProgress}%` }} /></div>
                    <div className="live-progress-meta"><span>Prompt: {run.jobPromptId ? run.jobPromptId.slice(0, 16) : "等待提交"}</span><span>Node: {run.jobCurrentNode || "等待执行"}</span></div>
                  </div>}

                  <div className="prompt-box"><span>正向提示词</span><p>{run.positivePrompt || "尚未填写"}</p></div>
                  <div className="detail-actions">
                    {isCurrentView && current === 0 && <button className="primary-button" onClick={() => runAction("start", "进入 2D 阶段失败")} disabled={busy}>确认设定，进入 2D →</button>}
                    {isCurrentView && current === 1 && <button className="generate-button" onClick={() => runAction("generate-2d", "2D 任务提交失败")} disabled={busy || run.jobStatus === "running"}>{run.previewPath ? "重新生成 Qwen 2D ↻" : "开始 Qwen 2D →"}</button>}
                    {isCurrentView && current === 2 && run.qaStatus === "failed" && <button className="regenerate-button" onClick={() => runAction("generate-2d", "重新生成失败")} disabled={busy || run.jobStatus === "running"}>QA 未通过，重新生成 2D ↻</button>}
                    {isCurrentView && current === 2 && run.jobStatus !== "running" && <button className="secondary-button" onClick={() => runAction("check-tpose", "自动检查启动失败")} disabled={busy}>重新运行 SDPose 检查</button>}
                    {isCurrentView && current === 3 && <button className="primary-button" onClick={() => runAction("generate-3d", "3D 任务提交失败")} disabled={busy || run.jobStatus === "running"}>生成真实静态 GLB →</button>}
                    {isCurrentView && current === 4 && <button className="primary-button" onClick={() => runAction("rig", "绑骨任务提交失败")} disabled={busy || run.jobStatus === "running"}>运行 SkinTokens 绑骨 →</button>}
                    {viewStage === 1 && run.assets.imageReady && <a className="download-button" href={downloadUrl(run.assets.imageDownloadUrl)}>下载 PNG</a>}
                    {viewStage >= 3 && run.assets.modelReady && <a className="download-button" href={downloadUrl(run.assets.modelDownloadUrl)}>下载静态 GLB</a>}
                    {viewStage === 5 && run.assets.riggedReady && <a className="download-button primary" href={downloadUrl(run.assets.riggedDownloadUrl)}>下载最终绑骨 GLB</a>}
                  </div>
                </article>
              </div>

              <section className="event-section">
                <div className="panel-label"><span>DATABASE EVENTS</span><b>{detail.events.length} 条真实记录</b></div>
                <div className="event-list">
                  {detail.events.map((item) => <div className="event-item" key={item.id}><i /><div><strong>{item.message}</strong><span>{stages[item.stage]?.title || "流程"}</span></div><time>{formatTime(item.createdAt)}</time></div>)}
                </div>
              </section>
            </>
          )}
        </section>
      </div>

      {showCreate && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCreate(false); }}>
          <form className="create-modal" onSubmit={createRun}>
            <div className="modal-head"><div><span>NEW CHARACTER RUN</span><h2>新建角色任务</h2></div><button type="button" onClick={() => setShowCreate(false)} aria-label="关闭">×</button></div>
            <label>任务名称<input autoFocus required maxLength={80} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：未来城市女飞行员" /></label>
            <label>正向提示词<textarea rows={5} maxLength={4000} value={form.positivePrompt} onChange={(event) => setForm({ ...form, positivePrompt: event.target.value })} placeholder="描述人物、服装、风格，并明确正视、全身、严格 T-Pose、纯色背景…" /></label>
            <label>负向提示词<textarea rows={3} maxLength={2000} value={form.negativePrompt} onChange={(event) => setForm({ ...form, negativePrompt: event.target.value })} /></label>
            <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setShowCreate(false)}>取消</button><button className="primary-button" disabled={busy}>{busy ? "创建中…" : "创建并保存"}</button></div>
          </form>
        </div>
      )}
    </main>
  );
}
