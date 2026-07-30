import type { TemplateSemanticManifest } from "../../semantic/template-manifest";

export const taurosSemanticManifest = {
	template: "tauros",
	regions: [
		{ name: "header", placement: "main", origins: [] },
		{ name: "main", placement: "main", origins: ["main", "sidebar"] },
	],
	header: { region: "header", placement: "main" },
	specialSummary: null,
	parts: [],
} as const satisfies TemplateSemanticManifest;
