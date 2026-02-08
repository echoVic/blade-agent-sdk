import { nanoid } from 'nanoid';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { SpecFileManager } from './SpecFileManager.js';
import {
  PHASE_TRANSITIONS,
  type SpecListItem,
  type SpecMetadata,
  type SpecOperationResult,
  type SpecPhase,
  type SpecSearchOptions,
  type SpecTask,
  type SpecValidationResult,
  type SteeringContext,
  type TaskComplexity,
  type TaskStatus,
} from './types.js';

const logger = createLogger(LogCategory.SPEC);

export interface SpecState {
  currentSpec: SpecMetadata | null;
  specPath: string | null;
  isActive: boolean;
  recentSpecs: string[];
  steeringContext: SteeringContext | null;
}

export class SpecManager {
  private static instance: SpecManager | null = null;
  private fileManager: SpecFileManager | null = null;
  private state: SpecState = {
    currentSpec: null,
    specPath: null,
    isActive: false,
    recentSpecs: [],
    steeringContext: null,
  };
  private stateChangeCallbacks: Array<(state: SpecState) => void> = [];

  private constructor() {}

  static getInstance(): SpecManager {
    if (!SpecManager.instance) {
      SpecManager.instance = new SpecManager();
    }
    return SpecManager.instance;
  }

  static resetInstance(): void {
    SpecManager.instance = null;
  }

  onStateChange(callback: (state: SpecState) => void): () => void {
    this.stateChangeCallbacks.push(callback);
    return () => {
      const index = this.stateChangeCallbacks.indexOf(callback);
      if (index > -1) {
        this.stateChangeCallbacks.splice(index, 1);
      }
    };
  }

  private notifyStateChange(): void {
    for (const callback of this.stateChangeCallbacks) {
      callback(this.state);
    }
  }

  private updateState(updates: Partial<SpecState>): void {
    this.state = { ...this.state, ...updates };
    this.notifyStateChange();
  }

  async initialize(workspaceRoot: string): Promise<void> {
    if (this.fileManager) {
      logger.debug('SpecManager already initialized, skipping...');
      return;
    }

    this.fileManager = new SpecFileManager(workspaceRoot);
    await this.fileManager.initializeDirectories();

    const steeringContext = await this.fileManager.readSteeringContext();
    this.updateState({ steeringContext });

    logger.debug('SpecManager initialized successfully');
  }

  getFileManager(): SpecFileManager {
    if (!this.fileManager) {
      throw new Error('SpecManager not initialized. Call initialize() first.');
    }
    return this.fileManager;
  }

  getState(): SpecState {
    return { ...this.state };
  }

  getCurrentSpec(): SpecMetadata | null {
    return this.state.currentSpec;
  }

  isActive(): boolean {
    return this.state.isActive;
  }

  getSteeringContext(): SteeringContext | null {
    return this.state.steeringContext;
  }

  async getSteeringContextString(): Promise<string | null> {
    const ctx = this.state.steeringContext;
    if (!ctx) return null;

    const parts: string[] = [];

    if (ctx.constitution) {
      parts.push(`## Constitution (Project Governance)\n\n${ctx.constitution}`);
    }
    if (ctx.product) {
      parts.push(`## Product Vision\n\n${ctx.product}`);
    }
    if (ctx.tech) {
      parts.push(`## Technology Stack\n\n${ctx.tech}`);
    }
    if (ctx.structure) {
      parts.push(`## Code Structure\n\n${ctx.structure}`);
    }

    return parts.length > 0 ? parts.join('\n\n---\n\n') : null;
  }

  async createSpec(name: string, description: string): Promise<SpecOperationResult> {
    const fm = this.getFileManager();

    if (await fm.changeExists(name)) {
      return {
        success: false,
        message: `Spec "${name}" already exists`,
        error: 'SPEC_EXISTS',
      };
    }

    const changePath = await fm.createChangeDir(name);
    const metadata = fm.createMetadata(name, description);
    await fm.writeMetadata(name, metadata);

    const proposalContent = this.generateProposalTemplate(name, description);
    await fm.writeSpecFile(name, 'proposal', proposalContent);

    const recentSpecs = this.state.recentSpecs.filter((n: string) => n !== name);
    recentSpecs.unshift(name);

    this.updateState({
      currentSpec: metadata,
      specPath: changePath,
      isActive: true,
      recentSpecs: recentSpecs.slice(0, 10),
    });

    return {
      success: true,
      message: `Spec "${name}" created successfully`,
      data: {
        spec: metadata,
        path: changePath,
      },
    };
  }

  async loadSpec(name: string): Promise<SpecOperationResult> {
    const fm = this.getFileManager();

    const metadata = await fm.readMetadata(name);
    if (!metadata) {
      return {
        success: false,
        message: `Spec "${name}" not found`,
        error: 'SPEC_NOT_FOUND',
      };
    }

    const changePath = fm.getChangePath(name);

    const recentSpecs = this.state.recentSpecs.filter((n: string) => n !== name);
    recentSpecs.unshift(name);

    this.updateState({
      currentSpec: metadata,
      specPath: changePath,
      isActive: true,
      recentSpecs: recentSpecs.slice(0, 10),
    });

    return {
      success: true,
      message: `Spec "${name}" loaded successfully`,
      data: {
        spec: metadata,
        path: changePath,
      },
    };
  }

  closeSpec(): void {
    this.updateState({
      currentSpec: null,
      specPath: null,
      isActive: false,
    });
  }

  exitSpecMode(): void {
    this.closeSpec();
  }

  async transitionPhase(targetPhase: SpecPhase): Promise<SpecOperationResult> {
    const current = this.getCurrentSpec();
    if (!current) {
      return {
        success: false,
        message: 'No active spec',
        error: 'NO_ACTIVE_SPEC',
      };
    }

    const allowedTransitions = PHASE_TRANSITIONS[current.phase];
    if (!allowedTransitions.includes(targetPhase)) {
      return {
        success: false,
        message: `Cannot transition from "${current.phase}" to "${targetPhase}"`,
        error: 'INVALID_TRANSITION',
      };
    }

    const fm = this.getFileManager();
    const updated = await fm.updatePhase(current.name, targetPhase);
    if (!updated) {
      return {
        success: false,
        message: 'Failed to update phase',
        error: 'UPDATE_FAILED',
      };
    }

    this.updateState({
      currentSpec: updated,
    });

    if (targetPhase === 'done') {
      logger.info('Spec completed');
    }

    return {
      success: true,
      message: `Transitioned to "${targetPhase}" phase`,
      data: {
        spec: updated,
        phase: targetPhase,
      },
    };
  }

  getAllowedTransitions(): SpecPhase[] {
    const current = this.getCurrentSpec();
    if (!current) return [];
    return PHASE_TRANSITIONS[current.phase];
  }

  async addTask(
    title: string,
    description: string,
    options?: {
      dependencies?: string[];
      affectedFiles?: string[];
      complexity?: TaskComplexity;
    }
  ): Promise<SpecOperationResult> {
    const current = this.getCurrentSpec();
    if (!current) {
      return {
        success: false,
        message: 'No active spec',
        error: 'NO_ACTIVE_SPEC',
      };
    }

    const task: SpecTask = {
      id: nanoid(8),
      title,
      description,
      status: 'pending',
      dependencies: options?.dependencies || [],
      affectedFiles: options?.affectedFiles || [],
      complexity: options?.complexity || 'medium',
    };

    const updatedSpec: SpecMetadata = {
      ...current,
      tasks: [...current.tasks, task],
      updatedAt: new Date().toISOString(),
    };

    await this.getFileManager().writeMetadata(current.name, updatedSpec);

    this.updateState({
      currentSpec: updatedSpec,
    });

    return {
      success: true,
      message: `Task "${title}" added`,
      data: { task },
    };
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskStatus
  ): Promise<SpecOperationResult> {
    const current = this.getCurrentSpec();
    if (!current) {
      return {
        success: false,
        message: 'No active spec',
        error: 'NO_ACTIVE_SPEC',
      };
    }

    const task = current.tasks.find((t) => t.id === taskId);
    if (!task) {
      return {
        success: false,
        message: `Task "${taskId}" not found`,
        error: 'TASK_NOT_FOUND',
      };
    }

    const updatedTask: SpecTask = {
      ...task,
      status,
      completedAt: status === 'completed' ? new Date().toISOString() : task.completedAt,
    };

    const updatedTasks = current.tasks.map((t) => (t.id === taskId ? updatedTask : t));

    const updatedSpec: SpecMetadata = {
      ...current,
      tasks: updatedTasks,
      currentTaskId:
        status === 'in_progress'
          ? taskId
          : current.currentTaskId === taskId
            ? undefined
            : current.currentTaskId,
      updatedAt: new Date().toISOString(),
    };

    await this.getFileManager().writeMetadata(current.name, updatedSpec);

    this.updateState({
      currentSpec: updatedSpec,
    });

    return {
      success: true,
      message: `Task status updated to "${status}"`,
      data: { task: updatedTask },
    };
  }

  getNextTask(): SpecTask | null {
    const current = this.getCurrentSpec();
    if (!current) return null;

    return (
      current.tasks.find((task) => {
        if (task.status !== 'pending') return false;

        return task.dependencies.every((depId) => {
          const dep = current.tasks.find((t) => t.id === depId);
          return dep?.status === 'completed';
        });
      }) || null
    );
  }

  getTaskProgress(): { total: number; completed: number; percentage: number } {
    const current = this.getCurrentSpec();
    if (!current || current.tasks.length === 0) {
      return { total: 0, completed: 0, percentage: 0 };
    }

    const total = current.tasks.length;
    const completed = current.tasks.filter((t) => t.status === 'completed').length;
    const percentage = Math.round((completed / total) * 100);

    return { total, completed, percentage };
  }

  async listSpecs(options?: SpecSearchOptions): Promise<SpecListItem[]> {
    const fm = this.getFileManager();
    const items: SpecListItem[] = [];

    const activeNames = await fm.listActiveChanges();
    for (const name of activeNames) {
      const metadata = await fm.readMetadata(name);
      if (!metadata) continue;

      if (options?.phase && metadata.phase !== options.phase) continue;
      if (options?.tags && !options.tags.some((tag) => metadata.tags?.includes(tag))) {
        continue;
      }
      if (
        options?.query &&
        !metadata.name.toLowerCase().includes(options.query.toLowerCase()) &&
        !metadata.description.toLowerCase().includes(options.query.toLowerCase())
      ) {
        continue;
      }

      const progress = this.calculateTaskProgress(metadata.tasks);
      items.push({
        name: metadata.name,
        description: metadata.description,
        phase: metadata.phase,
        updatedAt: metadata.updatedAt,
        path: fm.getChangePath(name),
        isArchived: false,
        taskProgress: progress,
      });
    }

    if (options?.includeArchived) {
      const archivedNames = await fm.listArchivedChanges();
      for (const name of archivedNames) {
        items.push({
          name,
          description: '(archived)',
          phase: 'done',
          updatedAt: '',
          path: `${fm.getArchiveDir()}/${name}`,
          isArchived: true,
          taskProgress: { total: 0, completed: 0 },
        });
      }
    }

    items.sort((a, b) => {
      if (a.isArchived !== b.isArchived) {
        return a.isArchived ? 1 : -1;
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    return items;
  }

  async archiveCurrentSpec(): Promise<SpecOperationResult> {
    const current = this.getCurrentSpec();
    if (!current) {
      return {
        success: false,
        message: 'No active spec',
        error: 'NO_ACTIVE_SPEC',
      };
    }

    const fm = this.getFileManager();

    await fm.mergeSpecDeltas(current.name);
    await fm.updatePhase(current.name, 'done');
    await fm.archiveChange(current.name);

    this.closeSpec();

    return {
      success: true,
      message: `Spec "${current.name}" archived successfully`,
      data: {
        spec: { ...current, phase: 'done' },
      },
    };
  }

  async validateCurrentSpec(): Promise<SpecValidationResult> {
    const current = this.getCurrentSpec();
    if (!current) {
      return {
        valid: false,
        phase: 'init',
        completeness: {
          proposal: false,
          spec: false,
          requirements: false,
          design: false,
          tasks: false,
        },
        issues: [{ severity: 'error', file: 'meta', message: 'No active spec' }],
        suggestions: ['Create a new spec with /spec proposal <name>'],
      };
    }

    const fm = this.getFileManager();
    const issues: SpecValidationResult['issues'] = [];
    const suggestions: string[] = [];

    const [proposal, spec, requirements, design, tasks] = await Promise.all([
      fm.readSpecFile(current.name, 'proposal'),
      fm.readSpecFile(current.name, 'spec'),
      fm.readSpecFile(current.name, 'requirements'),
      fm.readSpecFile(current.name, 'design'),
      fm.readSpecFile(current.name, 'tasks'),
    ]);

    const completeness = {
      proposal: !!proposal,
      spec: !!spec,
      requirements: !!requirements,
      design: !!design,
      tasks: !!tasks,
    };

    if (current.phase === 'requirements' && !completeness.requirements) {
      issues.push({
        severity: 'warning',
        file: 'requirements',
        message: 'Requirements document is missing',
      });
      suggestions.push('Generate requirements using EARS format');
    }

    if (current.phase === 'design' && !completeness.design) {
      issues.push({
        severity: 'warning',
        file: 'design',
        message: 'Design document is missing',
      });
      suggestions.push('Create architecture diagrams and API contracts');
    }

    if (current.phase === 'tasks' && current.tasks.length === 0) {
      issues.push({
        severity: 'warning',
        file: 'tasks',
        message: 'No tasks defined',
      });
      suggestions.push('Break down the spec into atomic tasks');
    }

    if (current.phase === 'implementation') {
      const progress = this.getTaskProgress();
      if (progress.completed < progress.total) {
        issues.push({
          severity: 'info',
          file: 'tasks',
          message: `${progress.total - progress.completed} tasks remaining`,
        });
      }
    }

    return {
      valid: issues.filter((i) => i.severity === 'error').length === 0,
      phase: current.phase,
      completeness,
      issues,
      suggestions,
    };
  }

  private generateProposalTemplate(name: string, description: string): string {
    return `# ${name}

## Summary

${description}

## Background

<!-- Why is this change needed? What problem does it solve? -->

## Goals

<!-- What are the specific objectives of this change? -->

- [ ] Goal 1
- [ ] Goal 2

## Non-Goals

<!-- What is explicitly out of scope? -->

## Risks and Mitigations

<!-- What could go wrong? How will you address it? -->

| Risk | Mitigation |
|------|------------|
| | |

## Open Questions

<!-- What needs to be clarified before proceeding? -->

1.
`;
  }

  private calculateTaskProgress(tasks: SpecTask[]): {
    total: number;
    completed: number;
  } {
    const total = tasks.length;
    const completed = tasks.filter((t) => t.status === 'completed').length;
    return { total, completed };
  }
}
