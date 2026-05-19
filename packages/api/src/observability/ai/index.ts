import type { AIObservabilityInput } from "@reactive-resume/ai/observability";
import type { AIProvider } from "@reactive-resume/ai/types";
import type { AIObservabilityTelemetry } from "./types";
import { match } from "ts-pattern";
import { withLaminarObservability } from "./providers/laminar";
import { withLangSmithObservability } from "./providers/langsmith";

type WithAIObservabilityInput = {
	observability?: AIObservabilityInput | undefined;
	modelProvider: AIProvider;
	operationName: string;
	metadata: Record<string, unknown>;
};

export async function withAIObservability<T>(
	input: WithAIObservabilityInput,
	execute: (telemetry: AIObservabilityTelemetry | undefined) => Promise<T>,
): Promise<T> {
	if (!input.observability?.enabled) return execute(undefined);

	const { observability } = input;

	return match(observability.provider)
		.with("laminar", () =>
			withLaminarObservability(
				{
					config: observability.providers.laminar,
					modelProvider: input.modelProvider,
					operationName: input.operationName,
					metadata: input.metadata,
				},
				execute,
			),
		)
		.with("langsmith", () =>
			withLangSmithObservability(
				{
					config: observability.providers.langsmith,
					modelProvider: input.modelProvider,
					operationName: input.operationName,
					metadata: input.metadata,
				},
				execute,
			),
		)
		.exhaustive();
}
