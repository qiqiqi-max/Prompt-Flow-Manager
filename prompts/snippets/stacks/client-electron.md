---
title: Electron 客户端技术栈规范
stage: snippets
projectType: 脚本工具
tags: [客户端, Electron, 架构, 安全]
description: Electron 桌面客户端安全与架构规范（主进程/渲染进程安全隔离）
version: 1
---

## 技术栈规范：Electron 桌面客户端与安全规约

在编写与生成 Electron 代码时，必须恪守以下安全与架构基线：
1. **安全隔离（Security Boundaries）**：
   - 必须开启 `contextIsolation: true` 并设置 `nodeIntegration: false`。
   - 渲染进程禁止直接引入 Node 原生模块或 `fs` / `child_process`。
   - 必须通过 `preload.js` 借助 `contextBridge.exposeInMainWorld` 暴露受限 API。
2. **IPC 通信设计**：
   - 使用 `ipcRenderer.invoke` 与 `ipcMain.handle` 实现双向异步通信。
   - 主进程对所有入参执行严格校验（路径穿越防御、白名单过滤），绝不盲目信任渲染进程输入。
3. **文件写入原子性**：
   - 本地数据持久化必须使用临时文件 + 原子重命名（`writeFileAtomic`），防止断电或崩溃产生空文件与损坏。
4. **生命周期与资源清理**：
   - 窗口销毁前注销所有全局快捷键、IPC 监听器与后台定时任务。
