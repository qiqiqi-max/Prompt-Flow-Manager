---
title: 完整项目流程
flow:
  - id: step1
    prompt: prompts/project-init/需求分析.md
    label: 需求分析
    next: step2
  - id: step2
    prompt: prompts/code-generation/功能实现.md
    label: 功能实现
    next: step3
  - id: step3
    prompt: prompts/code-review/代码审查.md
    label: 代码审查
    next: step4
  - id: step4
    prompt: prompts/testing/测试策略.md
    label: 测试策略
    next: step5
  - id: step5
    prompt: prompts/deployment/部署检查.md
    label: 部署检查
---

# 完整项目流程

本流程串联了一个项目从启动到上线的标准步骤。点击上方流程图节点可跳转到对应提示词，复制后粘贴到 AI 工具使用。

## 使用方式

1. 从「需求分析」开始，复制该提示词到 AI 工具，填入你的想法，得到需求文档。
2. 进入「功能实现」，把需求喂给 AI，得到代码。
3. 进入「代码审查」，让 AI 审查生成的代码，修复问题。
4. 进入「测试策略」，为功能设计测试用例。
5. 进入「部署检查」，发布前过一遍清单。

每一步的输出都可作为下一步的输入。
