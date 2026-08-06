"use client";

import { Bell, LoaderCircle, Moon, Play, Save, ShieldCheck, Sparkles, Sun, X } from "lucide-react";
import type { Dispatch, FormEvent, SetStateAction } from "react";

import type { GlobalPreferences } from "../../shared/contracts";

export function GlobalSettingsDialog({ draft, loading, saving, setDraft, close, save }: {
  draft: GlobalPreferences;
  loading: boolean;
  saving: boolean;
  setDraft: Dispatch<SetStateAction<GlobalPreferences>>;
  close: () => void;
  save: (event: FormEvent) => Promise<void>;
}) {
  return <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><form className="global-settings-panel" onSubmit={(event) => void save(event)} aria-label="全局设置"><div className="settings-header"><div><span>Website Preferences</span><h2>全局设置</h2></div><button className="icon-button" type="button" onClick={close} aria-label="关闭全局设置面板"><X size={19} /></button></div>{loading ? <div className="settings-loading"><LoaderCircle size={20} /><span>正在读取全局设置</span></div> : <div className="global-settings-content"><section className="global-settings-section" aria-labelledby="global-theme-title"><div className="global-settings-section-heading"><span className="global-settings-icon"><Moon size={18} /></span><div><h3 id="global-theme-title">默认主题</h3><p>控制首次打开网页时的默认外观，可通过顶栏按钮随时切换。</p></div></div><div className="default-permission-options" role="radiogroup" aria-label="默认主题"><ThemeOption active={draft.defaultTheme === "dark"} icon={<Moon size={17} />} title="深色背景" detail="默认使用深色配色" onClick={() => setDraft((current) => ({ ...current, defaultTheme: "dark" }))} /><ThemeOption active={draft.defaultTheme === "light"} icon={<Sun size={17} />} title="浅色背景" detail="默认使用浅色配色" onClick={() => setDraft((current) => ({ ...current, defaultTheme: "light" }))} /></div></section><PreferenceToggle icon={<Sparkles size={18} />} title="视觉效果" description="控制页面背景的实时波浪与粒子运动。" label="背景动画" detail="默认关闭；开启后波浪与粒子会随时间和鼠标方向变化。" checked={draft.backgroundAnimationEnabled} onChange={(checked) => setDraft((current) => ({ ...current, backgroundAnimationEnabled: checked }))} /><PreferenceToggle icon={<Bell size={18} />} title="通知" description="控制顶部通知中心和实时弹出的站内提醒。" label="展示通知" detail="关闭后保留通知记录，但不显示铃铛入口和弹出提醒。" checked={draft.notificationsEnabled} onChange={(checked) => setDraft((current) => ({ ...current, notificationsEnabled: checked }))} /><section className="global-settings-section" aria-labelledby="global-permission-title"><div className="global-settings-section-heading"><span className="global-settings-icon"><ShieldCheck size={18} /></span><div><h3 id="global-permission-title">默认执行权限</h3><p>应用于总调度 Agent，并作为尚未单独设置权限的新任务默认值。</p></div></div><div className="default-permission-options" role="radiogroup" aria-label="默认执行权限"><PermissionOption active={draft.defaultApprovalMode === "request"} icon={<ShieldCheck size={17} />} title="请求批准" detail="执行关键操作前先征求确认" onClick={() => setDraft((current) => ({ ...current, defaultApprovalMode: "request" }))} /><PermissionOption active={draft.defaultApprovalMode === "auto"} icon={<Play size={17} />} title="自动执行" detail="符合流程的操作无需逐次批准" onClick={() => setDraft((current) => ({ ...current, defaultApprovalMode: "auto" }))} /></div><p className="global-settings-note">已有任务若设置过独立权限，将继续使用各自的设置。</p></section></div>}<div className="settings-actions"><button type="button" className="secondary-button" onClick={close}>取消</button><button type="submit" className="primary-button" disabled={loading || saving}><Save size={16} />{saving ? "保存中…" : "保存设置"}</button></div></form></div>;
}

function PreferenceToggle({ icon, title, description, label, detail, checked, onChange }: { icon: React.ReactNode; title: string; description: string; label: string; detail: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const id = `global-${label}`;
  return <section className="global-settings-section" aria-labelledby={id}><div className="global-settings-section-heading"><span className="global-settings-icon">{icon}</span><div><h3 id={id}>{title}</h3><p>{description}</p></div></div><label className="global-setting-row"><span><strong>{label}</strong><small>{detail}</small></span><input className="settings-switch-input" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i className="settings-switch" aria-hidden="true" /></label></section>;
}

function ThemeOption({ active, icon, title, detail, onClick }: { active: boolean; icon: React.ReactNode; title: string; detail: string; onClick: () => void }) {
  return <button type="button" role="radio" aria-checked={active} className={active ? "active" : ""} onClick={onClick}>{icon}<span><strong>{title}</strong><small>{detail}</small></span></button>;
}

function PermissionOption({ active, icon, title, detail, onClick }: { active: boolean; icon: React.ReactNode; title: string; detail: string; onClick: () => void }) {
  return <button type="button" role="radio" aria-checked={active} className={active ? "active" : ""} onClick={onClick}>{icon}<span><strong>{title}</strong><small>{detail}</small></span></button>;
}