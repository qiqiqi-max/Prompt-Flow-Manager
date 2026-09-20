---
title: TypeScript 严格类型工程规约
stage: snippets
projectType: 其他
tags: [规约, TypeScript, 类型安全]
description: TypeScript 严格模式配置、零 any 与类型收敛规约
version: 1
---

## 工程规约：TypeScript 严格类型与静态安全

在编写 TypeScript 代码时，必须恪守以下规约：
1. **严格模式基线**：开启 `strict: true`、`noImplicitAny: true`、`strictNullChecks: true`。
2. **禁止裸 `any`**：
   - 严禁使用 `any` 绕过编译器检查；不确定类型时使用 `unknown` 并配合类型守卫（Type Guard）或 Zod 校验。
   - 禁止盲目使用非空断言操作符（`!`），优先进行显式可选链（`?.`）或判空兜底。
3. **类型收敛与判别联合**：
   - 多状态对象必须使用带判别字段的联合类型（Discriminated Unions），结合 `switch(type)` 实现穷尽性检查（Exhaustiveness check）。
4. **类型导出原则**：
   - 公共 API 与数据结构必须显式声明返回类型与参数类型，不可依赖深度推断。
