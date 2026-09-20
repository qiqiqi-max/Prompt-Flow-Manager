---
title: FastAPI 后端技术栈规范
stage: snippets
projectType: 后端项目
tags: [后端, Python, FastAPI, Pydantic]
description: Python + FastAPI + Pydantic + SQLAlchemy 现代异步后端规范
version: 1
---

## 技术栈规范：Python + FastAPI + Pydantic 异步后端

在设计与实现后端服务时，遵循以下规范：
1. **类型安全与 Schema 约束**：
   - 所有请求 Body、Query 参数与返回结构体必须定义强类型 `pydantic.BaseModel`。
   - 禁止在业务函数中传递无校验的裸 `dict`。
2. **异步与 I/O 设计**：
   - 数据库操作使用异步驱动（如 `asyncpg` / `aiosqlite`），文件 I/O 走 `anyio` 或线程池。
   - 绝不在 `async def` 路由中调用阻塞型同步操作（如 `time.sleep`、同步 `requests`）。
3. **依赖注入与分层解耦**：
   - 统一使用 FastAPI 的 `Depends` 提供数据库会话、当前用户与配置对象。
   - 严格区分 Router 路由层、Service 业务逻辑层与 CRUD 数据访问层。
4. **统一错误响应**：
   - 定义全局异常处理器，将业务异常序列化为统一 JSON 错误结构（`{"code": "...", "message": "...", "detail": ...}`）。
