/**
 * ExecutionEpoch — 流式工具事务边界标识。
 *
 * 每轮 while(true) 循环创建新 epoch。
 * 当 fallback/retry 时 invalidate 旧 epoch。
 * 所有事件入队/出队和工具副作用回调都通过 epoch guard 过滤。
 */
export class ExecutionEpoch {
  private _valid = true;
  private readonly _id: number;
  private static _counter = 0;

  constructor() {
    this._id = ++ExecutionEpoch._counter;
  }

  get id(): number {
    return this._id;
  }

  get isValid(): boolean {
    return this._valid;
  }

  invalidate(): void {
    this._valid = false;
  }
}
