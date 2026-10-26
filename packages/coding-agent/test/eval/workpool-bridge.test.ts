import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { runEvalWorkpool } from "../../src/eval/workpool-bridge";
import { AgentRegistry } from "../../src/registry/agent-registry";
import * as discovery from "../../src/task/discovery";
import type { AgentDefinition } from "../../src/task/types";
import { WorkPoolRegistry } from "../../src/task/workpool";
import type { ToolSession } from "../../src/tools";

const SCOUT: AgentDefinition = {
	name: "scout",
	description: "Test scout",
	systemPrompt: "Inspect things.",
	source: "bundled",
};

const managers = new Set<AsyncJobManager>();

function makeSession(): ToolSession {
	const manager = new AsyncJobManager({ retentionMs: 0 });
	managers.add(manager);
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"task.maxConcurrency": 2,
			"task.maxRecursionDepth": 2,
			"task.isolation.enabled": false,
			"task.enableLsp": false,
		}),
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
	};
}

afterEach(async () => {
	for (const manager of managers) await manager.dispose();
	managers.clear();
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	WorkPoolRegistry.resetForTests();
});

describe("runEvalWorkpool", () => {
	it("validates operation arguments", async () => {
		const session = makeSession();
		await expect(runEvalWorkpool(null, { session })).rejects.toThrow("arguments must be an object");
		await expect(runEvalWorkpool({}, { session })).rejects.toThrow("requires an op");
		await expect(runEvalWorkpool({ op: "create", agent: 4 }, { session })).rejects.toThrow(
			"agent must be a non-empty string",
		);
		await expect(runEvalWorkpool({ op: "status", name: "" }, { session })).rejects.toThrow(
			"requires a non-empty name",
		);
	});

	it("retains canonical pool roots and rejects invalid launch roots before registration", async () => {
		using directory = TempDir.createSync("@omp-workpool-workspace-");
		await fs.mkdir(directory.join("child"));
		await fs.mkdir(directory.join("extra"));
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const session = makeSession();
		session.cwd = directory.path();
		await runEvalWorkpool(
			{ op: "create", agent: "scout", name: "bound", cwd: "child", additionalDirectories: ["../extra"] },
			{ session },
		);
		const pool = WorkPoolRegistry.global().get("Main", "bound");
		expect(pool?.policy.workspace.cwd).toBe(await fs.realpath(directory.join("child")));
		expect(pool?.policy.workspace.additionalDirectories).toEqual([await fs.realpath(directory.join("extra"))]);
		await expect(runEvalWorkpool({ op: "create", name: "missing", cwd: "missing" }, { session })).rejects.toThrow(
			"existing directory",
		);
		await expect(runEvalWorkpool({ op: "create", additionalDirectories: [4] }, { session })).rejects.toThrow(
			"directory paths",
		);
		expect(WorkPoolRegistry.global().get("Main", "missing")).toBeUndefined();
	});

	it("rejects unknown pool names", async () => {
		const session = makeSession();
		await expect(runEvalWorkpool({ op: "status", name: "missing" }, { session })).rejects.toThrow(
			'unknown workpool "missing"',
		);
	});

	it("creates unique default names and validates push and peek arguments", async () => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const session = makeSession();
		const events: Array<Record<string, unknown>> = [];
		const first = await runEvalWorkpool(
			{ op: "create", agent: "scout" },
			{ session, emitStatus: event => events.push(event) },
		);
		const second = await runEvalWorkpool({ op: "create", agent: "scout" }, { session });
		expect(first).toEqual({ name: "scout-pool", agent: "scout", limit: 2 });
		expect(second).toEqual({ name: "scout-pool-2", agent: "scout", limit: 2 });
		expect(events).toEqual([{ op: "workpool", action: "create", pool: "scout-pool", count: 2 }]);
		await expect(runEvalWorkpool({ op: "push", name: "scout-pool", items: ["ok", 1] }, { session })).rejects.toThrow(
			"items string array",
		);
		expect(await runEvalWorkpool({ op: "peek", name: "scout-pool" }, { session })).toEqual({
			batches: [],
			pending: 0,
		});
		await expect(runEvalWorkpool({ op: "wait", name: "scout-pool" }, { session })).rejects.toThrow(
			'unknown workpool operation "wait"',
		);
	});
});
