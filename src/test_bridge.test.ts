import { describe, expect, it } from "bun:test";
import { SingleInstanceLock } from "./lock.ts";
import { StateStore } from "./state.ts";
import { join } from "path";
import { unlinkSync, existsSync } from "fs";

describe("SingleInstanceLock", () => {
  const lockFile = join(process.cwd(), ".test.lock");

  it("acquires and prevents secondary acquire", () => {
    if (existsSync(lockFile)) unlinkSync(lockFile);

    const lock1 = new SingleInstanceLock(lockFile);
    const lock2 = new SingleInstanceLock(lockFile);

    expect(lock1.acquire()).toBe(true);
    expect(lock2.acquire()).toBe(false);

    lock1.release();
    expect(existsSync(lockFile)).toBe(false);

    expect(lock2.acquire()).toBe(true);
    lock2.release();
  });
});

describe("StateStore", () => {
  const stateFile = join(process.cwd(), ".test_state.json");

  it("persists and reads back state", () => {
    if (existsSync(stateFile)) unlinkSync(stateFile);

    const store = new StateStore(stateFile);
    expect(store.read()).toEqual({});

    store.save({ lastUpdateId: 100, isListening: false });
    expect(store.read()).toEqual({ lastUpdateId: 100, isListening: false });

    store.save({ isListening: true });
    expect(store.read()).toEqual({ lastUpdateId: 100, isListening: true });

    if (existsSync(stateFile)) unlinkSync(stateFile);
  });
});
