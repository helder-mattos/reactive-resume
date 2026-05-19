import type { LaminarObservabilityConfig } from "@reactive-resume/ai/observability";
import type { AIProvider } from "@reactive-resume/ai/types";
import type { AIObservabilityTelemetry } from "../types";
import { aiSdkTelemetry, Laminar, observe } from "@lmnr-ai/lmnr";

let laminarConfigFingerprint: string | null = null;

function parseLaminarPort(value: string): number | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;

	const parsed = Number.parseInt(trimmed, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function resolveLaminarConfig(config: LaminarObservabilityConfig) {
	const projectApiKey = config.projectApiKey.trim();
	const httpPort = parseLaminarPort(config.httpPort);
	const grpcPort = parseLaminarPort(config.grpcPort);

	if (projectApiKey.length === 0) {
		return null;
	}

	return {
		projectApiKey,
		...(httpPort ? { httpPort } : {}),
		...(grpcPort ? { grpcPort } : {}),
		...(config.baseUrl.trim() ? { baseUrl: config.baseUrl.trim() } : {}),
	};
}

async function ensureLaminarInitialized(
	config: NonNullable<ReturnType<typeof resolveLaminarConfig>>,
): Promise<boolean> {
	const fingerprint = JSON.stringify(config);

	if (Laminar.initialized() && laminarConfigFingerprint === fingerprint) return true;

	if (Laminar.initialized() && laminarConfigFingerprint !== fingerprint) {
		// Laminar.initialize() is process-global, so the first config wins until restart.
		console.warn(
			"Laminar is already initialized with a different configuration; skipping tracing for this request. Restart the server to apply the new settings.",
		);
		return false;
	}

	try {
		Laminar.initialize(config);
		laminarConfigFingerprint = fingerprint;
		return true;
	} catch (error) {
		laminarConfigFingerprint = null;
		console.warn("Failed to initialize Laminar observability:", error);
		return false;
	}
}

type WithLaminarObservabilityInput = {
	config: LaminarObservabilityConfig;
	modelProvider: AIProvider;
	operationName: string;
	metadata: Record<string, unknown>;
};

export async function withLaminarObservability<T>(
	input: WithLaminarObservabilityInput,
	execute: (telemetry: AIObservabilityTelemetry | undefined) => Promise<T>,
): Promise<T> {
	const config = resolveLaminarConfig(input.config);
	if (!config) {
		console.warn("Laminar observability is enabled but the project API key is empty; skipping tracing.");
		return execute(undefined);
	}

	const initialized = await ensureLaminarInitialized(config);
	if (!initialized) return execute(undefined);

	// AI SDK v7 replaced the per-call `tracer` option with telemetry integrations.
	// aiSdkTelemetry() is Laminar's v7 integration: it listens on the AI SDK
	// diagnostics channel and emits the LLM/tool spans beneath the observe() span.
	const telemetry: AIObservabilityTelemetry = {
		isEnabled: true,
		integrations: aiSdkTelemetry({ recordInputs: true, recordOutputs: true }),
	};

	try {
		return await observe(
			{
				name: input.operationName,
				tags: ["ai", "laminar", input.modelProvider, "request"],
				metadata: { ...input.metadata, observabilityProvider: "laminar" },
			},
			async () => execute(telemetry),
		);
	} finally {
		// Laminar batches span exports; without an explicit flush a short-lived
		// request can finish before its spans reach the collector.
		await Laminar.flush().catch((error: unknown) => {
			console.warn("Failed to flush Laminar spans:", error);
		});
	}
}
