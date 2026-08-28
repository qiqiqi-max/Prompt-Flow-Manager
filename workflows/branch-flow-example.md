---
title: 分支流程示例
flow:
  - id: start
    prompt: prompts/project-init/需求分析.md
    label: 需求分析
    next: [dev, test]
  - id: dev
    prompt: prompts/code-generation/功能实现.md
    label: 开发实现
    next: review
  - id: test
    prompt: prompts/testing/测试策略.md
    label: 测试用例
    next: review
  - id: review
    prompt: prompts/code-review/代码审查.md
    label: 代码审查
    next: deploy
  - id: deploy
    prompt: prompts/deployment/部署检查.md
    label: 部署上线
---

# 分支流程示例

本工作流演示**分支与汇合**：需求分析后并行进入「开发实现」和「测试用例」两条线，再汇合到「代码审查」，最后部署。

`next` 字段支持数组，表示同时流向多个步骤。流程图会自动分层布局并绘制分支连线。

## 说明

- `next: [dev, test]` —— 一步分出两条线
- 两条线各自的 `next: review` —— 汇合到同一步
- 点击任意节点可跳转到对应提示词，复制后到 AI 工具使用
