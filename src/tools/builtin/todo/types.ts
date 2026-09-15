import Type from 'typebox';

/**
 * TODO 任务状态
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/**
 * TODO 任务优先级
 */
export type TodoPriority = 'high' | 'medium' | 'low';

/**
 * TODO 任务项
 */
export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm: string;
  priority: TodoPriority;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

/**
 * TODO 任务输入 Schema（用于验证）
 */
export const TodoItemSchema = Type.Object({
  id: Type.Optional(Type.String()),
  content: Type.String({ minLength: 1 }),
  status: Type.Enum(['pending', 'in_progress', 'completed']),
  activeForm: Type.String({ minLength: 1 }),
  priority: Type.Enum(['high', 'medium', 'low'], { default: 'medium' }),
});

/**
 * TODO 统计信息
 */
export interface TodoStats {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}

/**
 * 验证结果
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}
