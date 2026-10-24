import { describe, expect, expectTypeOf, it } from "vitest";
import type { OperatorDiscoveryRuntime } from "../src/service/operator-discovery-handler.js";
import type { OperatorPeer } from "../src/service/operator-server.js";
import type { OperatorAuthorizerDependencies } from "../src/service/operator-authorizer.js";
import type {
  targetNoteId,
  resolveOperatorRequestLockState,
  resolveOperatorRequestNotebookPolicy,
} from "../src/service/operator-authorization-context.js";
import {
  createOperatorWriteRuntime,
  type OperatorWriteRuntime,
  type OperatorWriteRuntimeOptions,
} from "../src/service/notes-operator-write-runtime.js";

type Discovery = OperatorDiscoveryRuntime;

describe("operator peer is a required type across the seam (compile time)", () => {
  it("discovery runtime methods require a peer", () => {
    expectTypeOf<Parameters<Discovery["browse"]>[1]>().toEqualTypeOf<OperatorPeer>();
    expectTypeOf<Parameters<Discovery["browse"]>[1]>().not.toEqualTypeOf<
      OperatorPeer | undefined
    >();
    expectTypeOf<Parameters<Discovery["search"]>[1]>().toEqualTypeOf<OperatorPeer>();
    expectTypeOf<Parameters<NonNullable<Discovery["view"]>>[1]>().toEqualTypeOf<OperatorPeer>();
    expectTypeOf<
      Parameters<NonNullable<Discovery["editPreimage"]>>[1]
    >().toEqualTypeOf<OperatorPeer>();
    expectTypeOf<
      Parameters<NonNullable<Discovery["applyEdit"]>>[1]
    >().toEqualTypeOf<OperatorPeer>();
    expectTypeOf<
      Parameters<NonNullable<Discovery["applyUndo"]>>[1]
    >().toEqualTypeOf<OperatorPeer>();
    expectTypeOf<
      Parameters<NonNullable<Discovery["operationStatus"]>>[1]
    >().toEqualTypeOf<OperatorPeer>();
    expectTypeOf<Parameters<NonNullable<Discovery["create"]>>[1]>().toEqualTypeOf<OperatorPeer>();
    expectTypeOf<
      Parameters<NonNullable<Discovery["operationList"]>>[0]
    >().toEqualTypeOf<OperatorPeer>();
  });

  it("write runtime and options require a peer", () => {
    expectTypeOf<
      Parameters<NonNullable<OperatorWriteRuntime["editPreimage"]>>[1]
    >().toEqualTypeOf<OperatorPeer>();
    expectTypeOf<
      Parameters<NonNullable<OperatorWriteRuntime["applyEdit"]>>[1]
    >().toEqualTypeOf<OperatorPeer>();
    expectTypeOf<
      Parameters<NonNullable<OperatorWriteRuntime["create"]>>[1]
    >().toEqualTypeOf<OperatorPeer>();
    expectTypeOf<
      Parameters<OperatorWriteRuntime["operationList"]>[0]
    >().toEqualTypeOf<OperatorPeer>();
    expectTypeOf<
      Parameters<OperatorWriteRuntimeOptions["resolveHandle"]>[1]
    >().toEqualTypeOf<OperatorPeer>();
    expectTypeOf<
      Parameters<NonNullable<OperatorWriteRuntimeOptions["mintHandle"]>>[1]
    >().toEqualTypeOf<OperatorPeer>();
  });

  it("authorizer and authorization-context inputs require a peer", () => {
    expectTypeOf<
      Parameters<OperatorAuthorizerDependencies["resolveHandle"]>[1]
    >().toEqualTypeOf<OperatorPeer>();
    expectTypeOf<Parameters<typeof targetNoteId>[0]["peer"]>().toEqualTypeOf<OperatorPeer>();
    expectTypeOf<
      Parameters<typeof resolveOperatorRequestLockState>[0]["peer"]
    >().toEqualTypeOf<OperatorPeer>();
    expectTypeOf<
      Parameters<typeof resolveOperatorRequestNotebookPolicy>[0]["peer"]
    >().toEqualTypeOf<OperatorPeer>();
  });

  it("omitting the peer is a type error", () => {
    const runtime = null as unknown as Discovery;
    const never = (): void => {
      // @ts-expect-error the peer argument is required
      void runtime.browse({});
      // @ts-expect-error the peer argument is required
      void runtime.search({ query: "x" });
    };
    expect(never).toBeTypeOf("function");
  });
});

describe("operator peer guards remain at runtime", () => {
  it("write runtime refuses an undefined peer cast past the types", async () => {
    const runtime = createOperatorWriteRuntime({
      source: {} as never,
      store: {} as never,
      resolveHandle: () => "note",
    });
    const missing = undefined as unknown as OperatorPeer;
    const list = await runtime.operationList(missing).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(list).toBeDefined();
    expect(JSON.stringify(list, Object.getOwnPropertyNames(list as object))).toContain(
      "permission_denied",
    );
    const edit = await runtime.editPreimage({ id: "h" }, missing).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(JSON.stringify(edit, Object.getOwnPropertyNames(edit as object))).toContain(
      "permission_denied",
    );
  });
});
