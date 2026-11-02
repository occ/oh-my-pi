import { describe, expect, it } from "bun:test";
import type { Api } from "@oh-my-pi/pi-ai";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function spec(provider: string, api: Api, id: string): ModelSpec {
	return {
		provider,
		api,
		id,
		name: id,
		baseUrl: "https://example.invalid",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 128_000,
		contextWindow: 922_000,
		reasoning: true,
	};
}

describe("FleetDriver LiteLLM tiers", () => {
	it("keep reasoning out of replayed text for Claude-led tiers only", () => {
		for (const id of ["fd-coder", "fd-med", "fd-small"]) {
			expect(resolveModelPolicy(spec("litellm", "openai-completions", id)).catalog.classifierCotExtraction).toBe(
				true,
			);
		}
		expect(
			resolveModelPolicy(spec("litellm", "openai-completions", "gpt-5.5")).catalog.classifierCotExtraction,
		).toBeUndefined();
		expect(
			resolveModelPolicy(spec("openrouter", "openai-completions", "fd-coder")).catalog.classifierCotExtraction,
		).toBeUndefined();
	});
});
