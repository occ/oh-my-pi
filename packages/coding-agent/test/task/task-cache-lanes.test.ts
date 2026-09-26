import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";

const parentCacheKey = "parent-cache";
const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

function makeResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

function createSession(options: { manager?: AsyncJobManager; settings?: Record<string, unknown> } = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getProviderPromptCacheKey: () => parentCacheKey,
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

describe("task prompt-cache lanes", () => {
	const managers: AsyncJobManager[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("assigns distinct live lanes and reuses them after successful settlement", async () => {
		const calls: executorModule.ExecutorOptions[] = [];
		let gates: Deferred[] = [];
		const firstWaveStarted = Promise.withResolvers<void>();
		const secondWaveStarted = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			calls.push(options);
			if (calls.length === 2) firstWaveStarted.resolve();
			if (calls.length === 4) secondWaveStarted.resolve();
			const gate = deferred();
			gates.push(gate);
			await gate.promise;
			return makeResult(options.id ?? "?");
		});
		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false, "task.batch": true } }));
		const params = {
			context: "Shared context.",
			tasks: [
				{ name: "Alpha", task: "Do A." },
				{ name: "Beta", task: "Do B." },
			],
		} as TaskParams;

		const firstWave = tool.execute("wave-1", params);
		await firstWaveStarted.promise;
		expect(calls.map(call => call.providerPromptCacheKey).sort()).toEqual([
			`${parentCacheKey}:task:0`,
			`${parentCacheKey}:task:1`,
		]);
		for (const gate of gates) gate.resolve();
		await firstWave;

		gates = [];
		const secondWave = tool.execute("wave-2", params);
		await secondWaveStarted.promise;
		expect(
			calls
				.slice(2)
				.map(call => call.providerPromptCacheKey)
				.sort(),
		).toEqual([`${parentCacheKey}:task:0`, `${parentCacheKey}:task:1`]);
		for (const gate of gates) gate.resolve();
		await secondWave;
	});

	it("keeps a resumable child's lane until lifecycle release", async () => {
		const keys: Array<string | undefined> = [];
		let retainedId: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			keys.push(options.providerPromptCacheKey);
			if (keys.length === 1) {
				retainedId = options.id;
				const session = { dispose: async () => {} } as unknown as AgentSession;
				const ref = AgentRegistry.global().register({
					id: options.id,
					displayName: options.id,
					kind: "sub",
					status: "running",
					session,
				});
				await executorModule.finalizeSubagentLifecycle({
					id: options.id,
					session,
					aborted: false,
					keepAlive: true,
					isolated: false,
					agentIdleTtlMs: 0,
					reviveSession: null,
					onRelease: options.onRelease,
				});
				expect(AgentRegistry.global().get(options.id)).toBe(ref);
			}
			return makeResult(options.id ?? "?");
		});
		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false } }));

		await tool.execute("retained", { agent: "task", name: "Retained", task: "Retain." } as TaskParams);
		await tool.execute("while-retained", { agent: "task", name: "Sibling", task: "Run." } as TaskParams);
		expect(keys).toEqual([`${parentCacheKey}:task:0`, `${parentCacheKey}:task:1`]);

		if (!retainedId) throw new Error("Expected retained child id");
		expect(await AgentLifecycleManager.global().release(retainedId)).toBe(true);
		await tool.execute("after-release", { agent: "task", name: "Later", task: "Run later." } as TaskParams);
		expect(keys[2]).toBe(`${parentCacheKey}:task:0`);
	});

	it("keeps an adopted child's lane when downstream processing rejects", async () => {
		const keys: Array<string | undefined> = [];
		let retainedId: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			keys.push(options.providerPromptCacheKey);
			options.onProgress?.({
				...makeResult(options.id),
				status: "running",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				cost: 0,
			});
			if (keys.length === 1) {
				retainedId = options.id;
				const session = { dispose: async () => {} } as unknown as AgentSession;
				AgentRegistry.global().register({
					id: options.id,
					displayName: options.id,
					kind: "sub",
					status: "running",
					session,
				});
				await executorModule.finalizeSubagentLifecycle({
					id: options.id,
					session,
					aborted: false,
					keepAlive: true,
					isolated: false,
					agentIdleTtlMs: 0,
					reviveSession: null,
					onRelease: options.onRelease,
				});
				throw new Error("downstream processing failed");
			}
			return makeResult(options.id);
		});
		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false } }));

		await tool.execute("retained-failure", { agent: "task", name: "RetainedFailure", task: "Retain." } as TaskParams);
		await tool.execute("while-retained-failure", { agent: "task", name: "Sibling", task: "Run." } as TaskParams);
		expect(keys).toEqual([`${parentCacheKey}:task:0`, `${parentCacheKey}:task:1`]);

		if (!retainedId) throw new Error("Expected retained child id");
		expect(await AgentLifecycleManager.global().release(retainedId)).toBe(true);
		await tool.execute("after-failed-release", { agent: "task", name: "Later", task: "Run later." } as TaskParams);
		expect(keys[2]).toBe(`${parentCacheKey}:task:0`);
	});

	it("releases a lane after an executor error", async () => {
		const keys: Array<string | undefined> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			keys.push(options.providerPromptCacheKey);
			if (keys.length === 1) throw new Error("synthetic failure");
			return makeResult(options.id ?? "?");
		});
		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false } }));

		await tool.execute("failed", { agent: "task", name: "Failed", task: "Fail." } as TaskParams);
		await tool.execute("retry", { agent: "task", name: "Retry", task: "Retry." } as TaskParams);

		expect(keys).toEqual([`${parentCacheKey}:task:0`, `${parentCacheKey}:task:0`]);
	});

	it("holds a detached child's lane until successful job settlement", async () => {
		const calls: executorModule.ExecutorOptions[] = [];
		const gates: Deferred[] = [];
		const started = Array.from({ length: 2 }, () => Promise.withResolvers<void>());
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			calls.push(options);
			started[calls.length - 1]?.resolve();
			const gate = deferred();
			gates.push(gate);
			await gate.promise;
			return makeResult(options.id ?? "?");
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await TaskTool.create(createSession({ manager, settings: { "async.enabled": true } }));

		const first = await tool.execute("first", { agent: "task", name: "First", task: "First." } as TaskParams);
		await started[0]!.promise;
		gates[0]!.resolve();
		await manager.getJob(first.details?.async?.jobId ?? "")!.promise;

		const second = await tool.execute("second", { agent: "task", name: "Second", task: "Second." } as TaskParams);
		await started[1]!.promise;
		expect(calls.map(call => call.providerPromptCacheKey)).toEqual([
			`${parentCacheKey}:task:0`,
			`${parentCacheKey}:task:0`,
		]);
		gates[1]!.resolve();
		await manager.getJob(second.details?.async?.jobId ?? "")!.promise;
	});

	it("holds a cancelled detached child's lane until its promise settles", async () => {
		const calls: executorModule.ExecutorOptions[] = [];
		const gates: Deferred[] = [];
		const started = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			calls.push(options);
			started[calls.length - 1]?.resolve();
			const gate = deferred();
			gates.push(gate);
			await gate.promise;
			return makeResult(options.id ?? "?");
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await TaskTool.create(createSession({ manager, settings: { "async.enabled": true } }));

		const first = await tool.execute("first", { agent: "task", name: "First", task: "First." } as TaskParams);
		await started[0]!.promise;
		const firstJob = manager.getJob(first.details?.async?.jobId ?? "");
		if (!firstJob) throw new Error("Expected first background job");
		expect(manager.cancel(firstJob.id)).toBe(true);

		const second = await tool.execute("second", { agent: "task", name: "Second", task: "Second." } as TaskParams);
		await started[1]!.promise;
		expect(calls.map(call => call.providerPromptCacheKey)).toEqual([
			`${parentCacheKey}:task:0`,
			`${parentCacheKey}:task:1`,
		]);

		gates[0]!.resolve();
		await firstJob.promise;
		const third = await tool.execute("third", { agent: "task", name: "Third", task: "Third." } as TaskParams);
		await started[2]!.promise;
		expect(calls[2]?.providerPromptCacheKey).toBe(`${parentCacheKey}:task:0`);

		gates[1]!.resolve();
		gates[2]!.resolve();
		await Promise.all([
			manager.getJob(second.details?.async?.jobId ?? "")!.promise,
			manager.getJob(third.details?.async?.jobId ?? "")!.promise,
		]);
	});
});
