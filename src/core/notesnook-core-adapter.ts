/**
 * Narrow, injected seam for the pinned Notesnook core.
 *
 * Stage 2A never imports `@notesnook/core`. Callers provide an upstream-
 * compatible module (or factory) and an existing IStorage implementation;
 * this adapter performs only the documented `Database.setup({ storage }).init()`
 * sequence. The injected implementation remains caller-controlled and may
 * have side effects; the adapter itself performs no network calls.
 */

import type { IStorage } from "../storage/istorage.js";

export interface NotesnookDatabase {
  init(): void | PromiseLike<void>;
}

export interface NotesnookCoreModule {
  Database: {
    setup(options: { storage: IStorage }): NotesnookDatabase;
  };
}

export type NotesnookCoreFactory = () => NotesnookCoreModule;
export type NotesnookCoreSource = NotesnookCoreModule | NotesnookCoreFactory;

export type NotesnookCoreAdapterOptions = Readonly<{
  core: NotesnookCoreSource;
  storage: IStorage;
}>;

export class NotesnookCoreAdapter {
  private readonly core: NotesnookCoreModule;
  private readonly storage: IStorage;

  constructor(options: NotesnookCoreAdapterOptions) {
    this.core = resolveCore(options.core);
    this.storage = options.storage;
  }

  /** Initialize the injected core database; the adapter itself makes no network calls. */
  async init(): Promise<void> {
    const database: unknown = this.core.Database.setup({ storage: this.storage });
    if (!isNotesnookDatabase(database)) {
      throw new Error(
        "invalid injected Notesnook database: Database.setup must return an object with init()",
      );
    }
    await database.init();
  }
}

export function createNotesnookCoreAdapter(
  options: NotesnookCoreAdapterOptions,
): NotesnookCoreAdapter {
  return new NotesnookCoreAdapter(options);
}

function resolveCore(source: NotesnookCoreSource): NotesnookCoreModule {
  const core = typeof source === "function" ? source() : source;
  if (
    !core ||
    typeof core !== "object" ||
    !core.Database ||
    typeof core.Database.setup !== "function"
  ) {
    throw new Error("invalid injected Notesnook core: Database.setup is required");
  }
  return core;
}

function isNotesnookDatabase(value: unknown): value is NotesnookDatabase {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { init?: unknown }).init === "function"
  );
}
