/**
 * Reusable provider prompt-cache lanes for concurrent task subagents.
 *
 * Each live child gets a distinct lane because some providers serialize
 * concurrent requests that share a cache/session identity. Releasing the lane
 * lets a later child reuse its warmed system/tool prefix.
 */
export class CacheLanePool {
	readonly #free: number[] = [];
	#next = 0;

	acquire(): number {
		return this.#free.pop() ?? this.#next++;
	}

	release(lane: number): void {
		this.#free.push(lane);
	}
}

/** Derive a child cache identity without changing its provider session lineage. */
export function taskCacheLaneKey(parentKey: string, lane: number): string {
	return `${parentKey}:task:${lane}`;
}
