import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createNotesUndoStore, type OperationStoreFs } from "../src/service/notes-undo-store.js";

class MemoryFs implements OperationStoreFs {
  files = new Map<string, Uint8Array>();
  events: string[] = [];
  fail = "";
  async list(limit: number) {
    return [...this.files.keys()].slice(0, limit);
  }
  async read(name: string, limit: number) {
    const b = this.files.get(name)!;
    if (b.length > limit) throw Error("private path/body/key");
    return b.slice();
  }
  async writeExclusive(name: string, bytes: Uint8Array, mode: 0o600) {
    this.hit("write");
    expect(mode).toBe(0o600);
    if (this.files.has(name)) throw Error("exists");
    this.files.set(name, bytes.slice());
  }
  async syncFile(_name: string) {
    this.hit("file-sync");
  }
  async rename(from: string, to: string) {
    this.hit("rename");
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
  async syncDirectory() {
    this.hit("directory-sync");
  }
  async remove(name: string) {
    this.hit("remove");
    this.files.delete(name);
  }
  hit(event: string) {
    this.events.push(event);
    if (this.fail === event) throw Error("private path/body/key");
  }
}
const key = () => new Uint8Array(32).fill(7);
const input = { kind: "edit" as const, payload: "synthetic title and native body", ttlMs: 1000 };
const setup = (fs = new MemoryFs(), extra = {}) =>
  createNotesUndoStore({ fs, daemonKey: key(), now: () => 100, ...extra });

describe("daemon encrypted operation store", () => {
  it("persists ciphertext atomically and recovers authenticated identities", async () => {
    const fs = new MemoryFs();
    const store = await setup(fs);
    const record = await store.insert(input);
    expect(record.handle).toMatch(/^op_[a-f0-9]{64}$/);
    expect(fs.events).toEqual(["write", "file-sync", "rename", "directory-sync"]);
    expect(Buffer.from([...fs.files.values()][0]!).includes(Buffer.from(input.payload))).toBe(
      false,
    );
    expect(await (await setup(fs)).get(record.handle)).toEqual(record);
  });
  it("copies key material and isolates returned records", async () => {
    const fs = new MemoryFs();
    const daemonKey = key();
    const store = await setup(fs, { daemonKey });
    daemonKey.fill(0);
    const r = await store.insert(input);
    expect(await (await setup(fs)).get(r.handle)).toEqual(r);
    expect(Object.isFrozen(r)).toBe(true);
    await store.close();
    await expect(store.get(r.handle)).rejects.toThrow("closed");
  });
  it.each(["wrong-key", "tamper", "substitution", "torn"])(
    "rejects %s without deleting evidence",
    async (attack) => {
      const fs = new MemoryFs();
      const store = await setup(fs);
      const a = await store.insert(input);
      const b = await store.insert(input);
      if (attack === "tamper") fs.files.get(a.handle)![20] = fs.files.get(a.handle)![20]! ^ 1;
      if (attack === "substitution") fs.files.set(a.handle, fs.files.get(b.handle)!);
      if (attack === "torn") fs.files.set(a.handle, fs.files.get(a.handle)!.slice(0, 22));
      await expect(
        setup(fs, attack === "wrong-key" ? { daemonKey: new Uint8Array(32).fill(9) } : {}),
      ).rejects.toThrow("corrupt");
      expect(fs.files.size).toBe(2);
    },
  );
  it("serializes competing transitions without losing updates and retains unresolved records", async () => {
    const fs = new MemoryFs();
    const store = await setup(fs);
    const r = await store.insert(input);
    const results = await Promise.allSettled([
      store.transition(r.handle, "prepared", "committing"),
      store.transition(r.handle, "prepared", "aborted"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    await store.transition(r.handle, "committing", "unresolved");
    await expect(store.acknowledge(r.handle)).rejects.toThrow("conflict");
    expect((await (await setup(fs)).get(r.handle)).state).toBe("unresolved");
  });
  it.each(["write", "file-sync", "rename", "directory-sync"])(
    "fails closed at %s and recovers only complete records",
    async (failure) => {
      const fs = new MemoryFs();
      const store = await setup(fs);
      const r = await store.insert(input);
      fs.fail = failure;
      await expect(store.transition(r.handle, "prepared", "committing")).rejects.toThrow(/^io$/);
      await expect(store.get(r.handle)).rejects.toThrow("closed");
      fs.fail = "";
      const recovered = await setup(fs);
      expect((await recovered.get(r.handle)).state).toBe(
        failure === "directory-sync" ? "committing" : "prepared",
      );
      expect([...fs.files.keys()]).toEqual([r.handle]);
    },
  );
  it("bounds count and bytes, including recovered records, without evicting outstanding operations", async () => {
    const fs = new MemoryFs();
    const store = await setup(fs, { maxRecords: 1 });
    await store.insert(input);
    await expect(store.insert(input)).rejects.toThrow("quota");
    await expect(setup(fs, { maxTotalBytes: 1 })).rejects.toThrow("quota");
    await expect((await setup()).insert({ ...input, payload: "x".repeat(65536) })).rejects.toThrow(
      "quota",
    );
    await expect(
      (await setup(new MemoryFs(), { maxTotalBytes: 100 })).insert(input),
    ).rejects.toThrow("quota");
  });
  it("expires records and durably acknowledges only terminal operations", async () => {
    const fs = new MemoryFs();
    let time = 100;
    const store = await setup(fs, { now: () => time });
    const a = await store.insert(input);
    await store.transition(a.handle, "prepared", "aborted");
    await store.acknowledge(a.handle);
    expect(fs.files.size).toBe(0);
    const b = await store.insert(input);
    time = 1100;
    expect(await store.list()).toEqual([]);
    await expect(store.get(b.handle)).rejects.toThrow("missing");
    expect(fs.files.size).toBe(0);
  });
  it("rejects invalid handles and transitions categorically", async () => {
    const store = await setup();
    await expect(store.get("../../private-title")).rejects.toThrow(/^invalid-input$/);
    const r = await store.insert(input);
    await expect(store.transition(r.handle, "prepared", "undone")).rejects.toThrow("conflict");
  });
  it("reserves temporary ciphertext bytes within the total quota", async () => {
    const fs = new MemoryFs();
    const initial = await setup(fs);
    const r = await initial.insert(input);
    const size = fs.files.get(r.handle)!.length;
    const bounded = await setup(fs, { maxTotalBytes: size + 10 });
    fs.events = [];
    await expect(bounded.transition(r.handle, "prepared", "committing")).rejects.toThrow("quota");
    expect(fs.events).toEqual([]);
    expect((await bounded.get(r.handle)).state).toBe("prepared");
  });
  it("serializes inserts at the quota and retains actual revision payloads across restart", async () => {
    const fs = new MemoryFs();
    const store = await setup(fs, { maxRecords: 1 });
    const results = await Promise.allSettled([store.insert(input), store.insert(input)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    const r = (await store.list())[0]!;
    await store.transition(r.handle, "prepared", "committing");
    await store.transition(r.handle, "committing", "committed", "synthetic actual revision");
    const recovered = await setup(fs);
    expect((await recovered.get(r.handle)).payload).toBe("synthetic actual revision");
    await recovered.transition(r.handle, "committed", "undone");
    await recovered.acknowledge(r.handle);
    expect(await recovered.list()).toEqual([]);
  });
  it("retains evidence on failed recovery and bounds recovery listing", async () => {
    const fs = new MemoryFs();
    const store = await setup(fs);
    const r = await store.insert(input);
    fs.files.set("tmp_" + "a".repeat(64), new Uint8Array([1]));
    fs.files.set(r.handle, new Uint8Array([1]));
    await expect(setup(fs)).rejects.toThrow("corrupt");
    expect(fs.files.size).toBe(2);
    for (let i = 0; i < 4; i++) fs.files.set("tmp_" + String(i).repeat(64), new Uint8Array());
    await expect(setup(fs, { maxRecords: 1 })).rejects.toThrow("quota");
  });
  it("fails closed on deletion errors without exposing adapter diagnostics", async () => {
    const fs = new MemoryFs();
    const store = await setup(fs);
    const r = await store.insert(input);
    await store.transition(r.handle, "prepared", "aborted");
    fs.fail = "remove";
    await expect(store.acknowledge(r.handle)).rejects.toThrow(/^io$/);
    expect(fs.files.has(r.handle)).toBe(true);
  });
});
