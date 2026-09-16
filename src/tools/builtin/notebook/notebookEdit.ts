import { readFile, writeFile } from 'node:fs/promises';
import Type from 'typebox';
import { ToolKind } from '../../behavior.js';
import { createTool } from '../../core/createTool.js';
import { ToolErrorType, type ToolResult } from '../../types/result.js';
import { ToolSchemas } from '../../validation/toolSchemas.js';
import { filePermission, operationFailure, validateFilePath } from '../file/operationCore.js';

interface NotebookCell {
  id?: string;
  cell_type: 'code' | 'markdown';
  source: string[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: unknown[];
}

interface Notebook {
  cells: NotebookCell[];
  [key: string]: unknown;
}

export const notebookEditTool = createTool({
  name: 'NotebookEdit',
  group: 'filesystem',
  displayName: 'Notebook Edit',
  kind: ToolKind.Write,
  sideEffect: 'non_idempotent',
  schema: Type.Object({
    notebook_path: ToolSchemas.filePath({ description: 'Absolute Jupyter notebook path' }),
    cell_id: Type.Optional(Type.String({ description: 'Cell ID to edit or insertion anchor' })),
    new_source: Type.String({ description: 'New cell source' }),
    cell_type: Type.Optional(Type.Enum(['code', 'markdown'])),
    edit_mode: Type.Enum(['replace', 'insert', 'delete'], {
      default: 'replace',
      description: 'Cell operation',
    }),
  }),
  resolveBehavior: (params) => {
    const mode = params?.edit_mode ?? 'replace';
    return {
      kind: ToolKind.Write,
      sideEffect: mode === 'replace' ? 'idempotent' : 'non_idempotent',
      isReadOnly: false,
      isConcurrencySafe: false,
      isDestructive: mode === 'delete',
    };
  },
  validateInput: (params, context) => validateFilePath(params, 'notebook_path', context),
  description: {
    short: 'Replace, insert, or delete a Jupyter notebook cell',
  },
  async *execute(params) {
    const {
      notebook_path: notebookPath,
      cell_id: cellId,
      new_source: newSource,
      cell_type: cellType,
      edit_mode: mode,
    } = params;
    try {
      const notebook = parseNotebook(await readFile(notebookPath, 'utf8'));
      if (!notebook) return invalid('Invalid notebook format: no cells array found');
      const index = cellId ? notebook.cells.findIndex((cell) => cell.id === cellId) : -1;
      if (cellId && index < 0 && mode !== 'insert') {
        return invalid(`Cell with ID "${cellId}" not found`);
      }

      if (mode === 'replace') {
        if (index < 0) return invalid('Cell ID required for replace operation');
        notebook.cells[index].source = splitSource(newSource);
        if (cellType) notebook.cells[index].cell_type = cellType;
      } else if (mode === 'insert') {
        if (!cellType) return invalid('cell_type is required for insert operation');
        notebook.cells.splice(index + 1, 0, {
          cell_type: cellType,
          source: splitSource(newSource),
          metadata: {},
          ...(cellType === 'code' ? { execution_count: null, outputs: [] } : {}),
        });
      } else {
        if (index < 0) return invalid('Cell ID required for delete operation');
        notebook.cells.splice(index, 1);
      }

      await writeFile(notebookPath, JSON.stringify(notebook, null, 2));
      const action = mode === 'replace' ? 'replaced' : mode === 'insert' ? 'inserted' : 'deleted';
      return {
        status: 'success',
        model: `Successfully ${action} cell in ${notebookPath}`,
        metadata: {
          summary: `编辑 Notebook: ${mode}`,
          notebook_path: notebookPath,
          edit_mode: mode,
          cell_id: cellId,
        },
      };
    } catch (error) {
      return operationFailure('Notebook edit', error, 'Notebook edit aborted');
    }
  },
  preparePermissionMatcher: ({ notebook_path }) => filePermission(notebook_path),
});

function parseNotebook(text: string): Notebook | undefined {
  const value: unknown = JSON.parse(text);
  return value && typeof value === 'object' && Array.isArray((value as Notebook).cells)
    ? (value as Notebook)
    : undefined;
}

function splitSource(source: string): string[] {
  return source
    .split('\n')
    .map((line, index, lines) => (index < lines.length - 1 ? `${line}\n` : line));
}

function invalid(message: string): ToolResult {
  return {
    status: 'error',
    model: message,
    error: { type: ToolErrorType.VALIDATION_ERROR, message },
    metadata: { summary: 'Notebook 编辑失败' },
  };
}
