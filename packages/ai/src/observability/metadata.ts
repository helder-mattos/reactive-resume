import type { AIProvider } from "../types";
import type { AIObservabilityInput } from "./types";

export function buildAIObservabilityMetadata(
	input: {
		provider: AIProvider;
		model: string;
		baseURL: string;
		observability?: AIObservabilityInput | undefined;
	},
	extra: Record<string, unknown> = {},
) {
	return {
		provider: input.provider,
		model: input.model,
		hasCustomBaseUrl: input.baseURL.trim().length > 0,
		observabilityEnabled: input.observability?.enabled ?? false,
		observabilityProvider: input.observability?.provider,
		...extra,
	};
}
