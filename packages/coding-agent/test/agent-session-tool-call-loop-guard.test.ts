import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type CustomMessage, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("AgentSession tool-call loop guard", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-tool-call-loop-guard-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("injects a hidden redirect before the next model call", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({ "command?": "string" }),
			execute: async () => ({ content: [{ type: "text" as const, text: "1263 passed, 4 skipped" }] }),
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const toolCallTurn = callCount < 2;
				const toolCallId = `tc-${callCount}`;
				callCount++;
				const message: AssistantMessage = toolCallTurn
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "pytest -q" } }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Stopped repeating." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: toolCallTurn ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 2,
			"model.toolCallLoopGuard.exemptTools": ["wait"],
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});

		await session.prompt("run checks");
		await session.waitForIdle();

		expect(contexts).toHaveLength(3);
		expect(JSON.stringify(contexts[2]!.messages)).toContain("tool_call_loop_detected");
		expect(JSON.stringify(contexts[2]!.messages)).toContain("1263 passed, 4 skipped");
		const redirects = session.agent.state.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === "tool-call-loop-redirect",
		);
		expect(redirects).toHaveLength(1);
		expect(redirects[0]!.display).toBe(false);
	});

	it("stops unchanged schema rejections across changing batches and preserves independent nested calls", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const received: number[] = [];
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Require a path",
			parameters: type({ path: "string" }),
			execute: async () => {
				throw new Error("Rejected call executed");
			},
		};
		const nestedSchema = type({ i: "string", payload: { i: "string", items: "number[]" } });
		const nestedTool: AgentTool<typeof nestedSchema> = {
			name: "nested",
			label: "Nested",
			description: "Consume nested data",
			parameters: nestedSchema,
			execute: async (_id, args) => {
				expect(args.i).toBe("schema-owned");
				expect(args.payload.i).toBe("nested-value");
				received.push(...args.payload.items);
				return { content: [{ type: "text", text: "Nested call completed" }] };
			},
		};
		let requests = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			intentTracing: true,
			initialState: { model, systemPrompt: ["Test"], tools: [readTool, nestedTool], messages: [] },
			convertToLlm,
			streamFn: () => {
				requests++;
				if (requests > 4) throw new Error("Schema rejection cascade did not stop");
				const message: AssistantMessage = {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: `bad-${requests}`,
							name: "read",
							arguments: { i: `Reading attempt ${requests}` },
						},
						{
							type: "toolCall",
							id: `good-${requests}`,
							name: "nested",
							arguments: { i: "schema-owned", payload: { i: "nested-value", items: [requests] } },
						},
					],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 2,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([
				[readTool.name, readTool],
				[nestedTool.name, nestedTool],
			]),
		});

		await session.prompt("read and process nested data");
		await session.waitForIdle();
		expect(requests).toBe(2);
		expect(received).toEqual([1, 2]);
		const results = agent.state.messages.filter(message => message.role === "toolResult");
		expect(results.filter(result => result.toolName === "nested" && !result.isError)).toHaveLength(2);
		const rejected = results.filter(result => result.toolName === "read");
		expect(rejected).toHaveLength(2);
		expect(rejected[1]).toMatchObject({ isError: true, details: { toolArgumentRejection: true } });
		expect(JSON.stringify(rejected[1]!.content)).toContain("Rejected before tool execution");

		await session.prompt("try another prompt");
		await session.waitForIdle();
		expect(requests).toBe(4);
		expect(received).toEqual([1, 2, 3, 4]);
	});

	it("does not resume through threshold compaction after a rejection-bound stop", async () => {
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "COMPACTED",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Require a path",
			parameters: type({ path: "string" }),
			execute: async () => {
				throw new Error("Rejected call executed");
			},
		};
		let executed = 0;
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Independent tool",
			parameters: type({}),
			execute: async () => {
				executed++;
				return { content: [{ type: "text", text: "independent output" }] };
			},
		};
		let requests = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [readTool, bashTool], messages: [] },
			convertToLlm,
			streamFn: () => {
				requests++;
				const reason = requests <= 2 ? "toolUse" : "stop";
				const usage = { ...zeroUsage, input: 50_000, totalTokens: 50_000 };
				const message: AssistantMessage =
					requests <= 2
						? {
								role: "assistant",
								content: [
									{ type: "toolCall", id: `bad-${requests}`, name: "read", arguments: {} },
									{ type: "toolCall", id: `good-${requests}`, name: "bash", arguments: {} },
								],
								api: model.api,
								provider: model.provider,
								model: model.id,
								usage,
								stopReason: "toolUse",
								timestamp: Date.now(),
							}
						: {
								role: "assistant",
								content: [{ type: "text", text: "resumed" }],
								api: model.api,
								provider: model.provider,
								model: model.id,
								usage: zeroUsage,
								stopReason: "stop",
								timestamp: Date.now(),
							};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason, message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.autoContinue": true,
			"compaction.midTurnEnabled": false,
			"compaction.thresholdTokens": 1000,
			"compaction.thresholdPercent": -1,
			"compaction.keepRecentTokens": 1,
			"contextPromotion.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 2,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([
				[readTool.name, readTool],
				[bashTool.name, bashTool],
			]),
		});

		await session.prompt("read the file");
		await session.waitForIdle();

		expect(requests).toBe(2);
		expect(executed).toBe(2);
		expect(compactSpy).not.toHaveBeenCalled();

		await session.prompt("try again");
		await session.waitForIdle();
		expect(requests).toBe(3);
	});
});
