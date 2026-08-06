"use client";

import { ChevronDown, ChevronRight, Cpu, Database, FileJson, FolderOpen, LoaderCircle, RefreshCw, RotateCcw, Save, Server, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import type { FormEvent } from "react";

import type { AgentApiDraft, ImageModelDraft, SettingsController, SettingsDraft, TopologyApiDraft } from "./useSettingsState";
import { PROCESS_KINDS } from "./useSettingsState";
import type { ProcessKind, ReasoningEffort, SystemState } from "../../shared/contracts";
import { jobName } from "../../shared/formatters";
import { StyledSelect } from "../../shared/ui";

export function SettingsDialog({ controller, system, dgxDeviceName, dgxMemoryFree, dgxMemoryTotal, saveSettings, refreshSystemStatus, restoreTopologyDefaults, updateTopologySettings, restoreProcessDefaults, updateProcessSettings, selectWorkflow, removeWorkflow, handleWorkflowFiles, chooseWorkflowDirectory, updateAgentApiSettings, fetchAgentModels, updateImageModelSettings }: {
  controller: SettingsController;
  system: SystemState | null;
  dgxDeviceName: string | undefined;
  dgxMemoryFree: string | null;
  dgxMemoryTotal: string | null;
  saveSettings: (event: FormEvent) => Promise<void>;
  refreshSystemStatus: () => Promise<void>;
  restoreTopologyDefaults: () => void;
  updateTopologySettings: (patch: Partial<TopologyApiDraft>) => void;
  restoreProcessDefaults: (kind: ProcessKind) => void;
  updateProcessSettings: (kind: ProcessKind, patch: Partial<SettingsDraft["processes"][ProcessKind]>) => void;
  selectWorkflow: (kind: ProcessKind, workflowId: string) => Promise<void>;
  removeWorkflow: (kind: ProcessKind, workflowId: string) => void;
  handleWorkflowFiles: (kind: ProcessKind, files: FileList | File[]) => void;
  chooseWorkflowDirectory: () => void;
  updateAgentApiSettings: (scope: "agent" | "coordinator", patch: Partial<AgentApiDraft>) => void;
  fetchAgentModels: (scope?: "agent" | "coordinator") => Promise<void>;
  updateImageModelSettings: (scope: "agent" | "coordinator", key: "textToImage" | "imageToImage", patch: Partial<ImageModelDraft>) => void;
}) {
  const { showSettings: _showSettings, setShowSettings, settings, settingsForm, settingsTab, setSettingsTab, settingsLoading, settingsSaving, systemRefreshing, agentModelsLoading, agentModels, setAgentModels, coordinatorModels, setCoordinatorModels, workflowPreviewOpen, setWorkflowPreviewOpen, workflowDragging, setWorkflowDragging, workflowFileRef, workflowDirectoryRef } = controller;
  void _showSettings;
  const dgxDevice = dgxDeviceName ? { name: dgxDeviceName } : null;
  return (
        <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSettings(false); }}>
          <form className="settings-panel" onSubmit={saveSettings} aria-label="模型配置">
            <div className="settings-header">
              <div><span>Model & Service Configuration</span><h2>模型配置</h2></div>
              <button className="icon-button" type="button" onClick={() => setShowSettings(false)} aria-label="关闭设置面板"><X size={19} /></button>
            </div>

            {settingsLoading || !settingsForm || !settings ? (
              <div className="settings-loading"><LoaderCircle size={20} /><span>正在读取配置</span></div>
            ) : (
              <>
                <div className="settings-tabs" role="tablist" aria-label="配置分类">
                  <button type="button" role="tab" aria-selected={settingsTab === "status"} className={settingsTab === "status" ? "active" : ""} onClick={() => { setSettingsTab("status"); setWorkflowPreviewOpen(false); }}>服务状态</button>
                  {PROCESS_KINDS.map((kind) => (
                    <button key={kind} type="button" role="tab" aria-selected={settingsTab === kind} className={settingsTab === kind ? "active" : ""} onClick={() => { setSettingsTab(kind); setWorkflowPreviewOpen(false); }}>
                      {kind === "qa" ? "QA" : kind.toUpperCase()}
                    </button>
                  ))}
                  <button type="button" role="tab" aria-selected={settingsTab === "topology"} className={settingsTab === "topology" ? "active" : ""} onClick={() => { setSettingsTab("topology"); setWorkflowPreviewOpen(false); }}>拓扑 API</button>
                  <button type="button" role="tab" aria-selected={settingsTab === "agent"} className={settingsTab === "agent" ? "active" : ""} onClick={() => { setSettingsTab("agent"); setWorkflowPreviewOpen(false); }}>任务 Agent</button>
                  <button type="button" role="tab" aria-selected={settingsTab === "coordinator"} className={settingsTab === "coordinator" ? "active" : ""} onClick={() => { setSettingsTab("coordinator"); setWorkflowPreviewOpen(false); }}>总调度 Agent</button>
                </div>

                <div className="settings-content">
                  {settingsTab === "status" ? (
                    <section className="connection-settings" aria-label="服务联通状态">
                      <div className="settings-section-heading">
                        <div><span>Connectivity</span><h3>服务联通状态</h3></div>
                        <button className="text-icon-button" type="button" onClick={() => void refreshSystemStatus()} disabled={systemRefreshing}>
                          <RefreshCw className={systemRefreshing ? "spinning" : ""} size={15} />{systemRefreshing ? "检测中" : "重新检测"}
                        </button>
                      </div>
                      <p className="connection-settings-intro">模型、工作流和外部服务的联通检测集中显示在这里，不再占用主界面空间。</p>

                      <div className="connection-summary-grid">
                        <article className="connection-summary-card">
                          <header>
                            <span><Server size={18} /></span>
                            <div><strong>本地服务</strong><small>Web API 与数据存储</small></div>
                          </header>
                          <div className="connection-summary-rows">
                            <div><span>本地 API</span><em className={system?.api ? "ready" : "missing"}><i />{system?.api ? "正常" : "不可用"}</em></div>
                            <div><span>SQLite</span><em className={system?.database ? "ready" : "missing"}><i />{system?.database ? "正常" : "不可用"}</em></div>
                          </div>
                        </article>

                        <article className="connection-summary-card">
                          <header>
                            <span><Cpu size={18} /></span>
                            <div><strong>DGX / ComfyUI</strong><small>{system?.comfyui.url || "尚未读取服务地址"}</small></div>
                          </header>
                          <div className="connection-summary-rows">
                            <div><span>联通状态</span><em className={system?.comfyui.online ? "ready" : "missing"}><i />{system?.comfyui.online ? `${system.comfyui.latencyMs} ms` : "离线"}</em></div>
                            <div><span>工作流</span><em className={system?.comfyui.pipelineReady ? "ready" : "missing"}><i />{system?.comfyui.pipelineReady ? "全部就绪" : "存在缺失"}</em></div>
                            <div><span>设备</span><b>{dgxDevice?.name || "未检测到 GPU"}</b></div>
                            <div><span>显存/统一内存</span><b>{dgxMemoryTotal ? `${dgxMemoryFree || "-"} / ${dgxMemoryTotal} 可用` : "暂无数据"}</b></div>
                            <div><span>任务队列</span><b>{system?.comfyui.queue?.running || 0} 运行 / {system?.comfyui.queue?.pending || 0} 等待</b></div>
                          </div>
                        </article>
                      </div>

                      <div className="connection-service-heading">
                        <div><Database size={17} /><span><strong>工作流与外部服务</strong><small>检测请求地址、节点依赖和服务就绪状态</small></span></div>
                      </div>
                      <div className="connection-service-list">
                        {PROCESS_KINDS.map((kind) => {
                          const check = system?.comfyui.workflows?.[kind];
                          const process = settings.processes[kind];
                          const ready = check?.ready === true;
                          const detail = ready
                            ? check?.latencyMs ? `${check.latencyMs} ms` : process.mode === "api" ? "API 凭据已配置" : "节点依赖完整"
                            : check?.missing?.length ? `缺少：${check.missing.join("、")}` : "服务不可用";
                          return (
                            <article key={kind}>
                              <span className="connection-service-icon"><i className={ready ? "ready" : "missing"} /></span>
                              <div><strong>{jobName(kind)}</strong><small>{check?.url || process.url}</small><p>{detail}</p></div>
                              <em className={ready ? "ready" : "missing"}>{ready ? "已就绪" : "未就绪"}</em>
                            </article>
                          );
                        })}
                        {(() => {
                          const topology = system?.comfyui.topology;
                          const ready = topology?.ready === true;
                          const detail = !topology?.configured ? "尚未配置服务地址" : topology.online ? `${topology.latencyMs} ms${topology.architecture ? ` · ${topology.architecture}` : ""}` : "服务离线";
                          return (
                            <article>
                              <span className="connection-service-icon"><i className={ready ? "ready" : "missing"} /></span>
                              <div><strong>AutoRemesher</strong><small>{topology?.url || settings.topology.url || "未配置"}</small><p>{detail}</p></div>
                              <em className={ready ? "ready" : "missing"}>{ready ? "已就绪" : "未就绪"}</em>
                            </article>
                          );
                        })()}
                      </div>
                    </section>
                  ) : settingsTab === "topology" ? (
                    <section className="process-settings" aria-label="自动拓扑 API 配置">
                      <div className="settings-section-heading">
                        <div><span>External Service</span><h3>自动拓扑 API</h3></div>
                        <button className="text-icon-button" type="button" onClick={restoreTopologyDefaults}><RotateCcw size={15} />恢复默认</button>
                      </div>
                      <div className="agent-scope-note"><ShieldCheck size={15} /><span>配置保存在本机后端。可以连接 DGX AutoRemesher，也可以替换为兼容相同请求协议的其他服务。</span></div>
                      <div className="api-mode-status">
                        <span className={`config-state ${settings.topology.url ? "configured" : ""}`}><i />{settings.topology.url ? "服务地址已配置" : "服务地址未配置"}</span>
                      </div>
                      <label className="settings-field">
                        <span>服务地址</span>
                        <input type="url" value={settingsForm.topology.url} placeholder="http://100.120.236.113:8190" onChange={(event) => updateTopologySettings({ url: event.target.value })} />
                        <small className="settings-field-note">可填写 API Base URL，也可填写以 /v1/remesh 结尾的完整地址。</small>
                      </label>
                      <label className="settings-field">
                        <span>目标四边面数</span>
                        <input type="number" required min={1000} max={1000000} step={1000} value={settingsForm.topology.targetQuads} onChange={(event) => updateTopologySettings({ targetQuads: Number(event.target.value) })} />
                        <small className="settings-field-note">允许范围为 1,000 到 1,000,000；默认 50,000。</small>
                      </label>
                      <label className="settings-field">
                        <span>请求超时（秒）</span>
                        <input type="number" required min={30} max={86400} step={30} value={settingsForm.topology.timeoutSeconds} onChange={(event) => updateTopologySettings({ timeoutSeconds: Number(event.target.value) })} />
                        <small className="settings-field-note">允许范围为 30 到 86,400 秒；复杂模型建议至少 3,600 秒。</small>
                      </label>
                    </section>
                  ) : settingsTab !== "agent" && settingsTab !== "coordinator" ? (
                    <section className="process-settings" aria-label={`${settings.processes[settingsTab].label}配置`}>
                      <div className="settings-section-heading">
                        <div><span>{settingsTab === "2d" && settingsForm.processes["2d"].mode === "api" ? "API" : "ComfyUI"}</span><h3>{settings.processes[settingsTab].label}</h3></div>
                        <button className="text-icon-button" type="button" onClick={() => restoreProcessDefaults(settingsTab)}><RotateCcw size={15} />恢复默认</button>
                      </div>
                      {settingsTab === "2d" && <div className="process-mode-control" role="group" aria-label="2D 概念图接入方式">
                        <button type="button" className={settingsForm.processes["2d"].mode === "comfyui" ? "active" : ""} onClick={() => updateProcessSettings("2d", { mode: "comfyui" })}>ComfyUI</button>
                        <button type="button" className={settingsForm.processes["2d"].mode === "api" ? "active" : ""} onClick={() => updateProcessSettings("2d", { mode: "api" })}>API</button>
                      </div>}
                      {settingsTab !== "2d" || settingsForm.processes["2d"].mode === "comfyui" ? <>
                        <label className="settings-field">
                          <span>请求地址</span>
                          <input type="url" required value={settingsForm.processes[settingsTab].url} onChange={(event) => updateProcessSettings(settingsTab, { url: event.target.value })} />
                        </label>
                        {(() => {
                          const kind = settingsTab;
                          const process = settings.processes[kind];
                          const selectedId = settingsForm.processes[kind].activeWorkflowId;
                          const selected = process.workflows.find((item) => item.id === selectedId);
                          return <>
                          <div className="settings-field">
                            <span>工作流版本</span>
                            <div className="workflow-select-row">
                              <StyledSelect value={selectedId} options={process.workflows.map((workflow) => ({ value: workflow.id, label: workflow.name }))} onChange={(value) => void selectWorkflow(kind, value)} ariaLabel={`${process.label}工作流版本`} />
                              <button className="icon-button" type="button" disabled={!selected || selected.source === "default"} onClick={() => void removeWorkflow(kind, selectedId)} title="删除当前工作流" aria-label="删除当前工作流"><Trash2 size={17} /></button>
                            </div>
                          </div>

                          <div
                            className={`workflow-dropzone ${workflowDragging ? "dragging" : ""}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => workflowFileRef.current?.click()}
                            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") workflowFileRef.current?.click(); }}
                            onDragEnter={(event) => { event.preventDefault(); setWorkflowDragging(true); }}
                            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setWorkflowDragging(true); }}
                            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setWorkflowDragging(false); }}
                            onDrop={(event) => {
                              event.preventDefault();
                              setWorkflowDragging(false);
                              handleWorkflowFiles(kind, event.dataTransfer.files);
                            }}
                          >
                            <input ref={workflowFileRef} type="file" accept="application/json,.json" multiple hidden onChange={(event) => {
                              if (event.target.files) handleWorkflowFiles(kind, event.target.files);
                              event.target.value = "";
                            }} />
                            <input ref={workflowDirectoryRef} type="file" multiple hidden onChange={(event) => {
                              if (event.target.files) handleWorkflowFiles(kind, event.target.files);
                              event.target.value = "";
                            }} />
                            <span className="workflow-upload-icon"><Upload size={19} /></span>
                            <div className="workflow-upload-copy"><strong>上传工作流 JSON</strong><span>拖拽文件或点击选择</span></div>
                            <div className="workflow-upload-actions">
                              <button className="icon-button" type="button" onClick={(event) => { event.stopPropagation(); workflowFileRef.current?.click(); }} title="选择 JSON 文件" aria-label="选择 JSON 文件"><Upload size={16} /></button>
                              <button className="icon-button" type="button" onClick={(event) => { event.stopPropagation(); chooseWorkflowDirectory(); }} title="选择目录" aria-label="选择目录"><FolderOpen size={16} /></button>
                            </div>
                          </div>

                          <div className="workflow-summary">
                            <div>
                              <FileJson size={17} />
                              <span><strong>{selected?.name || "工作流"}</strong><small>{selected?.nodeCount ?? 0} 个节点 · {selected?.source === "default" ? "内置" : "已上传"}</small></span>
                            </div>
                            <button className="text-icon-button" type="button" onClick={() => setWorkflowPreviewOpen((value) => !value)} aria-expanded={workflowPreviewOpen}>
                              {workflowPreviewOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}{workflowPreviewOpen ? "收起 JSON" : "预览 JSON"}
                            </button>
                          </div>
                          {workflowPreviewOpen && <pre className="workflow-json-preview">{settingsForm.processes[kind].workflowJson}</pre>}
                          </>;
                        })()}
                      </> : settingsForm.processes["2d"].api && <>
                        <div className="api-mode-status">
                          <span className={`config-state ${settings.processes["2d"].api?.apiKeyConfigured || settings.agent.apiKeyConfigured ? "configured" : ""}`}><i />{settings.processes["2d"].api?.apiKeyConfigured || settings.agent.apiKeyConfigured ? "API Key 已配置" : "API Key 未配置"}</span>
                        </div>
                        <label className="settings-field">
                          <span>Base URL</span>
                          <input type="url" required value={settingsForm.processes["2d"].api.baseUrl} onChange={(event) => updateProcessSettings("2d", { api: { ...settingsForm.processes["2d"].api!, baseUrl: event.target.value } })} />
                        </label>
                        <label className="settings-field">
                          <span>模型</span>
                          <input type="text" required maxLength={160} value={settingsForm.processes["2d"].api.model} onChange={(event) => updateProcessSettings("2d", { api: { ...settingsForm.processes["2d"].api!, model: event.target.value } })} />
                        </label>
                        <label className="settings-field">
                          <span>API Key</span>
                          <input type="password" autoComplete="off" maxLength={1000} value={settingsForm.processes["2d"].api.apiKey} placeholder={settings.processes["2d"].api?.apiKeyConfigured ? "留空以保留当前密钥" : settings.agent.apiKeyConfigured ? "留空以复用 Agent API Key" : "输入 API Key"} onChange={(event) => updateProcessSettings("2d", { api: { ...settingsForm.processes["2d"].api!, apiKey: event.target.value } })} />
                        </label>
                      </>}
                    </section>
                  ) : (() => {
                    const scope = settingsTab === "coordinator" ? "coordinator" : "agent";
                    const isCoordinator = scope === "coordinator";
                    const currentAgent = isCoordinator ? settings.coordinator.agent : settings.agent;
                    const draftAgent = isCoordinator ? settingsForm.coordinator.agent : settingsForm.agent;
                    const currentImages = isCoordinator ? settings.coordinator.imageModels : settings.imageModels;
                    const draftImages = isCoordinator ? settingsForm.coordinator.imageModels : settingsForm.imageModels;
                    const models = isCoordinator ? coordinatorModels : agentModels;
                    const resetModels = () => {
                      const current = [{ id: draftAgent.model, name: draftAgent.model }];
                      if (isCoordinator) setCoordinatorModels(current);
                      else setAgentModels(current);
                    };
                    return <section className="agent-settings" aria-label={`${isCoordinator ? "总调度" : "任务"} Agent API 配置`}>
                      <div className="agent-scope-note"><ShieldCheck size={15} /><span>此处配置仅供{isCoordinator ? "总调度 Agent" : "任务 Asset Agent"}使用，与另一套 Agent 配置完全独立。</span></div>
                      <div className="settings-section-heading">
                        <div><span>{isCoordinator ? "Workspace Coordinator" : "Asset Agent"}</span><h3>{isCoordinator ? "调度模型 API" : "任务模型 API"}</h3></div>
                        <span className={`config-state ${currentAgent.apiKeyConfigured ? "configured" : ""}`}><i />{currentAgent.apiKeyConfigured ? "已配置" : "未配置"}</span>
                      </div>
                      <label className="settings-field"><span>Base URL</span><input type="url" required value={draftAgent.baseUrl} onChange={(event) => { updateAgentApiSettings(scope, { baseUrl: event.target.value }); resetModels(); }} /></label>
                      <div className="settings-field">
                        <span>模型</span>
                        <div className="agent-model-row">
                          <StyledSelect value={draftAgent.model} options={models.map((model) => ({ value: model.id, label: model.name === model.id ? model.id : `${model.name} · ${model.id}` }))} onChange={(value) => updateAgentApiSettings(scope, { model: value })} ariaLabel={`${isCoordinator ? "总调度" : "任务"} Agent 模型`} />
                          <button className="text-icon-button" type="button" onClick={() => void fetchAgentModels(scope)} disabled={agentModelsLoading || draftAgent.clearApiKey}>
                            <RefreshCw className={agentModelsLoading ? "spinning" : ""} size={15} />{agentModelsLoading ? "获取中" : "获取模型"}
                          </button>
                        </div>
                      </div>
                      <div className="settings-field">
                        <span>推理强度</span>
                        <StyledSelect
                          value={draftAgent.reasoningEffort}
                          options={[
                            { value: "high", label: "High（默认，深度推理）" },
                            { value: "low", label: "Low（更快、更省 Token）" },
                            { value: "off", label: "关闭（不发送推理强度）" },
                          ]}
                          onChange={(value) => updateAgentApiSettings(scope, { reasoningEffort: value as ReasoningEffort })}
                          ariaLabel={`${isCoordinator ? "总调度" : "任务"} Agent 推理强度`}
                        />
                        <small className="settings-field-note">仅在所选模型支持 reasoning_effort 时生效。</small>
                      </div>
                      <label className="settings-field"><span>API Key</span><input type="password" autoComplete="off" maxLength={1000} value={draftAgent.apiKey} disabled={draftAgent.clearApiKey} placeholder={currentAgent.apiKeyConfigured ? "留空以保留当前密钥" : "输入 API Key"} onChange={(event) => { updateAgentApiSettings(scope, { apiKey: event.target.value }); resetModels(); }} /></label>
                      {currentAgent.apiKeyConfigured && <label className="clear-key-control"><input type="checkbox" checked={draftAgent.clearApiKey} onChange={(event) => { updateAgentApiSettings(scope, { clearApiKey: event.target.checked, apiKey: event.target.checked ? "" : draftAgent.apiKey }); resetModels(); }} /><span>清除已保存的 API Key</span></label>}
                      <div className="settings-section-heading image-model-heading">
                        <div><span>{isCoordinator ? "总调度 Agent" : "任务生成流程"}</span><h3>图片模型 API</h3></div>
                        <span className={`config-state ${currentImages.textToImage.apiKeyConfigured && currentImages.imageToImage.apiKeyConfigured ? "configured" : ""}`}><i />{currentImages.textToImage.apiKeyConfigured && currentImages.imageToImage.apiKeyConfigured ? "两项均已配置" : "需要分别配置"}</span>
                      </div>
                      {(["textToImage", "imageToImage"] as const).map((key) => {
                        const label = key === "textToImage" ? "文生图" : "图生图";
                        const current = currentImages[key];
                        const draft = draftImages[key];
                        return <fieldset className="image-model-config" key={key}>
                          <legend>{label}模型</legend>
                          <label className="settings-field"><span>Base URL</span><input type="url" required value={draft.baseUrl} onChange={(event) => updateImageModelSettings(scope, key, { baseUrl: event.target.value })} /></label>
                          <label className="settings-field"><span>模型</span><input type="text" required maxLength={160} value={draft.model} onChange={(event) => updateImageModelSettings(scope, key, { model: event.target.value })} /></label>
                          <label className="settings-field"><span>API Key</span><input type="password" autoComplete="off" maxLength={1000} disabled={draft.clearApiKey} value={draft.apiKey} placeholder={current.apiKeyConfigured ? "留空以保留当前密钥" : "输入 API Key"} onChange={(event) => updateImageModelSettings(scope, key, { apiKey: event.target.value })} /></label>
                          {current.apiKeyConfigured && <label className="clear-key-control"><input type="checkbox" checked={draft.clearApiKey} onChange={(event) => updateImageModelSettings(scope, key, { clearApiKey: event.target.checked, apiKey: event.target.checked ? "" : draft.apiKey })} /><span>清除已保存的 {label} API Key</span></label>}
                        </fieldset>;
                      })}
                    </section>;
                  })()}
                </div>

                <div className="settings-actions">
                  <button type="button" className="secondary-button" onClick={() => setShowSettings(false)}>取消</button>
                  <button type="submit" className="primary-button" disabled={settingsSaving}><Save size={16} />{settingsSaving ? "保存中…" : "保存配置"}</button>
                </div>
              </>
            )}
          </form>
        </div>
  );
}
