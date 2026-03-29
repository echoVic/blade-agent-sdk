# Changelog

本文件记录 @blade-ai/agent-sdk 的所有重要变更。

## [0.2.5] - 2026-03-29

- b38bd52 fix: harden release publish flow
## [0.2.4] - 2026-03-29

- c7d6778 build: migrate from bun to pnpm and vitest
- bea6b62 docs: refresh README overview
- 4db7cd2 docs: add linux.do link to README
## [0.2.3] - 2026-03-27

- 96bc8db refactor(权限模式): 移除 BYPASSALL 权限模式及相关文档
- 01c0e99 ci: 重新生成 bun.lock 使用公网 registry，去除所有内网依赖
- fd994f3 ci: 修复 CI registry 配置，使用公网 npm registry
- e91fde0 docs: 搭建 VitePress 文档站点并更新全部用户文档
## [0.2.2] - 2026-03-27

- f0fc8e6 refactor: 消除所有纯静态类以满足 biome noStaticOnlyClass 规则
- 83d915e fix(发布脚本): 修复推送远程仓库时标签推送的问题
## [0.2.1] - 2026-03-27

- 无相关变更
## [0.2.0] - 2026-03-26

- 7f20f3f feat(hooks): 扩展hook系统支持更多事件类型和控制流
- 5d29870 feat(skills): 增强技能系统功能并添加内联命令支持
- 6a84c05 refactor(skills): 移除内置skill-creator及相关逻辑
- 1fd3b8e refactor(skills): 移除 SkillInstaller 并简化技能加载逻辑
- 8816878 refactor(version): 移除版本检查服务及相关功能
- fd55a4d refactor(storage): 重构存储系统以支持自定义存储根目录
- 65128d3 refactor(chat-service): 移除内置API Key相关功能
- 3d3ee79 refactor(prompts): 重构系统提示构建逻辑，移除默认提示
- db00d74 chore: release v0.1.19
- dbc37a3 fix: pass registry to bun publish
- 99e9e7d chore: release v0.1.18
- 55242a6 fix: stabilize concurrent session logger routing
- 8e8f57c chore: switch repo workflow to bun
- a1d1de3 feat(session): 支持禁用会话持久化模式
## [0.1.19] - 2026-03-20

- dbc37a3 fix: pass registry to bun publish
## [0.1.18] - 2026-03-20

- 55242a6 fix: stabilize concurrent session logger routing
- 8e8f57c chore: switch repo workflow to bun
- a1d1de3 feat(session): 支持禁用会话持久化模式
## [0.1.17] - 2026-03-12

- f3eb08c fix: 移除对 process.cwd() 的隐式依赖，增强文件系统访问安全性
## [0.1.16] - 2026-03-12

- c17e79b feat: 重构运行时上下文管理，引入ContextSnapshot机制
## [0.1.15] - 2026-03-09

- 14ea476 test(SessionOpenAIConfig): 简化测试用例并移除不必要的模拟
- 986975f feat(openai): 添加原生OpenAI支持并透传自定义headers
## [0.1.14] - 2026-03-09

- 248bc0d ci: 固定Bun版本为1.2.22并清理依赖项
- 053498f refactor: 清理废弃模板和文档，优化导出结构
- 9b5cee9 refactor: 移除文件检查点功能及相关代码
- 88e7b25 refactor(Session): 添加初始化检查和方法封装
- 60d6d6e feat: 重构日志系统以支持依赖注入和隔离
- 886cab9 refactor: 移除插件系统和命令系统相关代码
- f515655 refactor: 移除 Spec 模式相关代码和功能
- 0fda735 fix: 修复类型断言和测试中的类型错误
- 951dcb2 feat(mcp): 增强 JSON Schema 到 Zod 的转换功能
- 4763724 refactor(agent): 重构代理循环逻辑并提取决策模块
- 7fc2f0e refactor(agent): 移除 ExecutionEngine 并重构上下文管理
- 7a86ef9 refactor(session): unify runtime ownership
- 455f3cc refactor: extract AGENT_TURN_SAFETY_LIMIT constant to reduce duplication
## [0.1.13] - 2026-02-28

- cc76545 feat: 添加 ProviderConfig 类型导出
## [0.1.12] - 2026-02-28

- 879e353 build: 添加构建类型声明配置并更新构建脚本
## [0.1.11] - 2026-02-28

- 722cd05 ci: 指定 npm registry 为官方源
## [0.1.10] - 2026-02-28

- 67a4890 feat: 添加错误处理工具函数并重构错误处理逻辑
- 381387f refactor(agent): 统一使用 AgentEvent 类型替代 AgentLoopEvent
## [0.1.9] - 2026-02-26

- 6e092f1 refactor: remove openai dep, split Agent.ts, McpRegistry per-instance, provider lazy import
## [0.1.8] - 2026-02-18

- 7e41a2d test: add unit tests for SkillLoader, ToolRegistry, ContextCompressor
- 318be66 test: add AgentLoop unit tests (20 cases)
- c345a5e refactor: remove dead executeLoopStream + clean unused imports
- d6d659d refactor: wire executeWithAgentLoop into Agent.ts (P0 step 2)
- d4b909b refactor: extract AgentLoop + standardize AgentEvent types (P0)
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
