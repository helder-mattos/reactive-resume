import type { AIObservabilityProvider } from "./types";
import { createJSONStorage, persist } from "zustand/middleware";
import { create } from "zustand/react";

type AIObservabilityState = {
	enabled: boolean;
	provider: AIObservabilityProvider;
	providers: {
		laminar: {
			projectApiKey: string;
			baseUrl: string;
			httpPort: string;
			grpcPort: string;
		};
		langsmith: {
			apiKey: string;
			projectName: string;
			endpoint: string;
		};
	};
};

type AIStoreState = {
	observability: AIObservabilityState;
};

type AIStoreActions = {
	set: (fn: (draft: AIStoreState) => void) => void;
	reset: () => void;
};

type AIStore = AIStoreState & AIStoreActions;

const initialState: AIStoreState = {
	observability: {
		enabled: false,
		provider: "laminar",
		providers: {
			laminar: {
				projectApiKey: "",
				baseUrl: "",
				httpPort: "",
				grpcPort: "",
			},
			langsmith: {
				apiKey: "",
				projectName: "",
				endpoint: "",
			},
		},
	},
};

function cloneState(state: AIStoreState): AIStoreState {
	return {
		observability: {
			...state.observability,
			providers: {
				laminar: { ...state.observability.providers.laminar },
				langsmith: { ...state.observability.providers.langsmith },
			},
		},
	};
}

function migrateObservabilityState(value: unknown): AIObservabilityState {
	if (!value || typeof value !== "object") return initialState.observability;

	const observability = value as Partial<AIObservabilityState> & {
		projectApiKey?: string;
		baseUrl?: string;
		httpPort?: string;
		grpcPort?: string;
	};

	if ("providers" in observability && observability.providers) {
		return {
			...initialState.observability,
			...observability,
			providers: {
				laminar: {
					...initialState.observability.providers.laminar,
					...observability.providers.laminar,
				},
				langsmith: {
					...initialState.observability.providers.langsmith,
					...observability.providers.langsmith,
				},
			},
		};
	}

	return {
		...initialState.observability,
		enabled: observability.enabled ?? initialState.observability.enabled,
		provider: observability.provider ?? initialState.observability.provider,
		providers: {
			...initialState.observability.providers,
			laminar: {
				projectApiKey: observability.projectApiKey ?? "",
				baseUrl: observability.baseUrl ?? "",
				httpPort: observability.httpPort ?? "",
				grpcPort: observability.grpcPort ?? "",
			},
		},
	};
}

export const useAIStore = create<AIStore>()(
	persist(
		(set) => ({
			...initialState,
			set: (fn) => {
				set((state) => {
					const draft = cloneState(state);
					fn(draft);
					return draft;
				});
			},
			reset: () => set(() => initialState),
		}),
		{
			name: "ai-store",
			storage: createJSONStorage(() => localStorage),
			version: 1,
			migrate: (persistedState) => {
				if (!persistedState || typeof persistedState !== "object") return persistedState;

				const state = persistedState as Partial<AIStoreState>;

				return {
					observability: migrateObservabilityState(state.observability),
				};
			},
			partialize: (state) => ({
				observability: state.observability,
			}),
		},
	),
);
