import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { createTool, ToolErrorType, ToolKind } from '../../tools/index.js';
import type { ToolResult } from '../../tools/types/index.js';

/**
 * ExitPlanMode tool
 * Presents the full plan in Plan mode and requests user approval
 */
export function createExitPlanModeTool() {
  return createTool({
  name: 'ExitPlanMode',
  displayName: 'Exit Plan Mode',
  kind: ToolKind.ReadOnly,

  schema: z.object({
    plan: z.string().describe('The complete implementation plan in markdown format'),
  }),

  description: {
    short:
      'Use this tool when you are in plan mode and have finished creating your plan and are ready for user approval',
    long: `Use this tool when you are in plan mode and have finished creating your implementation plan and are ready for user approval.

## 🚨 PREREQUISITES (MUST be satisfied before calling)

1. ✅ You have created a complete implementation plan
2. ✅ You have OUTPUT TEXT to explain your plan to the user (not just tool calls)
3. ✅ The plan includes: summary, implementation steps, affected files, testing method

## How This Tool Works
- Pass your complete implementation plan as the 'plan' parameter
- This tool will present your plan to the user for review and approval`,
  },

  async execute(params, context): Promise<ToolResult> {
    const planContent = params.plan || '';

    const plansDirectory = context.bladeConfig?.plansDirectory;
    if (planContent && context.sessionId && plansDirectory) {
      try {
        await fs.mkdir(plansDirectory, { recursive: true, mode: 0o755 });
        const planPath = path.join(plansDirectory, `plan_${context.sessionId}.md`);
        await fs.writeFile(planPath, planContent, 'utf-8');
      } catch (error) {
        console.warn('Failed to save plan file:', error);
      }
    }

    if (context.confirmationHandler) {
      try {
        const response = await context.confirmationHandler.requestConfirmation({
          type: 'exitPlanMode',
          message:
            'The assistant has finished planning and is ready for your review.\n\n' +
            '⚠️ Before approving, please verify:\n' +
            '1. The assistant has written a detailed plan to the plan file\n' +
            '2. The plan includes implementation steps, affected files, and testing methods\n' +
            '3. You have seen text explanations from the assistant (not just tool calls)\n\n' +
            'If the assistant only made tool calls without presenting a plan summary,\n' +
            'please reject and ask for a proper plan.',
          details:
            'After approval, the assistant will exit Plan mode and begin implementation.',
          planContent: planContent || undefined,
        });

        if (response.approved) {
          return {
            success: true,
            llmContent:
              '✅ Plan approved by user. Plan mode exited; you can proceed to code changes.',
            metadata: {
              summary: '计划已批准',
              approved: true,
              shouldExitLoop: true,
              targetMode: response.targetMode,
              planContent: planContent,
            },
          };
        } else {
          return {
            success: true,
            llmContent:
              '⚠️ Plan rejected by user. Awaiting user feedback.\n\n' +
              (response.feedback || 'No specific feedback provided.') +
              '\n\nThe agent has stopped and control is returned to the user.',
            metadata: {
              summary: '计划被拒绝',
              approved: false,
              shouldExitLoop: true,
              feedback: response.feedback,
              awaitingUserInput: true,
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
      llmContent:
        '✅ Plan mode exit requested. No interactive confirmation available.\n' +
        'Proceeding with implementation.',
      metadata: {
        summary: '退出计划模式',
        approved: null,
      },
    };
  },
  });
}

export const exitPlanModeTool = createExitPlanModeTool();
