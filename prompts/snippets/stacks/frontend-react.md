---
title: React 前端技术栈规范
stage: snippets
projectType: 前端项目
tags: [前端, React, TypeScript, Tailwind]
description: React + TypeScript + Vite + Tailwind CSS 技术栈规范与最佳实践
version: 1
---

## 技术栈规范：React + TypeScript + Vite + Tailwind CSS

在生成前端相关代码时，遵循以下技术标准：
1. **组件设计**：
   - 优先使用函数组件与 Hooks，禁止使用 Class 组件。
   - 复杂状态逻辑抽取为自定义 Hook，避免组件内部逻辑臃肿。
   - 组件 Props 严格声明 `interface` 或 `type`，禁止使用 `any`。
2. **样式方案**：
   - 优先采用 Tailwind CSS 原子化类名，保持设计语言一致与零运行时开销。
   - 避免直接书写未约束的内联样式；对于动态属性，采用 classnames/clsx 或 CSS 变量。
3. **状态管理与副作用**：
   - 区分服务端状态与本地 UI 状态，避免无节制提升全局状态。
   - `useEffect` 必须严格声明完整依赖项，禁止随意禁用 `eslint-plugin-react-hooks`。
4. **性能与用户体验**：
   - 长列表采用虚拟滚动；大体积资源/非关键路由使用 `React.lazy` 与动态 import。
