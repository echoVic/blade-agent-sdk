import { z } from 'zod';
import { createTool, ToolErrorType, ToolKind } from '../../tools/index.js';
import type { ToolResult } from '../../tools/types/index.js';

/**
 * EnterPlanMode tool
 * Requests user permission to enter Plan mode for complex tasks
 */
export function createEnterPlanModeTool() {
  return createTool({
  name: 'EnterPlanMode',
  displayName: 'Enter Plan Mode',
  kind: ToolKind.ReadOnly,

  schema: z.object({}),

  description: {
    short:
      'Use this tool to enter plan mode for complex tasks requiring careful planning',
    long: `Use this tool when you encounter a complex task that requires careful planning and exploration before implementation. This tool transitions you into plan mode where you can thoroughly explore the codebase and design an implementation approach.

## When to Use This Tool

Use EnterPlanMode when ANY of these conditions apply:

1. **Multiple Valid Approaches**: The task can be solved in several different ways, each with trade-offs
2. **Significant Architectural Decisions**: The task requires choosing between architectural patterns
3. **Large-Scale Changes**: The task touches many files or systems
4. **Unclear Requirements**: You need to explore before understanding the full scope
5. **User Input Needed**: You'll need to ask clarifying questions before starting

## When NOT to Use This Tool

Do NOT use EnterPlanMode for:
- Simple, straightforward tasks with obvious implementation
- Small bug fixes where the solution is clear
- Adding a single function or small feature

## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using Glob, Grep, and Read tools
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Exit plan mode with ExitPlanMode when ready to implement`,
  },

  async execute(_params, context): Promise<ToolResult> {
    if (context.confirmationHandler) {
      try {
        const response = await context.confirmationHandler.requestConfirmation({
          type: 'enterPlanMode',
          message:
            'The assistant requests to enter Plan mode for this complex task.',
          details: 'Plan mode enables systematic research before implementation',
        });

        if (response.approved) {
          return {
            success: true,
            llmContent:
              '✅ User approved entering Plan mode.\n\n' +
              'You are now in PLAN MODE. Remember:\n' +
              '- Use ONLY read-only tools: Read, Glob, Grep, WebFetch, WebSearch, Task\n' +
              '- DO NOT use Edit, Write, Bash, or any file-modifying tools\n' +
              '- When your research is complete, call ExitPlanMode with your implementation plan\n' +
              '- For pure research questions, answer directly without ExitPlanMode\n\n' +
              'Begin your research now.',
            metadata: {
              summary: '进入计划模式',
              approved: true,
              enterPlanMode: true,
            },
          };
        } else {
          return {
            success: true,
            llmContent: '⚠️ User declined to enter Plan mode.',
            metadata: {
              summary: '计划模式被拒绝',
              approved: false,
              enterPlanMode: false,
            },
          };
        }
      } catch (error) {
        return {
          success: false,
          llmContent: `Confirmation flow error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'Confirmation flow error',
          },
          metadata: { summary: '确认失败' },
        };
      }
    }

    return {
      success: true,
      llmContent: 'Plan mode requested but no interactive confirmation available.',
      metadata: {
        summary: '进入计划模式',
        approved: null,
        enterPlanMode: true,
      },
    };
  },
  });
}

export const enterPlanModeTool = createEnterPlanModeTool();
