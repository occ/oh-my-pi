import { describe, expect, it } from "bun:test";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { buildAnthropicClientOptions } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// LiteLLM groups spend logs by this header; without it every request is its own session.
const LITELLM_SESSION_HEADER = "x-litellm-session-id";

function chatSse(): Response {
	const chunk = (delta: unknown, finishReason: string | null) =>
		JSON.stringify({
			id: "x",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		});
	return new Response(`data: ${chunk({ content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function makeLiteLLMCompletionsModel(provider = "litellm"): Model<"openai-completions"> {
	return buildModel({
		id: "fd-coder",
		name: "fd-coder",
		api: "openai-completions",
		provider,
		baseUrl: "https://litellm.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});
}

async function sessionHeaderSent(model: Model<"openai-completions">, sessionId: string): Promise<string | null> {
	let seen: string | null = null;
	const fetchMock = async (_input: string | URL | Request, init?: RequestInit) => {
		seen = new Headers(init?.headers).get(LITELLM_SESSION_HEADER);
		return chatSse();
	};
	const response = await completeSimple(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		{ apiKey: "key", sessionId, fetch: fetchMock as typeof fetch },
	);
	expect(response.stopReason).toBe("stop");
	return seen;
}

describe("LiteLLM session header", () => {
	it("sends the conversation session id on OpenAI-compatible LiteLLM requests", async () => {
		expect(await sessionHeaderSent(makeLiteLLMCompletionsModel(), "session-1")).toBe("session-1");
	});

	it("is not sent to other OpenAI-compatible providers", async () => {
		expect(await sessionHeaderSent(makeLiteLLMCompletionsModel("vllm"), "session-1")).toBeNull();
	});

	it("sends the conversation session id on Anthropic-protocol LiteLLM requests", () => {
		const options = buildAnthropicClientOptions({
			model: buildModel({
				id: "claude-opus-5-5",
				name: "Claude Opus 5.5",
				api: "anthropic-messages",
				provider: "litellm",
				baseUrl: "https://litellm.example",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8192,
			}),
			apiKey: "key",
			headers: { [LITELLM_SESSION_HEADER]: "caller" },
			sessionId: "session-1",
		});
		expect(options.defaultHeaders[LITELLM_SESSION_HEADER]).toBe("session-1");
	});
});
