import { defineConfig } from 'vitepress'

const repository = 'https://github.com/echoVic/blade-agent-sdk'
const editPattern = `${repository}/edit/main/docs/:path`

const zhSidebar = [
  {
    text: '入门',
    items: [
      { text: '概览', link: '/blade-agent-sdk' },
      { text: 'Provider 与日志', link: '/providers' },
    ],
  },
  {
    text: '核心功能',
    items: [
      { text: 'Session 会话', link: '/session' },
      { text: 'Server Runtime', link: '/server-runtime' },
      { text: 'Runtime Store', link: '/runtime-store' },
      { text: 'Worker Runtime', link: '/worker-runtime' },
      { text: 'Execution Host', link: '/execution-host' },
      { text: 'Durable Event Store', link: '/durable-events' },
      { text: '工具系统', link: '/tools' },
      { text: '权限控制', link: '/permissions' },
      { text: 'Middleware 与插件', link: '/middleware' },
      { text: 'Hooks 生命周期', link: '/hooks' },
      { text: '类型架构', link: '/type-architecture' },
    ],
  },
  {
    text: '扩展能力',
    items: [
      { text: 'MCP 协议集成', link: '/mcp' },
      { text: 'Sandbox 沙箱', link: '/sandbox' },
      { text: '子 Agent', link: '/agents' },
      { text: 'Skills 系统', link: '/skills' },
    ],
  },
  {
    text: '参考',
    items: [
      { text: 'API 参考', link: '/api-reference' },
      { text: '常见模式', link: '/recipes' },
    ],
  },
]

const enSidebar = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Overview', link: '/en/blade-agent-sdk' },
      { text: 'Providers and Logging', link: '/en/providers' },
    ],
  },
  {
    text: 'Core',
    items: [
      { text: 'Session', link: '/en/session' },
      { text: 'Server Runtime', link: '/en/server-runtime' },
      { text: 'Runtime Store', link: '/en/runtime-store' },
      { text: 'Worker Runtime', link: '/en/worker-runtime' },
      { text: 'Execution Host', link: '/en/execution-host' },
      { text: 'Durable Event Store', link: '/en/durable-events' },
      { text: 'Tools', link: '/en/tools' },
      { text: 'Permissions', link: '/en/permissions' },
      { text: 'Middleware and Plugins', link: '/en/middleware' },
      { text: 'Hooks', link: '/en/hooks' },
      { text: 'Type Architecture', link: '/en/type-architecture' },
    ],
  },
  {
    text: 'Extensions',
    items: [
      { text: 'MCP Integration', link: '/en/mcp' },
      { text: 'Sandbox', link: '/en/sandbox' },
      { text: 'Subagents', link: '/en/agents' },
      { text: 'Skills', link: '/en/skills' },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'API Reference', link: '/en/api-reference' },
      { text: 'Recipes', link: '/en/recipes' },
    ],
  },
]

export default defineConfig({
  base: '/blade-agent-sdk/',
  lastUpdated: true,
  srcExclude: [
    'deepseek-api-research.md',
    'simplification-audit.md',
    'superpowers/**',
  ],
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'Blade Agent SDK',
      description: '构建 AI Agent 应用的 TypeScript SDK',
      themeConfig: {
        nav: [
          { text: '指南', link: '/blade-agent-sdk' },
          { text: 'API', link: '/api-reference' },
          { text: 'GitHub', link: repository },
        ],
        sidebar: zhSidebar,
        outline: { level: [2, 3], label: '目录' },
        editLink: {
          pattern: editPattern,
          text: '在 GitHub 上编辑此页',
        },
        lastUpdated: { text: '最后更新于' },
        docFooter: { prev: '上一页', next: '下一页' },
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      title: 'Blade Agent SDK',
      description: 'A TypeScript SDK for building AI agent applications',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/en/blade-agent-sdk' },
          { text: 'API', link: '/en/api-reference' },
          { text: 'GitHub', link: repository },
        ],
        sidebar: enSidebar,
        outline: { level: [2, 3], label: 'On this page' },
        editLink: {
          pattern: editPattern,
          text: 'Edit this page on GitHub',
        },
        lastUpdated: { text: 'Last updated' },
        docFooter: { prev: 'Previous page', next: 'Next page' },
      },
    },
  },
  themeConfig: {
    socialLinks: [{ icon: 'github', link: repository }],
    search: { provider: 'local' },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present Blade AI',
    },
  },
})
