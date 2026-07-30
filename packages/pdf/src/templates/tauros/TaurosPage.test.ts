import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("TaurosPage", () => {
	const source = readFileSync(fileURLToPath(new URL("./TaurosPage.tsx", import.meta.url)), "utf8");

	it("renders skills/languages/interests (incl. custom sections of those types) inline", () => {
		expect(source).toContain("TAG_SECTION_TYPES");
		expect(source).toContain("TaurosInlineSection");
		expect(source).toContain("customSections.find");
	});

	it("keeps the primary skills title on top and the rest compact (title on the left)", () => {
		expect(source).toContain("TAG_TITLE_TOP_SECTIONS");
		expect(source).toContain("sectionHeadingCompact");
	});

	it("renders experience with a custom inline 'Company - Location' header and bold roles", () => {
		// The executive header moved from a bespoke renderer onto the shared Section so the section
		// participates in Semantic CSS; the layout now comes from this template feature.
		expect(source).toContain("companyLocationInlineHeader: true");
	});

	it("binds the separator dot to the preceding item with a non-breaking space", () => {
		// U+00A0 (non-breaking space) + U+00B7 (middle dot) keeps the dot from starting a wrapped line.
		expect(source).toContain(" ·");
	});
});
