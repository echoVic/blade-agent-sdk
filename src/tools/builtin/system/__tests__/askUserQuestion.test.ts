import { describe, expect, it, mock } from 'bun:test';
import type { ExecutionContext } from '../../../types/ExecutionTypes.js';
import { askUserQuestionTool } from '../askUserQuestion.js';

describe('AskUserQuestion Tool', () => {
  const createMockContext = (
    confirmationHandler?: ExecutionContext['confirmationHandler']
  ): Partial<ExecutionContext> => ({
    confirmationHandler,
  });

  const executeWithContext = async (
    params: Parameters<typeof askUserQuestionTool.build>[0],
    context: Partial<ExecutionContext>
  ) => {
    const invocation = askUserQuestionTool.build(params);
    return invocation.execute(new AbortController().signal, undefined, context);
  };

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(askUserQuestionTool.name).toBe('AskUserQuestion');
    });

    it('should have correct displayName', () => {
      expect(askUserQuestionTool.displayName).toBe('Ask User Question');
    });

    it('should have function declaration', () => {
      const declaration = askUserQuestionTool.getFunctionDeclaration();
      expect(declaration.name).toBe('AskUserQuestion');
      expect(declaration.description).toBeDefined();
      expect(declaration.parameters).toBeDefined();
    });
  });

  describe('execute', () => {
    it('should return error when no confirmation handler', async () => {
      const context = createMockContext();
      const result = await executeWithContext(
        {
          questions: [
            {
              question: 'Which framework?',
              header: 'Framework',
              multiSelect: false,
              options: [
                { label: 'React', description: 'Popular UI library' },
                { label: 'Vue', description: 'Progressive framework' },
              ],
            },
          ],
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.llmContent).toContain('No confirmation handler');
    });

    it('should return cancelled when user cancels', async () => {
      const mockHandler = {
        requestConfirmation: mock(() => Promise.resolve({ approved: false })),
      };
      const context = createMockContext(mockHandler);

      const result = await executeWithContext(
        {
          questions: [
            {
              question: 'Which framework?',
              header: 'Framework',
              multiSelect: false,
              options: [
                { label: 'React', description: 'Popular UI library' },
                { label: 'Vue', description: 'Progressive framework' },
              ],
            },
          ],
        },
        context
      );

      expect(result.success).toBe(true);
      expect(result.llmContent).toContain('cancelled');
      expect(result.metadata?.cancelled).toBe(true);
    });

    it('should return answers when user provides them', async () => {
      const mockHandler = {
        requestConfirmation: mock(() =>
          Promise.resolve({
            approved: true,
            answers: { Framework: 'React' },
          })
        ),
      };
      const context = createMockContext(mockHandler);

      const result = await executeWithContext(
        {
          questions: [
            {
              question: 'Which framework?',
              header: 'Framework',
              multiSelect: false,
              options: [
                { label: 'React', description: 'Popular UI library' },
                { label: 'Vue', description: 'Progressive framework' },
              ],
            },
          ],
        },
        context
      );

      expect(result.success).toBe(true);
      expect(result.llmContent).toContain('Framework: React');
      expect(result.metadata?.answers).toEqual({ Framework: 'React' });
    });

    it('should handle multi-select answers', async () => {
      const mockHandler = {
        requestConfirmation: mock(() =>
          Promise.resolve({
            approved: true,
            answers: { Features: ['TypeScript', 'ESLint'] },
          })
        ),
      };
      const context = createMockContext(mockHandler);

      const result = await executeWithContext(
        {
          questions: [
            {
              question: 'Which features?',
              header: 'Features',
              multiSelect: true,
              options: [
                { label: 'TypeScript', description: 'Type safety' },
                { label: 'ESLint', description: 'Linting' },
                { label: 'Prettier', description: 'Formatting' },
              ],
            },
          ],
        },
        context
      );

      expect(result.success).toBe(true);
      expect(result.llmContent).toContain('TypeScript, ESLint');
    });

    it('should handle ACP mode (approved but no answers)', async () => {
      const mockHandler = {
        requestConfirmation: mock(() =>
          Promise.resolve({
            approved: true,
            answers: {},
          })
        ),
      };
      const context = createMockContext(mockHandler);

      const result = await executeWithContext(
        {
          questions: [
            {
              question: 'Which framework?',
              header: 'Framework',
              multiSelect: false,
              options: [
                { label: 'React', description: 'Popular UI library' },
                { label: 'Vue', description: 'Progressive framework' },
              ],
            },
          ],
        },
        context
      );

      expect(result.success).toBe(true);
      expect(result.llmContent).toContain('approved but no answers');
      expect(result.metadata?.acpMode).toBe(true);
    });

    it('should handle confirmation handler errors', async () => {
      const mockHandler = {
        requestConfirmation: mock(() => Promise.reject(new Error('Handler failed'))),
      };
      const context = createMockContext(mockHandler);

      const result = await executeWithContext(
        {
          questions: [
            {
              question: 'Which framework?',
              header: 'Framework',
              multiSelect: false,
              options: [
                { label: 'React', description: 'Popular UI library' },
                { label: 'Vue', description: 'Progressive framework' },
              ],
            },
          ],
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.llmContent).toContain('Failed to ask user questions');
      expect(result.error).toBeDefined();
    });

    it('should pass correct confirmation request', async () => {
      const mockHandler = {
        requestConfirmation: mock(() =>
          Promise.resolve({
            approved: true,
            answers: { Framework: 'React' },
          })
        ),
      };
      const context = createMockContext(mockHandler);

      const questions = [
        {
          question: 'Which framework?',
          header: 'Framework',
          multiSelect: false,
          options: [
            { label: 'React', description: 'Popular UI library' },
            { label: 'Vue', description: 'Progressive framework' },
          ],
        },
      ];

      await executeWithContext({ questions }, context);

      expect(mockHandler.requestConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'askUserQuestion',
          questions,
        })
      );
    });
  });
});
