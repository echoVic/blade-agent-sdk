# Changelog

本文件记录 @blade-ai/agent-sdk 的所有重要变更。

## [0.1.7] - 2026-02-12

- 6b9f68c feat: export modelDetection utilities (detectThinkingSupport, getThinkingConfig, isThinkingModel)
## [0.1.6] - 2026-02-12

- d3708fe chore: update bun.lock
- d3754d3 fix: connectServer/reconnectServer 成功后显式设置 CONNECTED 状态
- 3acf9f2 feat(mcp): 添加对进程内MCP服务器的支持
- 8e01a9f test: 添加多个测试文件覆盖核心功能模块
- bf48a2f docs: 添加文档文件并更新README
## [0.1.5] - 2026-02-08

- 无相关变更
## [0.1.4] - 2026-02-08

- e65fad4 feat(session): 添加会话分叉功能
- 8e55094 feat(文件检查点): 实现文件变更追踪和回滚功能
- 81d5cd1 feat(沙箱): 添加沙箱执行功能和安全检查
- 922d33c feat(mcp): 添加 MCP 资源管理工具
- 7102e51 feat(agent): 添加结构化输出格式支持
- fbf2437 feat(发布脚本): 为发布流程添加详细的步骤日志输出
## [0.1.3] - 2026-02-08

- 19c017b refactor(mcp): 重构MCP模块并移除废弃的Copilot和Antigravity服务
## [0.1.2] - 2026-02-08

- 25eacfe refactor(agent): 重构事件处理机制，使用统一的事件流接口
- e8c7ebf test: 添加多个测试文件包括HookConfig、TokenCounter、路径安全、Matcher、工具创建和输出解析
## [0.1.1] - 2026-02-08

- 3121d6c feat(hooks): 新增 SubagentStart 和 TaskCompleted 钩子事件
## [0.1.0] - 2026-02-08

- 无相关变更
## [Unreleased]

- 暂无

## [0.0.1] - 2026-02-08

- 初始发布
