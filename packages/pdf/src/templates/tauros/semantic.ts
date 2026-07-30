import type { TemplateSemanticManifest } from "../../semantic/template-manifest";

const inlineHeaderSectionTypes = ["experience", "education", "volunteer"] as const;

export const taurosSemanticManifest = {
	template: "tauros",
	regions: [
		{ name: "header", placement: "main", origins: [] },
		{ name: "main", placement: "main", origins: ["main"] },
		{ name: "sidebar", placement: "sidebar", origins: ["sidebar"] },
	],
	header: { region: "header", placement: "main" },
	specialSummary: null,
	parts: [
		{
			name: "inline-item-header-leading",
			key: "inline-item-header-leading",
			owner: { kind: "item-header", key: "item-header", sectionTypes: inlineHeaderSectionTypes },
			binding: { type: "primitive", primitive: "View", source: "existing" },
			route: {
				parent: "owner",
				at: "start",
				take: [
					{ kind: "field", name: "position", sectionTypes: ["experience", "volunteer"] },
					{ kind: "field", name: "location", sectionTypes: ["experience", "volunteer"] },
					{ kind: "field", name: "area", sectionTypes: ["education"] },
					{ kind: "field", name: "degree", sectionTypes: ["education"] },
				],
			},
		},
		{
			name: "inline-item-header-middle",
			key: "inline-item-header-middle",
			owner: { kind: "item-header", key: "item-header", sectionTypes: inlineHeaderSectionTypes },
			binding: { type: "primitive", primitive: "View", source: "existing" },
			route: {
				parent: "owner",
				at: "start",
				take: [
					{ kind: "field", name: "company" },
					{ kind: "field", name: "school" },
					{ kind: "field", name: "organization" },
					{ kind: "link" },
				],
			},
		},
		{
			name: "inline-item-header-trailing",
			key: "inline-item-header-trailing",
			owner: { kind: "item-header", key: "item-header", sectionTypes: inlineHeaderSectionTypes },
			binding: { type: "primitive", primitive: "View", source: "existing" },
			route: { parent: "owner", at: "start", take: [{ kind: "field", name: "period" }] },
		},
		{
			name: "contact-item-content",
			key: "contact-item-content",
			owner: { kind: "contact-item", key: "contact-item" },
			binding: {
				type: "primitive",
				primitive: { ownerRole: "structured-link", present: "Link", absent: "View" },
				source: "existing",
			},
			route: { parent: "owner", at: "start", take: "all" },
		},
		{
			name: "contact-item-last",
			key: "contact-item-last",
			owner: { kind: "contact-item", key: "contact-item", position: "last" },
			binding: { type: "alias", canonicalKind: "contact-item", token: "contact-item-last" },
		},
	],
	canonicalBindings: [{ kind: "contact-item", binding: { type: "primitive", primitive: "View", source: "existing" } }],
} as const satisfies TemplateSemanticManifest;
