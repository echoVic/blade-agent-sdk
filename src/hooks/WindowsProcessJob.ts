const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const WINDOWS_JOB_POLL_INTERVAL_MS = 20;

type NativeHandle = unknown;

interface WindowsJobBindings {
  createJobObject: () => NativeHandle;
  setInformationJobObject: (
    job: NativeHandle,
    informationClass: number,
    information: Buffer,
    informationLength: number,
  ) => number;
  openProcess: (
    desiredAccess: number,
    inheritHandle: number,
    processId: number,
  ) => NativeHandle;
  assignProcessToJobObject: (
    job: NativeHandle,
    process: NativeHandle,
  ) => number;
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

function win32Error(
  bindings: WindowsJobBindings,
  operation: string,
): Error {
  return new Error(`${operation} failed (Win32 error ${bindings.getLastError()})`);
}

async function loadWindowsJobBindings(): Promise<WindowsJobBindings> {
  if (process.platform !== 'win32') {
    throw new Error('Windows Job Objects are only available on Windows');
  }
  if (!bindingsPromise) {
    bindingsPromise = import('koffi').then(({ default: koffi }) => {
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
        closeHandle: kernel32.func(
          'int32_t __stdcall CloseHandle(void *handle)',
        ),
        getLastError: kernel32.func(
          'uint32_t __stdcall GetLastError()',
        ),
      };
    }).catch((error) => {
      bindingsPromise = undefined;
      throw new Error('Windows Job Object support is unavailable', {
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
    const handle = bindings.createJobObject();
    if (!handle) {
      throw win32Error(bindings, 'CreateJobObjectW');
    }

    const information = createExtendedLimitInformation();
    if (!bindings.setInformationJobObject(
      handle,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
      information,
      information.byteLength,
    )) {
      const error = win32Error(bindings, 'SetInformationJobObject');
      bindings.closeHandle(handle);
      throw error;
    }

    return new WindowsProcessJob(bindings, handle);
  }

  assign(processId: number): void {
    if (this.closed) {
      throw new Error('Cannot assign a process to a closed Windows Job Object');
    }
    const processHandle = this.bindings.openProcess(
      PROCESS_TERMINATE | PROCESS_SET_QUOTA,
      0,
      processId,
    );
    if (!processHandle) {
      throw win32Error(this.bindings, 'OpenProcess');
    }

    try {
      if (!this.bindings.assignProcessToJobObject(
        this.handle,
        processHandle,
      )) {
        throw win32Error(this.bindings, 'AssignProcessToJobObject');
      }
    } finally {
      this.bindings.closeHandle(processHandle);
    }
  }

  terminateAndWait(): Promise<void> {
    this.cleanupPromise ??= this.terminateAndWaitOnce();
    return this.cleanupPromise;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    if (!this.bindings.closeHandle(this.handle)) {
      throw win32Error(this.bindings, 'CloseHandle');
    }
    this.closed = true;
  }

  private async terminateAndWaitOnce(): Promise<void> {
    if (this.closed) {
      return;
    }

    while (this.getActiveProcessCount() !== 0) {
      if (!this.bindings.terminateJobObject(this.handle, 1)) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, WINDOWS_JOB_POLL_INTERVAL_MS);
        });
        continue;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, WINDOWS_JOB_POLL_INTERVAL_MS);
      });
    }
    this.close();
  }

  private getActiveProcessCount(): number | undefined {
    const information = Buffer.alloc(48);
    if (!this.bindings.queryInformationJobObject(
      this.handle,
      JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
      information,
      information.byteLength,
      null,
    )) {
      return undefined;
    }
    return information.readUInt32LE(40);
  }
}
