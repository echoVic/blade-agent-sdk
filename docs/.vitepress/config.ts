import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Blade Agent SDK',
  description: '构建 AI Agent 应用的 TypeScript SDK',
  base: '/blade-agent-sdk/',
  lang: 'zh-CN',
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: '指南', link: '/blade-agent-sdk' },
      { text: 'API', link: '/api-reference' },
      { text: 'GitHub', link: 'https://github.com/echoVic/blade-agent-sdk' },
    ],
    sidebar: [
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
          { text: '工具系统', link: '/tools' },
          { text: '权限控制', link: '/permissions' },
          { text: 'Hooks 生命周期', link: '/hooks' },
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
          { text: 'DeepSeek API 调研', link: '/deepseek-api-research' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/echoVic/blade-agent-sdk' },
    ],
    outline: { level: [2, 3], label: '目录' },
    search: { provider: 'local' },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present Blade AI',
    },
    editLink: {
      pattern: 'https://github.com/echoVic/blade-agent-sdk/edit/main/docs/:path',
      text: '在 GitHub 上编辑此页',
    },
    lastUpdated: {
      text: '最后更新于',
    },
    docFooter: {
      prev: '上一页',
      next: '下一页',
    },
  },
})
