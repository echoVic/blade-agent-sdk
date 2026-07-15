import { z } from 'zod';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export type TodoPriority = 'high' | 'medium' | 'low';

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

export const TodoItemSchema = z.object({
  id: z.string().optional(),
  content: z.string().min(1, 'Content cannot be empty'),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().min(1, 'ActiveForm cannot be empty'),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
});

export interface TodoStats {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}
