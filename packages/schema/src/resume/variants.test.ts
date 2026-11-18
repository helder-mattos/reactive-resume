import { describe, expect, it } from "vitest";
import { defaultResumeData } from "./default";
import {
	createVariantBlockStatuses,
	findResumeVariantBlock,
	getResumeBlockFingerprints,
	getResumeTextLengthDrift,
	mergeTranslatedResumeBlock,
	mergeTranslatedResumeData,
	reconcileVariantBlockStatuses,
} from "./variants";

describe("resume language variant status helpers", () => {
	it("uses stable logical block ids and source fingerprints", () => {
		const fingerprints = getResumeBlockFingerprints(defaultResumeData);

		expect(fingerprints.basics).toBeTypeOf("string");
		expect(fingerprints["section:experience"]).toBeTypeOf("string");
		expect(createVariantBlockStatuses(defaultResumeData).basics?.status).toBe("up-to-date");
	});

	it("marks translated blocks for review once the primary changes", () => {
		const previous = structuredClone(defaultResumeData);
		const next = structuredClone(defaultResumeData);
		next.basics.headline = "New headline";

		const statuses = reconcileVariantBlockStatuses(
			getResumeBlockFingerprints(previous),
			getResumeBlockFingerprints(next),
			createVariantBlockStatuses(previous),
		);

		expect(statuses.basics?.status).toBe("needs-review");
		expect(statuses["section:experience"]?.status).toBe("up-to-date");
	});

	it("does not duplicate section review work when one item changes", () => {
		const previous = structuredClone(defaultResumeData);
		const next = structuredClone(defaultResumeData);
		const experience = next.sections.experience;
		experience.items.push({
			id: "experience-1",
			hidden: false,
			company: "Updated Company",
			position: "Engineer",
			location: "Paris",
			period: "2020-2024",
			website: { url: "", label: "", inlineLink: false },
			description: "",
			roles: [],
		});
		const previousExperience = previous.sections.experience;
		previousExperience.items.push({
			id: "experience-1",
			hidden: false,
			company: "Original Company",
			position: "Engineer",
			location: "Paris",
			period: "2020-2024",
			website: { url: "", label: "", inlineLink: false },
			description: "",
			roles: [],
		});

		const previousFingerprints = getResumeBlockFingerprints(previous);
		const nextFingerprints = getResumeBlockFingerprints(next);
		const statuses = reconcileVariantBlockStatuses(previousFingerprints, nextFingerprints, {
			"section:experience": {
				status: "up-to-date",
				sourceFingerprint: previousFingerprints["section:experience"] ?? "",
			},
			"item:experience:experience-1": {
				status: "up-to-date",
				sourceFingerprint: previousFingerprints["item:experience:experience-1"] ?? "",
			},
		});

		expect(statuses["section:experience"]?.status).toBe("up-to-date");
		expect(statuses["item:experience:experience-1"]?.status).toBe("needs-review");
	});

	it("preserves an intentional difference", () => {
		const previous = getResumeBlockFingerprints(defaultResumeData);
		const nextData = structuredClone(defaultResumeData);
		nextData.summary.content = "A localized summary";
		const next = getResumeBlockFingerprints(nextData);
		const statuses = reconcileVariantBlockStatuses(previous, next, {
			summary: { status: "intentionally-different", sourceFingerprint: previous.summary ?? "" },
		});

		expect(statuses.summary?.status).toBe("intentionally-different");
	});

	it("keeps IDs and presentation metadata while applying translated copy", () => {
		const source = structuredClone(defaultResumeData);
		source.basics.name = "Alex Smith";
		source.sections.experience.items.push({
			id: "experience-1",
			hidden: false,
			company: "Example Corp",
			position: "Engineer",
			location: "London",
			period: "2020-2024",
			website: { url: "https://example.com", label: "Website", inlineLink: false },
			description: "Built systems.",
			roles: [],
		});
		source.sections.skills.items.push({
			id: "skill-1",
			hidden: false,
			icon: "Code",
			iconColor: "rgba(0, 0, 0, 1)",
			name: "TypeScript",
			proficiency: "Advanced",
			level: 3,
			keywords: ["web"],
		});
		const translated = structuredClone(source);
		translated.basics.name = "Alex Smith (FR)";
		translated.basics.headline = "Ingénieur logiciel";
		translated.summary.content = "Résumé traduit.";
		translated.metadata.template = "pikachu";
		translated.metadata.design.colors.primary = "rgba(0, 0, 0, 1)";
		const translatedPage = translated.metadata.layout.pages[0];
		const translatedItem = translated.sections.experience.items[0];
		if (!translatedPage || !translatedItem) throw new Error("expected translated resume blocks");
		translatedPage.main = ["summary"];
		translatedItem.id = "model-invented-id";
		translatedItem.company = "Entreprise Exemple";
		translatedItem.website.url = "https://model.example";
		translatedItem.hidden = true;
		translatedItem.description = "Systèmes construits.";
		const translatedSkill = translated.sections.skills.items[0];
		if (!translatedSkill) throw new Error("expected translated skill");
		translatedSkill.icon = "Heart";
		translatedSkill.iconColor = "rgba(255, 0, 0, 1)";
		translatedSkill.level = 5;
		translatedSkill.name = "TypeScript traduit";

		const result = mergeTranslatedResumeData(source, translated, "fr-FR");

		expect(result.basics.name).toBe("Alex Smith");
		expect(result.basics.headline).toBe("Ingénieur logiciel");
		expect(result.summary.content).toBe("Résumé traduit.");
		expect(result.sections.experience.items[0]?.id).toBe("experience-1");
		expect(result.sections.experience.items[0]?.company).toBe("Entreprise Exemple");
		expect(result.metadata.template).toBe(source.metadata.template);
		expect(result.metadata.layout).toEqual(source.metadata.layout);
		expect(result.metadata.design).toEqual(source.metadata.design);
		expect(result.sections.experience.items[0]?.website.url).toBe("https://example.com");
		expect(result.sections.experience.items[0]?.hidden).toBe(false);
		expect(result.sections.experience.items[0]?.description).toBe("Systèmes construits.");
		expect(result.sections.skills.items[0]?.name).toBe("TypeScript traduit");
		expect(result.sections.skills.items[0]?.icon).toBe("Code");
		expect(result.sections.skills.items[0]?.iconColor).toBe("rgba(0, 0, 0, 1)");
		expect(result.sections.skills.items[0]?.level).toBe(3);
		expect(result.metadata.page.locale).toBe("fr-FR");
	});

	it("flags large deterministic copy-length drift", () => {
		const source = structuredClone(defaultResumeData);
		const target = structuredClone(defaultResumeData);
		source.summary.content = "Short summary";
		target.summary.content =
			"A much longer translated summary that is likely to move page breaks and should be reviewed";

		const drift = getResumeTextLengthDrift(source, target);
		expect(drift.warning).toBe(true);
		expect(drift.targetLength).toBeGreaterThan(drift.sourceLength);
	});

	it("resolves and safely merges one translated block", () => {
		const target = structuredClone(defaultResumeData);
		target.sections.experience.items.push({
			id: "experience-block",
			hidden: false,
			company: "Example Corp",
			position: "Engineer",
			location: "Paris",
			period: "2020-2024",
			website: { url: "https://example.com", label: "Website", inlineLink: false },
			description: "Description cible",
			roles: [],
		});
		const resolved = findResumeVariantBlock(target, "experience", "experience-block");
		if (!resolved) throw new Error("expected experience block");

		const merged = mergeTranslatedResumeBlock(
			resolved.block,
			{
				id: "model-id",
				company: "Entreprise Exemple",
				position: "Ingénieur",
				description: "Description traduite",
				website: { url: "https://model.example" },
				hidden: true,
			},
			"experience",
		);

		expect(merged.id).toBe("experience-block");
		expect(merged.company).toBe("Entreprise Exemple");
		expect(merged.position).toBe("Ingénieur");
		expect(merged.description).toBe("Description traduite");
		expect(merged.website).toEqual(resolved.block.website);
		expect(merged.hidden).toBe(false);
	});
});
