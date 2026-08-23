import { SdkError } from '../errors/SdkError.js';

const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const WINDOWS_JOB_POLL_INTERVAL_MS = 20;

type NativeHandle = unknown;

interface WindowsJobBindings {
  createJobObject: (attributes: null, name: null) => NativeHandle;
  setInformationJobObject: (
    job: NativeHandle,
    informationClass: number,
    information: Buffer,
    informationLength: number,
  ) => number;
  openProcess: (desiredAccess: number, inheritHandle: number, processId: number) => NativeHandle;
  assignProcessToJobObject: (job: NativeHandle, process: NativeHandle) => number;
  terminateJobObject: (job: NativeHandle, exitCode: number) => number;
  queryInformationJobObject: (
    job: NativeHandle,
    informationClass: number,
    information: Buffer,
    informationLength: number,
    returnLength: null,
  ) => number;
  closeHandle: (handle: NativeHandle) => number;
  getLastError: () => number;
}

let bindingsPromise: Promise<WindowsJobBindings> | undefined;

export class HookProcessContainmentError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('HOOK_PROCESS_CONTAINMENT_FAILED', message, options);
  }
}

export function isHookProcessContainmentError(
  error: unknown,
): boolean {
  return containsHookProcessContainmentError(error, new Set());
}

function containsHookProcessContainmentError(
  error: unknown,
  seen: Set<object>,
): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if (
    error instanceof HookProcessContainmentError
    || ('code' in error && error.code === 'HOOK_PROCESS_CONTAINMENT_FAILED')
  ) {
    return true;
  }
  if (seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (
    error instanceof AggregateError
    && error.errors.some((nestedError) =>
      containsHookProcessContainmentError(nestedError, seen))
  ) {
    return true;
  }
  return (
    'cause' in error
    && containsHookProcessContainmentError(error.cause, seen)
  );
}

export function getRecoverableHookErrorMessage(error: unknown): string {
  if (isHookProcessContainmentError(error)) {
    throw error;
  }
  return error instanceof Error ? error.message : String(error);
}

function win32Error(bindings: WindowsJobBindings, operation: string): HookProcessContainmentError {
  return new HookProcessContainmentError(
    `${operation} failed (Win32 error ${bindings.getLastError()})`,
  );
}

function closeNativeHandle(
  bindings: WindowsJobBindings,
  handle: NativeHandle,
  operation: string,
): void {
  if (!bindings.closeHandle(handle)) {
    throw win32Error(bindings, operation);
  }
}

async function loadWindowsJobBindings(): Promise<WindowsJobBindings> {
  if (process.platform !== 'win32') {
    throw new Error('Windows Job Objects are only available on Windows');
  }
  if (!bindingsPromise) {
    bindingsPromise = import('koffi')
      .then(({ default: koffi }) => {
        const kernel32 = koffi.load('kernel32.dll');
        return {
          createJobObject: kernel32.func(
            'void * __stdcall CreateJobObjectW(void *attributes, const char16_t *name)',
          ),
          setInformationJobObject: kernel32.func(
            'int32_t __stdcall SetInformationJobObject(void *job, int32_t informationClass, void *information, uint32_t informationLength)',
          ),
          openProcess: kernel32.func(
            'void * __stdcall OpenProcess(uint32_t desiredAccess, int32_t inheritHandle, uint32_t processId)',
          ),
          assignProcessToJobObject: kernel32.func(
            'int32_t __stdcall AssignProcessToJobObject(void *job, void *process)',
          ),
          terminateJobObject: kernel32.func(
            'int32_t __stdcall TerminateJobObject(void *job, uint32_t exitCode)',
          ),
          queryInformationJobObject: kernel32.func(
            'int32_t __stdcall QueryInformationJobObject(void *job, int32_t informationClass, void *information, uint32_t informationLength, void *returnLength)',
          ),
          closeHandle: kernel32.func('int32_t __stdcall CloseHandle(void *handle)'),
          getLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
        };
      })
      .catch((error) => {
        bindingsPromise = undefined;
        throw new HookProcessContainmentError('Windows Job Object support is unavailable', {
          cause: error,
        });
      });
  }
  return bindingsPromise;
}

function createExtendedLimitInformation(): Buffer {
  const size = process.arch === 'ia32' ? 112 : 144;
  const information = Buffer.alloc(size);
  information.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
  return information;
}

/**
 * Owns one Windows process tree. The root must be assigned before it receives
 * permission to spawn, so every descendant inherits the Job membership.
 */
export class WindowsProcessJob {
  private cleanupPromise: Promise<void> | undefined;
  private closed = false;

  private constructor(
    private readonly bindings: WindowsJobBindings,
    private readonly handle: NativeHandle,
  ) {}

  static async create(): Promise<WindowsProcessJob> {
    const bindings = await loadWindowsJobBindings();
    const handle = bindings.createJobObject(null, null);
    if (!handle) {
      throw win32Error(bindings, 'CreateJobObjectW');
    }

    const information = createExtendedLimitInformation();
    if (
      !bindings.setInformationJobObject(
        handle,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        information,
        information.byteLength,
      )
    ) {
      const configurationError = win32Error(
        bindings,
        'SetInformationJobObject',
      );
      try {
        closeNativeHandle(bindings, handle, 'CloseHandle(Job)');
      } catch (closeError) {
        throw new HookProcessContainmentError(
          'Failed to configure and close the Windows Job Object',
          { cause: new AggregateError([configurationError, closeError]) },
        );
      }
      throw configurationError;
    }

    return new WindowsProcessJob(bindings, handle);
  }

  assign(processId: number): void {
    if (this.closed) {
      throw new HookProcessContainmentError(
        'Cannot assign a process to a closed Windows Job Object',
      );
    }
    const processHandle = this.bindings.openProcess(
      PROCESS_TERMINATE | PROCESS_SET_QUOTA,
      0,
      processId,
    );
    if (!processHandle) {
      throw win32Error(this.bindings, 'OpenProcess');
    }

    const assigned = this.bindings.assignProcessToJobObject(
      this.handle,
      processHandle,
    );
    const assignmentError = assigned
      ? undefined
      : win32Error(this.bindings, 'AssignProcessToJobObject');
    try {
      closeNativeHandle(
        this.bindings,
        processHandle,
        'CloseHandle(Process)',
      );
    } catch (closeError) {
      throw new HookProcessContainmentError(
        'Failed to close the Windows Hook process handle',
        {
          cause: assignmentError
            ? new AggregateError([assignmentError, closeError])
            : closeError,
        },
      );
    }
    if (assignmentError) {
      throw assignmentError;
    }
  }

  terminateAndWait(timeoutMs: number): Promise<void> {
    this.cleanupPromise ??= this.terminateAndWaitOnce(timeoutMs);
    return this.cleanupPromise;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    closeNativeHandle(this.bindings, this.handle, 'CloseHandle(Job)');
    this.closed = true;
  }

  private async terminateAndWaitOnce(timeoutMs: number): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      if (this.getActiveProcessCount() > 0 && !this.bindings.terminateJobObject(this.handle, 1)) {
        throw win32Error(this.bindings, 'TerminateJobObject');
      }

      const deadline = Date.now() + timeoutMs;
      while (this.getActiveProcessCount() > 0) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new HookProcessContainmentError(
            `Windows Hook Job did not terminate within ${timeoutMs}ms`,
          );
        }
        await new Promise<void>((resolve) => {
          setTimeout(
            resolve,
            Math.min(WINDOWS_JOB_POLL_INTERVAL_MS, remainingMs),
          );
        });
      }
      this.close();
    } catch (error) {
      try {
        this.close();
      } catch (closeError) {
        throw new HookProcessContainmentError(
          'Failed to close the Windows Job Object after cleanup failed',
          { cause: new AggregateError([error, closeError]) },
        );
      }
      throw error;
    }
  }

  private getActiveProcessCount(): number {
    const information = Buffer.alloc(48);
    if (
      !this.bindings.queryInformationJobObject(
        this.handle,
        JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
        information,
        information.byteLength,
        null,
      )
    ) {
      throw win32Error(this.bindings, 'QueryInformationJobObject');
    }
    return information.readUInt32LE(40);
  }
}
