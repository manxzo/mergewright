// One in-process lock for the MCP server's repository-mutating tools. Tool
// calls run concurrently; those that write the repository (files, the git index, commits) run one at
// a time, in the order they asked.

export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private held = 0;

  /** Run `f` once every earlier holder has finished; the lock is released however `f` ends. */
  async run<T>(f: () => T | Promise<T>): Promise<T> {
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => { release = r; });
    this.held++;
    try {
      await before;
      return await f();
    } finally {
      this.held--;
      release();
    }
  }

  /** True while a holder runs or waits. */
  get busy(): boolean {
    return this.held > 0;
  }
}

/** The lock every repository-mutating tool of this server takes (ToolDef.locked, and mw_docs_write). */
export const repoLock = new Mutex();
