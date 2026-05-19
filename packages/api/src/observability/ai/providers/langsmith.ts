import type { LangSmithObservabilityConfig } from "@reactive-resume/ai/observability";
import type { AIProvider } from "@reactive-resume/ai/types";
import type { AIObservabilityTelemetry } from "../types";
import { Client } from "langsmith";
import { traceable } from "langsmith/traceable";

type WithLangSmithObservabilityInput = {
	config: LangSmithObservabilityConfig;
	modelProvider: AIProvider;
	operationName: string;
	metadata: Record<string, unknown>;
};

function resolveLangSmithConfig(config: LangSmithObservabilityConfig) {
	const apiKey = config.apiKey.trim();

	if (apiKey.length === 0) return null;

	return {
		apiKey,
		...(config.projectName.trim() ? { projectName: config.projectName.trim() } : {}),
		...(config.endpoint.trim() ? { apiUrl: config.endpoint.trim() } : {}),
	};
}

export async function withLangSmithObservability<T>(
	input: WithLangSmithObservabilityInput,
	execute: (telemetry: AIObservabilityTelemetry | undefined) => Promise<T>,
): Promise<T> {
	const config = resolveLangSmithConfig(input.config);
	if (!config) return execute(undefined);

	const client = new Client({
		apiKey: config.apiKey,
		omitTracedRuntimeInfo: true,
		...("apiUrl" in config ? { apiUrl: config.apiUrl } : {}),
	});

	const tracedExecute = traceable(async () => execute(undefined), {
		client,
		name: input.operationName,
		run_type: "llm",
		tracingEnabled: true,
		tags: ["ai", "langsmith", input.modelProvider, "request"],
		metadata: { ...input.metadata, observabilityProvider: "langsmith" },
		...("projectName" in config ? { project_name: config.projectName } : {}),
	});

	try {
		return await tracedExecute();
	} finally {
		await client.flush();
	}
}
