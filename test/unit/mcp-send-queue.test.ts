import { EventEmitter } from "node:events";
import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createSendQueue, type SendEntry } from "../../src/mcp/send-queue.js";

const MiB = 1_024 * 1_024;

class ControlledWritable extends Writable {
  readonly frames: Uint8Array[] = [];
  readonly callbacks: Array<(error?: Error | null) => void> = [];
  accept = true;

  override write(
    chunk: Uint8Array,
    callback?: (error?: Error | null) => void,
  ): boolean;
  override write(
    chunk: Uint8Array,
    encoding?: BufferEncoding,
    callback?: (error?: Error | null) => void,
  ): boolean;
  override write(
    chunk: Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    maybeCallback?: (error?: Error | null) => void,
  ): boolean {
    this.frames.push(chunk);
    const callback =
      typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
    if (callback !== undefined) {
      this.callbacks.push(callback);
    }
    return this.accept;
  }
}

function entry(size: number, source: SendEntry["source"] = "direct"): SendEntry {
  return { source, frame: new Uint8Array(size) };
}

async function rejectionHandled(promise: Promise<void>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("Expected rejection");
    },
    (error: unknown) => error as Error,
  );
}

describe("MCP send queue", () => {
  it("preserves a universal FIFO and separates admission from completion", async () => {
    const output = new ControlledWritable();
    const queue = createSendQueue(output, vi.fn(), vi.fn());
    const receipts = [
      queue.enqueue(entry(1, "sdk")),
      queue.enqueue(entry(2, "fallback")),
      queue.enqueue(entry(3, "direct")),
    ];

    await Promise.all(receipts.map(({ admitted }) => admitted));
    expect(output.frames.map(({ byteLength }) => byteLength)).toEqual([1, 2, 3]);

    let complete = false;
    void receipts[0]?.completed.then(() => {
      complete = true;
    });
    await Promise.resolve();
    expect(complete).toBe(false);

    output.callbacks[0]?.();
    output.callbacks[1]?.();
    output.callbacks[2]?.();
    await Promise.all(receipts.map(({ completed }) => completed));
  });

  it("admits the write that returns false and waits for drain before later writes", async () => {
    const output = new ControlledWritable();
    output.accept = false;
    const changes: boolean[] = [];
    const queue = createSendQueue(output, (paused) => changes.push(paused), vi.fn());

    const first = queue.enqueue(entry(1));
    await first.admitted;
    expect(queue.backpressured).toBe(true);
    expect(changes).toEqual([true]);

    output.accept = true;
    const second = queue.enqueue(entry(2));
    expect(output.frames).toHaveLength(1);
    output.callbacks[0]?.();
    await first.completed;
    expect(output.frames).toHaveLength(1);

    output.emit("drain");
    await second.admitted;
    expect(changes).toEqual([true, false]);
    expect(output.frames).toHaveLength(2);
    output.callbacks[1]?.();
    await second.completed;
  });

  it("accepts exact entry and aggregate byte boundaries and fail-closes overflow", async () => {
    const output = new ControlledWritable();
    output.accept = false;
    const fatal = vi.fn();
    const queue = createSendQueue(output, vi.fn(), fatal);

    const exact = queue.enqueue(entry(10 * MiB));
    await exact.admitted;
    const overflow = queue.enqueue(entry(1));
    await expect(overflow.admitted).rejects.toThrow("capacity exceeded");
    await expect(overflow.completed).rejects.toThrow("capacity exceeded");
    await expect(exact.completed).rejects.toThrow("capacity exceeded");
    expect(fatal).toHaveBeenCalledTimes(1);

    const countOutput = new ControlledWritable();
    countOutput.accept = false;
    const countQueue = createSendQueue(countOutput, vi.fn(), vi.fn());
    const receipts = Array.from({ length: 1_024 }, () => countQueue.enqueue(entry(0)));
    const pendingSettlements = receipts.flatMap(({ admitted, completed }) => [
      admitted.catch((error: unknown) => error),
      completed.catch((error: unknown) => error),
    ]);
    await receipts[0]?.admitted;
    const countOverflow = countQueue.enqueue(entry(0));
    const countOverflowCompletion = rejectionHandled(countOverflow.completed);
    await expect(countOverflow.admitted).rejects.toThrow("capacity exceeded");
    await Promise.all(pendingSettlements);
    await countOverflowCompletion;
  });

  it("fail-closes on a late callback error after admission and drain", async () => {
    const output = new ControlledWritable();
    output.accept = false;
    const fatal = vi.fn();
    const queue = createSendQueue(output, vi.fn(), fatal);
    const first = queue.enqueue(entry(1));
    await first.admitted;

    output.accept = true;
    output.emit("drain");
    const second = queue.enqueue(entry(1));
    await second.admitted;
    const lateError = new Error("late failure");
    output.callbacks[0]?.(lateError);

    await expect(first.completed).rejects.toBe(lateError);
    await expect(second.completed).rejects.toBe(lateError);
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(queue.backpressured).toBe(false);
  });

  it("close rejects queued and incomplete entries, cleans listeners, and leaves the stream owned by its caller", async () => {
    const output = new ControlledWritable();
    output.accept = false;
    const queue = createSendQueue(output, vi.fn(), vi.fn());
    const first = queue.enqueue(entry(1));
    await first.admitted;
    const queued = queue.enqueue(entry(1));
    expect(output.listenerCount("drain")).toBe(1);
    expect(output.listenerCount("error")).toBe(1);

    await queue.close();
    await expect(first.completed).rejects.toThrow("Send queue closed");
    await expect(queued.admitted).rejects.toThrow("Send queue closed");
    await expect(queued.completed).rejects.toThrow("Send queue closed");
    expect(output.listenerCount("drain")).toBe(0);
    expect(output.listenerCount("error")).toBe(0);
    expect(output.destroyed).toBe(false);
    expect(output.writableEnded).toBe(false);
  });

  it("handles unsolicited output errors through the same once-only fatal path", async () => {
    const output = new ControlledWritable();
    const fatal = vi.fn();
    const queue = createSendQueue(output, vi.fn(), fatal);
    const receipt = queue.enqueue(entry(1));
    await receipt.admitted;
    const completionError = rejectionHandled(receipt.completed);

    output.emit("error", new Error("stream failed"));

    await expect(completionError).resolves.toMatchObject({ message: "stream failed" });
    expect(fatal).toHaveBeenCalledTimes(1);
  });
});
