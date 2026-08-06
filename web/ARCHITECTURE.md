# Web 架构与依赖规则

`web/` 是一个本地模块化单体：React/Vinext 控制台、Node.js API、Agent Runtime 和
SQLite 进程内协作，计算密集型工作通过受控 Python 子进程委派给 DGX / ComfyUI。
代码按业务能力形成垂直模块，而不是按 `controllers/services/utils` 三层拆分。

本文描述的是当前实现。标记为“迁移中”的职责尚未完成移动，不能把目录已经存在
误解为该 Feature 已经拥有全部业务状态。

## 运行 seam

```text
React / Vinext
  │ HTTP JSON；可取消、按选择对象隔离的轮询
  ▼
Node.js 本地模块化单体
  │ 固定脚本 + 白名单参数 + JSON/stdout 协议
  ▼
Python pipeline（Node 的私有适配层）
  │ ComfyUI HTTP / WebSocket
  ▼
DGX / ComfyUI（GPU 计算面）
```

- React 只依赖 Node 的 HTTP 契约，不知道 SQLite、Python 命令或 ComfyUI 节点。
- Node 是业务规则、Run 状态机、审批、队列和持久化的事实来源。只有 Node 可以启动
  Python；浏览器不能直接访问 Python 或 DGX。
- `server/pipeline/` 是 Node 的私有 Adapter，不是第二个业务后端。它接收已经校验的
  输入、运行固定工作流并返回产物事实，不决定阶段推进或审批结果。
- DGX / ComfyUI 只执行 GPU 工作流。网络连通不等于业务授权，不能绕过 Node 的质量门禁。

## 前端模块

```text
app/page.tsx                         # 服务端页面入口；提供初始快照（迁移例外）
app/Studio.tsx                       # 稳定的页面组合入口
app/studio/StudioApplication.tsx     # 组合根：状态从 useStudioState 注入
app/studio/features/useStudioState.ts # 统一状态 Hook 层
app/studio/features/<feature>/       # Feature 状态、表单、查询与展示
app/studio/HomeScreen.tsx            # 主页展示组件
app/studio/TaskScreen.tsx            # 任务展示组件
app/studio/StudioDialogs.tsx         # 通用对话组件
app/studio/shared/                   # 契约、API client、轮询原语、selector、通用 UI
```

`StudioApplication.tsx` 已通过 `useStudioState` Hook 将全部状态逻辑外移到
`features/useStudioState.ts`（约 1227 行），自身缩减为约 380 行的组合根。它以
公开 Feature index 和新、旧共享组件组合页面，实现 `StudioNavigation + HomeScreen +
TaskScreen + 全局弹窗` 模式。大型对话框组件（AssetLibrary、SettingsDialog、
GlobalSettingsDialog）通过 `lazy()` 动态加载，无需预先加入主 chunk。

状态所有权规则：

状态所有权规则：

- 服务端状态：一个远程资源只有一个 query owner；Mutation 通过该 owner 刷新或失效；
- UI 状态：归属实际渲染并修改它的 Feature；
- 表单状态：归属 Dialog 或 Composer；
- 派生状态：通过 selector 计算，不复制到 `useState`；
- Timer、请求取消、DOM Ref 和队列 Ref：隐藏在 Feature Interface 后面。

`shared/use-polling-query.ts` 负责取消旧选择请求、防止并发轮询、页面不可见时降频。
它只是共享机制；具体资源的 key、频率、数据应用和错误语义仍由 Feature query owner 决定。

## 后端模块

```text
server/index.mjs                     # 进程与依赖组合根（仍有待迁移领域逻辑）
server/http/dispatch-routes.mjs      # HTTP route dispatcher
server/features/
  runs/
  workspaces/
  assets/
  jobs/
  quality-gates/
  agents/
  approvals/
  settings/
  system/
server/agent-runtime.mjs             # 迁移中的任务 Agent 组合实现
server/pipeline/                      # Python 生成 Adapter
```

HTTP 路由已按业务能力拆成 route factory，并由 `index.mjs` 组合。Runs 已开始提供领域
Interface；其余建表迁移、Workspace/Asset/Job 领域逻辑和部分外部探测仍在
`index.mjs`，所以当前只是垂直化的过渡状态，不是最终完成的 Feature 架构。

每个完成的后端 Feature 应提供一个小而深的 Interface，例如：

```text
createRuns({ db, jobs, assets, clock, ids })
  → list / get / create / reset / remove
  → advance / revert

createRunRoutes({ runs, http })
```

Route 是 HTTP Adapter，不直接接收十几个 SQL helper 或跨 Feature 内部对象。Feature
可以依赖另一个 Feature 的公开 Interface；不能穿透到对方的 SQL、Ref、私有 Hook 或
内部文件。SQLite 的内存 Adapter 可直接用于 Interface 测试，不需要制造通用
repository/service/controller 层。

`agent-runtime.mjs` 仍处于迁移期。目标内部模块为 `TaskAgentConversation`、
`AssetWorkflowSupervisor` 和 `StructuredRoleRunner`；质量门禁策略、结构化 contracts
与任务执行策略可以留在相应垂直 Feature 中。不要建立无业务归属的 `utils` 集合。

## 依赖方向

```text
页面组合
  └─> Feature 公开 index（Interface）
        └─> shared contracts / API client / polling primitive

Node 组合根
  └─> Feature 公开 index（Interface）
        └─> 显式依赖的 Adapter / shared mechanism
```

强制规则：

1. `shared` 不得导入任何具体 Feature；
2. Feature 间只能导入目标 Feature 根目录的 `index.ts` / `index.mjs`；
3. 页面组合可以导入 Feature 的公开 index，不得导入其内部 Hook 或实现文件；
4. React 展示/组合模块不得直接调用 `fetch`；请求只能位于命名明确的
   `*-api`、`*-client`、`*-query`、`*-gateway` 或 `*-repository` Adapter；
5. `StudioApplication`、`HomeScreen`、`TaskScreen`、`StudioNavigation` 不得新增网络实现。

上述约束由 `scripts/check-architecture.mjs` 扫描真实源码 import 图和网络调用，
并同时接入 `npm run lint` 与 `npm run test:node`。规则本身由
`server/architecture-rules.test.mjs` 使用故意违规的临时项目验证。

### 明确的迁移例外

例外是逐条指纹锁定的现存债务，不是目录级白名单：

- `app/page.tsx` 仍有 Runs 与 Workspaces 两个首屏快照 `fetch`；任何第三个调用会失败；
- `StudioApplication.tsx` 不再直接导入 Feature 内部实现，所有状态通过 `useStudioState` 
  和公开 Feature index 获取。`DEFAULT_COMPOSITION_IMPORT_EXCEPTIONS` 已清空。

删除这些旧调用后无需修改检查器。迁移完成时应连同对应例外一起删除。

## 验证

```bash
npm run lint:architecture
npm run lint:bundle
npm run lint
npm run test:node
npm run build
npm run test:e2e
```

架构检查验证依赖方向；单元测试验证 Feature Interface；浏览器 Smoke Test 验证首页、
任务阶段、Agent 队列/取消、Coordinator Session、Settings、审批和通知等用户行为。
生产构建把 React/Vinext、Markdown 和 Three.js 拆为可归因的稳定 vendor chunk，随后
`scripts/check-bundle.mjs` 对 manifest 中每个客户端 chunk 的 raw/gzip 大小执行硬预算。
Three.js 是当前唯一允许超过 500 kB 的 chunk，仅由懒加载的 ModelViewer 使用；Vite
警告保持开启，预算不会通过调高通用阈值隐藏增长。

## 完成定义

- `Studio.tsx` 只组合页面和持有少量顶层选择；不以另一个超大文件保存原耦合；
- 每个远程资源有唯一数据 owner，切换 Run/Workspace 会取消旧请求且旧响应不能覆盖新状态；
- `index.mjs` 只负责进程、基础设施和 Feature Interface 组合（约 480 行）；
- `agent-runtime.mjs` 只组合深模块，不再实现所有角色与会话细节；
- 展示模块不直接请求网络，跨 Feature 依赖只经过公开 Interface；
- Node、Python 和 DGX 的运行 seam 保持单向且不泄漏业务授权；
- 大型对话框（AssetLibrary、Settings、GlobalSettings）通过 `React.lazy()` 动态加载；
  ModelViewer（Three.js 依赖）也是懒加载，其 vendor-three 是唯一允许超 500 kB 的 chunk。
