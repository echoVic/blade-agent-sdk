import { describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../../../types/json.js';
import type { ExecutionContext } from '../../../types/execution.js';
import { collectToolExecution } from '../../../types/result.js';
import { askUserQuestionTool } from '../askUserQuestion.js';

describe('AskUserQuestion Tool', () => {
  const createMockContext = (
    confirmationHandler?: ExecutionContext['confirmationHandler'],
  ): Partial<ExecutionContext> => ({
    confirmationHandler,
  });

  const executeWithContext = async (params: JsonObject, context: Partial<ExecutionContext>) => {
    return collectToolExecution(askUserQuestionTool.execute(params, context));
  };

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(askUserQuestionTool.name).toBe('AskUserQuestion');
    });

    it('should have correct title', () => {
      expect(askUserQuestionTool.title).toBe('Ask User Question');
    });

    it('should have function declaration', () => {
      const declaration = askUserQuestionTool.declaration;
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
        context,
      );

      expect(result.status).toBe('error');
      expect(result.model).toContain('No confirmation handler');
    });

    it('should return cancelled when user cancels', async () => {
      const mockHandler = {
        requestConfirmation: vi.fn(() => Promise.resolve({ approved: false })),
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
        context,
      );

      expect(result.status).toBe('success');
      expect(result.model).toContain('cancelled');
      expect(result.metadata?.cancelled).toBe(true);
    });

    it('should return answers when user provides them', async () => {
      const mockHandler = {
        requestConfirmation: vi.fn(() =>
          Promise.resolve({
            approved: true,
            answers: { Framework: 'React' },
          }),
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
        context,
      );

      expect(result.status).toBe('success');
      expect(result.model).toContain('Framework: React');
      expect(result.metadata?.answers).toEqual({ Framework: 'React' });
    });

    it('should handle multi-select answers', async () => {
      const mockHandler = {
        requestConfirmation: vi.fn(() =>
          Promise.resolve({
            approved: true,
            answers: { Features: ['TypeScript', 'ESLint'] },
          }),
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
        context,
      );

      expect(result.status).toBe('success');
      expect(result.model).toContain('TypeScript, ESLint');
    });

    it('should handle approved but no answers', async () => {
      const mockHandler = {
        requestConfirmation: vi.fn(() =>
          Promise.resolve({
            approved: true,
            answers: {},
          }),
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
        context,
      );

      expect(result.status).toBe('success');
      expect(result.model).toContain('approved but no answers');
      expect(result.metadata?.noAnswersCollected).toBe(true);
    });

    it('should handle confirmation handler errors', async () => {
      const mockHandler = {
        requestConfirmation: vi.fn(() => Promise.reject(new Error('Handler failed'))),
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
        context,
      );

      expect(result.status).toBe('error');
      expect(result.model).toContain('Failed to ask user questions');
      expect(result.error).toBeDefined();
    });

    it('should pass correct confirmation request', async () => {
      const mockHandler = {
        requestConfirmation: vi.fn(() =>
          Promise.resolve({
            approved: true,
            answers: { Framework: 'React' },
          }),
        ),
      };
      const controller = new AbortController();
      const context = {
        ...createMockContext(mockHandler),
        signal: controller.signal,
      };

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
          abortSignal: controller.signal,
          questions,
        }),
      );
    });
  });
});
