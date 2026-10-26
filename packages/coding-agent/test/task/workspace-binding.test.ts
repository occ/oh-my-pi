import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import * as sdk from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import * as settingsStream from "../../src/session/settings-stream-fn";
import { TaskTool } from "../../src/task";
import * as discovery from "../../src/task/discovery";
import * as executor from "../../src/task/executor";
import { resolveEffectiveSubagentPolicy } from "../../src/task/structured-subagent";
import type { ToolSession } from "../../src/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const agent = {
	name: "task",
	description: "Task",
	systemPrompt: "Complete the assignment.",
	source: "bundled" as const,
};

function parentSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "task.batch": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as ToolSession;
}

describe("delegated workspace binding", () => {
	const sessions: AgentSession[] = [];
	afterEach(async () => {
		await Promise.all(sessions.splice(0).map(session => session.dispose()));
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("dispatches public TaskTool reads and writes in the bound checkout, preserving the foreign checkout", async () => {
		using directory = TempDir.createSync("@omp-task-workspace-");
		const primary = directory.join("primary");
		const checkout = directory.join("checkout");
		await fs.mkdir(primary);
		await fs.mkdir(checkout);
		await Bun.write(`${primary}/identity.txt`, "foreign primary changes\n");
		await Bun.write(`${checkout}/identity.txt`, "bound checkout evidence\n");
		const extensionMarker = directory.join("ambient-extension-loaded");
		await Bun.write(
			`${checkout}/.omp/extensions/ambient.ts`,
			`import * as fs from "node:fs"; fs.writeFileSync(${JSON.stringify(extensionMarker)}, "loaded"); export default function () {}`,
		);
		await Bun.write(
			`${checkout}/.omp/skills/checkout-skill/SKILL.md`,
			"---\nname: checkout-skill\ndescription: Bound checkout skill\n---\nBOUND_SKILL_AUTOLOAD_EVIDENCE\n",
		);
		const explicitMarker = directory.join("explicit-extension-loaded");
		const explicitExtension = `${primary}/explicit-extension.ts`;
		await Bun.write(
			explicitExtension,
			`import * as fs from "node:fs"; export default function () { fs.appendFileSync(${JSON.stringify(explicitMarker)}, "loaded\\n"); }`,
		);
		const decoyMarker = directory.join("decoy-extension-loaded");
		await Bun.write(
			`${checkout}/explicit-extension.ts`,
			`import * as fs from "node:fs"; export default function () { fs.writeFileSync(${JSON.stringify(decoyMarker)}, "loaded"); }`,
		);
		const authStorage = await AuthStorage.create(directory.join("auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, directory.join("models.yml"));
		const model = modelRegistry.find("openai", "gpt-5.4");
		if (!model) throw new Error("Missing offline model fixture");
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "read", arguments: { path: "identity.txt" } }] },
				{
					content: [
						{
							type: "toolCall",
							name: "write",
							arguments: { path: "identity.txt", content: "edited bound checkout\n" },
						},
					],
				},
				{
					content: [
						{
							type: "toolCall",
							name: "write",
							arguments: { path: `${primary}/identity.txt`, content: "must be rejected" },
						},
					],
				},
				{ content: ["Complete."] },
			],
		});
		const realStream = settingsStream.createSettingsAwareStreamFn;
		vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slowMode) =>
			realStream(settings, mock.stream, slowMode),
		);
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [{ ...agent, autoloadSkills: ["checkout-skill"] }],
			projectAgentsDir: null,
		});
		const realCreate = sdk.createAgentSession;
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const result = await realCreate(options);
			sessions.push(result.session);
			return result;
		});
		const { session: parent } = await sdk.createAgentSession({
			cwd: primary,
			agentDir: directory.path(),
			authStorage,
			modelRegistry,
			model,
			sessionManager: SessionManager.create(primary, directory.join("sessions")),
			settings: Settings.isolated({
				"async.enabled": false,
				"task.batch": false,
				"task.structured": false,
				"marketplace.autoUpdate": "off",
				"compaction.enabled": false,
			}),
			toolNames: ["task"],
			spawns: "*",
			disableExtensionDiscovery: true,
			additionalExtensionPaths: ["explicit-extension.ts"],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
		});
		const tool = parent.getToolByName("task") as TaskTool;
		const result = await tool.execute("bound-dispatch", {
			name: "BoundCheckout",
			task: "Read and edit identity.txt.",
			solutionSpace: "one prescribed edit",
			cwd: checkout,
		});
		expect(result.isError, JSON.stringify(result)).not.toBe(true);
		expect(result.details?.results[0]?.exitCode, JSON.stringify(result)).toBe(0);
		expect(await Bun.file(`${checkout}/identity.txt`).text()).toBe("edited bound checkout\n");
		expect(await Bun.file(`${primary}/identity.txt`).text()).toBe("foreign primary changes\n");
		const finalContext = mock.calls.at(-1)?.context;
		const reads = finalContext?.messages.filter(
			message => message.role === "toolResult" && message.toolName === "read",
		);
		expect(JSON.stringify(reads)).toContain("bound checkout evidence");
		expect(JSON.stringify(reads)).not.toContain("foreign primary changes");
		const writes = finalContext?.messages.filter(
			message => message.role === "toolResult" && message.toolName === "write",
		);
		expect(writes?.some(message => message.role === "toolResult" && message.isError)).toBe(true);
		expect(finalContext?.systemPrompt?.join("\n")).toContain(await fs.realpath(checkout));
		expect(await Bun.file(extensionMarker).exists()).toBe(false);
		expect(JSON.stringify(finalContext?.messages)).toContain("BOUND_SKILL_AUTOLOAD_EVIDENCE");
		expect((await Bun.file(explicitMarker).text()).trim().split("\n")).toHaveLength(2);
		expect(await Bun.file(decoyMarker).exists()).toBe(false);
	});

	it("canonicalizes flat and batch roots and drops parent source context when changing checkout", async () => {
		using directory = TempDir.createSync("@omp-task-roots-");
		await fs.mkdir(directory.join("child"));
		await fs.mkdir(directory.join("extra"));
		await fs.symlink(directory.join("child"), directory.join("alias"));
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const session = parentSession(directory.path());
		session.additionalDirectories = [directory.path()];
		session.contextFiles = [{ path: `${directory.path()}/parent.txt`, content: "parent source" }];
		const run = vi.spyOn(executor, "runSubprocess").mockImplementation(async options => ({
			index: 0,
			id: options.id ?? "Bound",
			agent: "task",
			agentSource: "bundled",
			task: options.task,
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 0,
			tokens: 0,
			requests: 0,
		}));
		const tool = await TaskTool.create(session);
		await tool.execute("flat", { task: "research", cwd: "alias", additionalDirectories: ["../extra", "../extra"] });
		const flat = run.mock.calls[0]?.[0];
		expect(flat?.cwd).toBe(await fs.realpath(directory.join("child")));
		expect(flat?.additionalDirectories).toEqual([await fs.realpath(directory.join("extra"))]);
		expect(flat?.contextFiles).toBeUndefined();
		expect(flat?.workspaceTree).toBeUndefined();
		expect(flat?.rules).toBeUndefined();
		const batchSession = parentSession(directory.path());
		batchSession.settings = Settings.isolated({ "async.enabled": false, "task.batch": true });
		batchSession.additionalDirectories = [directory.path()];
		const batchTool = await TaskTool.create(batchSession);
		const batch = await batchTool.execute("batch", {
			context: "shared",
			tasks: [{ name: "BoundBatch", task: "research", cwd: "child" }],
		});
		expect(batch.isError, JSON.stringify(batch)).not.toBe(true);
		const boundBatch = run.mock.calls.find(call => call[0].id === "BoundBatch")?.[0];
		expect(boundBatch).toBeDefined();
		expect(boundBatch?.additionalDirectories).toEqual([]);
	});

	it("does not let bound callers widen child roots, but skips deleted inherited roots", async () => {
		using directory = TempDir.createSync("@omp-task-descendant-");
		await fs.mkdir(directory.join("child"));
		await fs.mkdir(directory.join("outsider"));
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const session = parentSession(directory.join("child"));
		session.workspaceBound = true;
		session.additionalDirectories = [directory.join("deleted")];
		const policy = await resolveEffectiveSubagentPolicy({ session, invocationKind: "eval", assignment: "research" });
		expect(policy.workspace.additionalDirectories).toEqual([]);
		for (const binding of [{ cwd: "../outsider" }, { additionalDirectories: ["../outsider"] }]) {
			await expect(
				resolveEffectiveSubagentPolicy({ session, invocationKind: "eval", assignment: "research", ...binding }),
			).rejects.toThrow("outside the bound workspace");
		}
		await expect(
			resolveEffectiveSubagentPolicy({
				session,
				invocationKind: "eval",
				assignment: "research",
				additionalDirectories: [directory.join("deleted")],
			}),
		).rejects.toThrow("existing directory");
	});
	it("rejects missing and non-directory roots before discovery or dispatch", async () => {
		using directory = TempDir.createSync("@omp-task-invalid-root-");
		await Bun.write(directory.join("file"), "not a directory");
		const scan = vi.spyOn(discovery, "discoverAgents");
		const session = parentSession(directory.path());
		for (const request of [
			{ cwd: "missing" },
			{ cwd: "file" },
			{ cwd: " " },
			{ additionalDirectories: ["missing"] },
		]) {
			await expect(
				resolveEffectiveSubagentPolicy({ session, invocationKind: "task", assignment: "research", ...request }),
			).rejects.toThrow("directory");
		}
		expect(scan).not.toHaveBeenCalled();
	});
});
