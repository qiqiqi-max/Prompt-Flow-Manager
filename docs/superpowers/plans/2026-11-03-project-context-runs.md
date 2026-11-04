# Project Context and Workflow Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver project-isolated prompt context and independently resumable workflow runs with safe migration and complete backup.

**Architecture:** Two main-process JSON stores under DATA_ROOT, a workspace service that owns mutation and migration, shared pure context resolution, and renderer controls integrated into the current UI. Existing FLOW_RUN remains the graph-progress engine. Changes to the write scheduler reserve all keys before entering the shared import gate.

**Tech Stack:** Existing Electron 43.7.2, Node, vanilla JS/HTML/CSS, archiver/yauzl. No new runtime dependencies.

**Spec:** docs/superpowers/specs/2026-11-02-project-context-runs-design.md

## Global Constraints

- 两个存储模块不 require electron，文件路径、原子写函数、错误工厂与 fs 依赖可注入，以裸 Node 测试。
- 保留“复制成功后自动完成本步并推进”；不增加人工完成确认或结果附件。
- 最多 100 个项目、1000 次运行；达到上限时拒绝新增并提示整理，不自动淘汰未完成或历史记录。
- 项目名称/运行名称最长 200 字符；描述、技术栈、路径和约束各最多 20000 字符。
- 延用占位符限制：最多 200 个值，单值不超过 20000 字符；过长值不截断后预填，输入时提示。
- 单次运行最多 500 个步骤；projects.json 与 workflow-runs.json 各不超过 16 MiB。
- config.flowRuns 原样留作只读迁移备份，不再被正常页面更新，不为兼容回写最新运行。
- 选择了项目或执行绑定项目的运行时，不回落全局 fillMemory，避免串项目。
- 新字符串中英双语，字号 rem，保持 contextIsolation、CSP 和 preload 白名单。
- 测试仅使用临时 PFM_DATA_DIR；CONTRIBUTING.md 要求对新增断言提供目标失败的反向对照证据。
- User approved execution. Proceed through the plan and review without further design/execution permission prompts. Product code belongs only in the isolated feature worktree.

## Review Focus

- Open fill panel while project/run changes: late completion must neither copy stale context nor advance another run (Task 3).
- Rename/delete and import concurrently: all promises settle and rollback preserves user data (Tasks 1, 2, 4).
- Existing local filenames collide on import: executing the imported run must use imported prompt/include copies (Task 4).
- Corrupt/unknown-schema/symlink business file: preserve evidence and never overwrite as an empty store (Task 1).
- Completed run and deleted workflow: browsing history must not mutate progress or silently bind a replacement file (Tasks 2, 3).

### Task 1: Safe business storage, context resolution, and queue reservation

**Files:** Create lib/workspace-data.js, lib/project-store.js, lib/run-store.js, lib/write-queue.js, src/project-context.js, tests/workspace-stores.test.js, tests/project-context.test.js, tests/write-queue.test.js. Modify package.json for focused scripts and test:quick integration. Other files only if a concrete test integration requires them.

**Interfaces:**
- src/project-context.js dual browser/CommonJS PROJECT_CONTEXT exports snapshot(project, globalValues), resolve(tokenDescriptor, {context, values, globalValues}), cleanValues(raw), fieldValues(project). resolve returns a string, uses token/hint/default descriptors, own-property checks and exact English/Chinese field aliases. context null means ordinary global mode; a non-null snapshot suppresses live global fallback.
- createProjectStore({file, writeFileAtomic, appError, fsp?, now?, newId?}) -> {read(), write(document), create(fields), update(id, revision, fields), duplicate(id, revision), select(id, revision), remove(id, revision), remember(id, revision, values)}. Methods are unqueued; service owns serialization. Mutations return the full document; document includes schema:1, revision, activeProjectId, projects.
- createRunStore(same options) -> {read(), write(document)}. Document includes schema:1, revision, legacyImported, selectedByWorkflow, runs. Run objects follow spec. Export validation helpers from focused shared workspace-data module as useful, not general-purpose framework.
- createWriteQueue(gate) -> {run(keys, fn)} reserves all unique key tails synchronously before waiting, then one gate.shared(fn). Calls from exclusive context execute without waiting ordinary chains; provide explicit runLocked or gate.isInExclusiveContext() if necessary. Do not alter unrelated queue consumers in this task.
- read/write enforce shape, count, byte limits, schema and link safety; error codes start E_WORKSPACE_ or E_PROJECT_/E_RUN_. Corrupt read must preserve a timestamped file and report recovery, never silently overwrite. Do not cache success before atomic write.

- [x] Write tests with literal expectations: A context resolves `[项目名称]` to A even global memory is B; explicit per-run value wins; null context reads global; cleared value is preserved for current fill; defaults work; dangerous keys cannot mutate prototypes.
- [x] Write real-temp-file tests: CRUD survives fresh store; stale revision rejected; 101st project and 1001st run rejected; linked file refused; unknown schema file byte-identical after rejected write; write fault leaves previous bytes; invalid/oversize inputs rejected; valid store never silently trimmed.
- [x] Write deterministic queue ordering test using deferred promises: A shared mutation, queued exclusive, queued overlapping mutation all finish; overlapping key updates serialize, disjoint updates can proceed. Reverse controls must target lost updates and nested-gate deadlock without hanging suite (bounded timeout).
- [x] Run focused tests and capture expected RED; implement interfaces and run GREEN plus reverse controls.
- [x] Run npm test and npm run lint; commit Chinese message with only task files; detailed report records exact commands and evidence.

### Task 2: Main-process workspace service, migration, and lifecycle

**Files:** Create lib/workspace-service.js, tests/workspace-service.test.js. Modify electron-main.js, preload.js, quick-launch-preload.js only if necessary, lib/write-gate.js, lib/write-queue.js if needed, src/i18n.js, package.json. Keep renderer behavior changes for Task 3.

**Interfaces:**
- createWorkspaceService({projects, runs, queue, loadConfig, readWorkflow, appError, now?, newId?, notify?}) exposes initialize(), getState(), projectAction(action,payload), runAction(action,payload), relocateWorkflowLocked(oldRel,newRel), removeWorkflowLocked(rel), exportDataLocked(), importDataLocked(data,relMap), invalidate().
- getState() -> {projects: projectsDocument, runs: runsDocument, warnings:[]}; all IPC mutations return this snapshot. Store read helpers remain available to backup coordinator under gate.
- projectAction supports create/update/duplicate/select/remove/remember. payload carries id/revision and whitelisted fields/values. Remove rejects bound runs. Document revision used for selection/create, entity revision for entity edits; validate at boundary.
- runAction supports create/select/resume/complete/skip/back/choose/detach/remove. create carries workflowRel/name/projectId and runs document revision. Others carry id/revision, complete carries values + expected workflow content hash; resume accepts graph update confirmation explicitly. Result exposes workflow hash needed for subsequent complete.
- readWorkflow(rel) -> {steps, hash} from actual library data. Use existing parser (locate lib/workflow-index.js or FLOW_GRAPH parser); do not duplicate YAML parser. Service analyzes steps, snapshots context, computes status via FLOW_RUN, validates safe rels and graph limits.
- initialize migrates legacy flowRuns exactly once with deterministic IDs, snapshots global memory, preserves missing workflow progress disabled. Keep old config unchanged. Store failures do not expose a partially initialized live state.
- preload methods: getWorkspace(), projectAction(action,payload), runAction(action,payload), onWorkspaceChanged(cb). IPC channels workspace-get, project-action, run-action, workspace-changed. Export main-process only Locked hooks for backup/lifecycle, never arbitrary JSON writes over IPC.

- [x] Test legacy migration idempotence/retry after failure/missing workflow; two runs same template progress independently; project binding snapshots remain fixed; no-project run snapshots global values; stale hash/revision rejected; completed browse unchanged; graph confirmation update atomic; detach then delete project keeps run values.
- [x] Test rename all runs/selection, delete/move-out preserve disabled histories, later same path does not auto-enable; write rollback failures explicit. Correlate file content and workspace changes under fixed multi-key reservation; add concurrent exclusive-import interleaving test.
- [x] Run RED, implement service and IPC. Replace main rename/trash legacy config mutations with workspace lifecycle hooks and transaction snapshots. Replace affected nested queue entrypoints with reserved multi-key operation; preserve config locks, trash, versions and usage semantics.
- [x] Integrate quick-panel show payload with active project snapshot; changes invalidate/hide stale panel. Main-process errors localized in both languages. Diagnostics expose only counts, never values/names.
- [x] Add store write-failure injection only through existing isolated selftest mechanism if needed for UI tests. Run GREEN/reverse controls, existing file move/trash/config/write-gate tests, npm test/lint. Commit and report.

### Task 3: Project management and independent run UI

**Files:** Modify src/renderer.js, src/index.html, src/styles.css, src/quick-launch.js, src/quick-launch.html, src/i18n.js, eslint.config.js, tests/flow-run-copy.test.js, tests/flow-run-integration.test.js, package.json. Create src/workspace-ui.js if extracting project dialogs/history keeps renderer focused; create tests/workspace-integration.test.js and src/selftest/workspace.js for real Electron scenarios.

**Interfaces:** Consume getWorkspace/projectAction/runAction/onWorkspaceChanged. state.workspace is authoritative snapshot after awaited success. Selected runtime identity uses run.id plus revision, not workflowRel alone. PROJECT_CONTEXT included in both windows. Existing FLOW_RUN pure module remains used to present progress only; settlement performed via service.

- [x] Add RED real-Electron flow: create projects A/B through controls, fill same token, switch and show isolated prefill, edit/duplicate/delete with bound-run refusal and detach; restart and restore selected project and runs.
- [x] Add RED two-run flow: create two named runs for one workflow, alternate progress, new run retains old history, global project switch leaves run snapshot fixed; deleted workflow history view remains accessible and read-only; missing workflow cannot copy.
- [x] Add race/failure assertions: change project/run/file while read/fill pending -> no stale clipboard or advance; clipboard succeeds but store fails -> unchanged persisted progress + explicit localized error; writes awaited before closing.
- [x] Implement project selector and manager using existing dialog/focus conventions; separate global history entry for missing workflows, run selection/new/delete/detach/history details, confirmation on graph changes. Use compact controls respecting 800x500 and font scaling. Include ID suffix for duplicate names.
- [x] Replace config.flowRuns debounce/persistence with service calls throughout restore/rename/trash/batch/import/close paths. Remove obsolete writer; tests may retain old config only as migration fixtures. Disable controls during operation, invalidate async requests on workspace/file revisions, preserve focus.
- [x] Share context resolution in ordinary copy, inline placeholders and quick panel where prefill is applicable; capture scope at copy start; remember only ordinary project copies, run values only run store. Quick panel read-only. Composer prefill name/description and explicit supported stack mapping without mutating saved project.
- [x] Run focused RED/GREEN/reverse evidence, npm test/lint, test:ui, flow-run integration/copy, quick launch, layout-small. Commit and report.

### Task 4: Backup portability, integration verification, documentation and package

**Files:** Modify electron-main.js, lib/zip-import.js, lib/backup-preview.js, lib/backup-manifest.js if necessary, lib/workspace-service.js, src/i18n.js, src/renderer.js import refresh, lib/diagnostics.js if needed, README.md, CHANGELOG.md, CLAUDE.md, CONTRIBUTING.md, package.json. Create lib/workspace-backup.js, tests/workspace-backup.test.js, tests/workspace-backup-integration.test.js and selftest script if needed. Extend existing backup/rollback tests only where contract changes.

**Interfaces:** workspace-backup exports exact PROJECTS_ENTRY='.pfm/projects.json', RUNS_ENTRY='.pfm/workflow-runs.json', validatePortable(data), remapImportedContent(content,relMap), prepareImport(current,data,relMap,newId) returning merged documents with ID remaps and disabled missing-dependency runs. Integrate service import/export Locked APIs from Task 2; do not reset current selections.

- [x] RED: ZIP roundtrip with two projects/runs, local filename collision for workflow/prompt/nested include -> imported actual workflow and include text references imported copies, current version note hash matches transformed content. Current data/selections untouched; all imported IDs new; unsupported/malformed/overlimit data causes rollback before partial success.
- [x] RED: inject failure after business file writes and after later trash import -> original files byte-equivalent; no cache/renderer stale data; concurrent mutation waits until transaction ends. Older ZIP missing business entries imports successfully. Unknown JSON paths remain excluded; new two entries bounded at 16 MiB and overall 64 MiB.
- [x] Implement two exact ZIP entries, manifest participation, counts/privacy text in preview, short exclusive export snapshot after dialog, strict import validation and capacity preflight, project/run ID and all actual flow/include path remaps, blocked missing dependencies, transaction snapshots and refresh on rollback.
- [x] Verify exported and imported runs cannot silently resolve missing package dependencies to existing local files; originalGraphSnapshot and graphSnapshot both remapped. Preserve normal prose/frontmatter; reuse existing workflow reference text rewriting and add precise include rewriting rather than global replace.
- [x] Update README storage/migration/context/history/backup instructions and limitations; CHANGELOG; contributor test inventory. Version bump only if required by existing release flow; no new dependency.
- [x] Run focused GREEN/reverse controls and npm run test:all, npm run dist, npm run test:packaged. Use existing known local sandbox fallback transparently; do not report strict sandbox as locally passing. Commit and report exact tested commit/tree, artifact path/hash and unresolved risks.

## Completion

- [x] Each task has fresh spec/quality review and resolved important findings.
- [x] Whole branch review against the accepted design, fix wave if needed, rerun affected checks.
- [x] Push feature branch and open reviewable PR using existing GitHub authorization; never force-push or directly push main. Do not automatically merge this new feature without matching current authorization.
- [ ] Report implemented functionality, test/package evidence, PR and executable location concisely.



## Recovery verification (2026-11-04)

Task 3 input protection and two-process restoration committed as 9900d14; targeted RED/GREEN controls, quick-launch, workspace UI, lint and npm test passed. Scoped fix review accepted. Task 4 backup code committed as 8007e43; focused quick and real backup integration/reverse controls pass. Full regression and independent review passed; follow-up Windows path and obsolete-empty-legacy fixes passed focused regressions and scoped reviews. Final executable built from a733a91 and packaged checks passed. PR #16 opened; CI tracked in the verification record.
