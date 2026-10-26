import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "../types";

const LEGACY_INTENT_FIELD = "__intent";
const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;

/** Runtime settings for cross-turn tool-call repetition detection. */
export interface ToolCallLoopGuardOptions {
	readonly threshold: number;
	readonly exemptTools: readonly string[];
}

/** A completed assistant turn plus the tool results it produced. */
export interface ToolCallLoopTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
	/** The turn also delivered context outside its tool results (extension `additionalContext`). */
	readonly injectedContext?: boolean;
}

/** Details needed to steer the model away from a repeated tool call. */
export interface RepeatedToolCallDetection {
	readonly kind: "repeated_tool_call" | "repeated_tool_argument_rejection";
	readonly toolName: string;
	readonly count: number;
	readonly resultSummary: string;
	readonly argumentsSummary: string;
}

function canonicalizeToolCallValue(value: unknown, omitIntent = true): unknown {
	if (Array.isArray(value)) {
		return value.map(item => canonicalizeToolCallValue(item, omitIntent));
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (omitIntent && (key === INTENT_FIELD || key === LEGACY_INTENT_FIELD)) continue;
		output[key] = canonicalizeToolCallValue(input[key], omitIntent);
	}
	return output;
}

/** Opaque identity for rejected validator input; never includes argument values in diagnostics. */
export function toolArgumentFingerprint(args: unknown): string {
	const serialized = JSON.stringify(canonicalizeToolCallValue(args, false)) ?? "undefined";
	return new Bun.CryptoHasher("sha256").update(serialized).digest("hex");
}

function summarizeText(text: string, limit: number): string {
	let summary = text.replace(/\s+/g, " ").trim();
	if (summary.length > limit) {
		summary = `${summary.slice(0, limit)}…`;
	}
	return summary;
}

function summarizeToolResult(toolResults: readonly ToolResultMessage[], toolCallId: string): string {
	const result = toolResults.find(candidate => candidate.toolCallId === toolCallId);
	if (!result) return "";

	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		}
	}
	return summarizeText(textParts.join("\n"), RESULT_SUMMARY_LIMIT);
}

/** Detects consecutive identical assistant tool calls across model turns. */
export class ToolCallLoopGuard {
	#threshold: number;
	#exemptTools: ReadonlySet<string>;
	#lastHash: string | undefined;
	#count = 0;
	#rejections = new Map<string, number>();

	constructor(options: ToolCallLoopGuardOptions) {
		this.#threshold = Math.max(1, Math.trunc(options.threshold));
		this.#exemptTools = new Set(options.exemptTools);
	}

	/** Starts a new user prompt without carrying failed attempts into it. */
	reset(): void {
		this.#lastHash = undefined;
		this.#count = 0;
		this.#rejections.clear();
	}

	#recordRejections(turn: ToolCallLoopTurn, toolCalls: readonly ToolCall[]): RepeatedToolCallDetection | null {
		let detection: RepeatedToolCallDetection | null = null;
		const counted = new Set<string>();
		for (const call of toolCalls) {
			const result = turn.toolResults.find(candidate => candidate.toolCallId === call.id);
			const details = result?.details;
			const rejected =
				result?.isError === true &&
				details !== null &&
				typeof details === "object" &&
				"toolArgumentRejection" in details &&
				details.toolArgumentRejection === true;
			if (!rejected) continue;
			const fingerprint =
				"toolArgumentFingerprint" in details && typeof details.toolArgumentFingerprint === "string"
					? details.toolArgumentFingerprint
					: toolArgumentFingerprint(call.arguments);
			const key = JSON.stringify([call.name, fingerprint]);
			// A malformed fan-out is one attempt, not one retry per child.
			if (counted.has(key)) continue;
			counted.add(key);
			const count = (this.#rejections.get(key) ?? 0) + 1;
			this.#rejections.set(key, count);
			if (count >= this.#threshold) {
				detection = {
					kind: "repeated_tool_argument_rejection",
					toolName: call.name,
					count,
					resultSummary: summarizeToolResult(turn.toolResults, call.id),
					argumentsSummary: "[arguments omitted: rejected before execution]",
				};
			}
		}
		return detection;
	}

	/** Records one completed turn and reports repetitions at or beyond the threshold. */
	recordTurn(turn: ToolCallLoopTurn): RepeatedToolCallDetection | null {
		const toolCalls = turn.message.content.filter((part): part is ToolCall => part.type === "toolCall");
		const rejection = this.#recordRejections(turn, toolCalls);
		if (rejection) return rejection;
		if (toolCalls.length === 0) {
			this.#lastHash = undefined;
			this.#count = 0;
			return null;
		}
		if (toolCalls.every(tc => this.#exemptTools.has(tc.name))) {
			// An exempt poll its tool flagged useless (a wait that elapsed or found
			// nothing to wait for) is skipped, so alternating it with a repeated call
			// cannot hide the loop. Any other exempt turn, failures included, may have
			// changed state (finished jobs, a message, injected context), so it ends
			// the repetition.
			const idle =
				!turn.injectedContext &&
				toolCalls.every(tc => turn.toolResults.find(result => result.toolCallId === tc.id)?.useless === true);
			if (!idle) {
				this.#lastHash = undefined;
				this.#count = 0;
			}
			return null;
		}

		const canonicalCalls = toolCalls
			.map(tc => JSON.stringify([tc.name, canonicalizeToolCallValue(tc.arguments)]))
			.sort();
		const turnHash = JSON.stringify(canonicalCalls);
		if (turnHash === this.#lastHash) {
			this.#count++;
		} else {
			this.#lastHash = turnHash;
			this.#count = 1;
		}

		if (this.#count < this.#threshold) return null;
		const reportCall = toolCalls.find(tc => !this.#exemptTools.has(tc.name)) ?? toolCalls[0]!;
		return {
			kind: "repeated_tool_call",
			toolName: reportCall.name,
			count: this.#count,
			resultSummary: summarizeToolResult(turn.toolResults, reportCall.id),
			argumentsSummary: summarizeText(
				JSON.stringify(canonicalizeToolCallValue(reportCall.arguments)),
				ARGUMENT_SUMMARY_LIMIT,
			),
		};
	}
}
