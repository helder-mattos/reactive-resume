import type { ResumeData } from "./data";

export type VariantStatus = "up-to-date" | "needs-review" | "missing" | "intentionally-different";
export type VariantLayoutMode = "shared" | "custom";

export type VariantBlockStatus = {
	status: VariantStatus;
	/** Fingerprint of the primary-language block this status was last reviewed against. */
	sourceFingerprint: string;
};

export type VariantBlockStatuses = Record<string, VariantBlockStatus>;

export type VariantTextLengthDrift = {
	sourceLength: number;
	targetLength: number;
	ratio: number;
	warning: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ResumeVariantBlock = {
	block: Record<string, unknown>;
	sectionType: string;
};

/** Resolve one stable item from either a standard or custom section. */
export function findResumeVariantBlock(
	data: ResumeData,
	sectionType: string,
	blockId: string,
	customSectionId?: string,
): ResumeVariantBlock | undefined {
	if (customSectionId) {
		const section = data.customSections.find((candidate) => candidate.id === customSectionId);
		const item = section?.items.find((candidate) => candidate.id === blockId);
		return section && item && isRecord(item) ? { block: item, sectionType: section.type } : undefined;
	}

	const section = (data.sections as Record<string, { items: unknown[] }>)[sectionType];
	const item = section?.items.find((candidate) => isRecord(candidate) && candidate.id === blockId);
	return item && isRecord(item) ? { block: item, sectionType } : undefined;
}

/** Only these fields may be replaced by model output. Everything else is source-owned structure or identity. */
const TRANSLATABLE_FIELDS: Record<string, readonly string[]> = {
	basics: ["headline"],
	summary: ["title", "content"],
	profiles: [],
	experience: ["company", "position", "description"],
	education: ["school", "degree", "area", "description"],
	projects: ["name", "description"],
	skills: ["name", "proficiency", "keywords"],
	languages: ["language", "fluency"],
	interests: ["name", "keywords"],
	awards: ["title", "awarder", "description"],
	certifications: ["title", "issuer", "description"],
	publications: ["title", "publisher", "description"],
	volunteer: ["organization", "description"],
	references: ["position", "description"],
	"cover-letter": ["content"],
};

function mergeAllowedFields(
	source: Record<string, unknown>,
	translated: unknown,
	fields: readonly string[],
): Record<string, unknown> {
	const candidate = isRecord(translated) ? translated : {};
	const result = structuredClone(source);
	for (const field of fields) {
		const sourceValue = source[field];
		const translatedValue = candidate[field];
		if (translatedValue === undefined || typeof translatedValue !== typeof sourceValue) continue;
		if (Array.isArray(sourceValue) && Array.isArray(translatedValue) && translatedValue.length === sourceValue.length)
			result[field] = structuredClone(translatedValue);
		else if (
			!Array.isArray(sourceValue) &&
			(typeof translatedValue === "string" || typeof translatedValue === "number")
		) {
			result[field] = translatedValue;
		}
	}
	return result;
}

function findTranslatedItem(sourceItem: Record<string, unknown>, translatedItems: unknown[], index: number) {
	const sourceId = typeof sourceItem.id === "string" ? sourceItem.id : undefined;
	return (
		translatedItems.find((candidate) => isRecord(candidate) && sourceId !== undefined && candidate.id === sourceId) ??
		translatedItems[index]
	);
}

function mergeItems(sourceItems: unknown[], translatedItems: unknown, sectionType: string): unknown[] {
	if (!Array.isArray(translatedItems)) return structuredClone(sourceItems);
	return sourceItems.map((sourceItem, index) => {
		if (!isRecord(sourceItem)) return structuredClone(sourceItem);
		const candidate = findTranslatedItem(sourceItem, translatedItems, index);
		const result = mergeAllowedFields(sourceItem, candidate, TRANSLATABLE_FIELDS[sectionType] ?? []);
		if (Array.isArray(sourceItem.roles)) {
			const candidateRoles = isRecord(candidate) ? candidate.roles : undefined;
			result.roles = sourceItem.roles.map((role, roleIndex) => {
				if (!isRecord(role)) return structuredClone(role);
				const roleCandidate = Array.isArray(candidateRoles)
					? findTranslatedItem(role, candidateRoles, roleIndex)
					: undefined;
				return mergeAllowedFields(role, roleCandidate, ["position", "description"]);
			});
		}
		return result;
	});
}

/** Merge one model-translated item onto the current target item without changing its structure. */
export function mergeTranslatedResumeBlock(
	targetBlock: Record<string, unknown>,
	translated: unknown,
	sectionType: string,
): Record<string, unknown> {
	const result = mergeAllowedFields(targetBlock, translated, TRANSLATABLE_FIELDS[sectionType] ?? []);
	if (Array.isArray(targetBlock.roles)) {
		const candidateRoles = isRecord(translated) ? translated.roles : undefined;
		result.roles = targetBlock.roles.map((role, roleIndex) => {
			if (!isRecord(role)) return structuredClone(role);
			const roleCandidate = Array.isArray(candidateRoles)
				? findTranslatedItem(role, candidateRoles, roleIndex)
				: undefined;
			return mergeAllowedFields(role, roleCandidate, ["position", "description"]);
		});
	}
	return result;
}

function mergeSection(
	source: Record<string, unknown>,
	translated: unknown,
	sectionType: string,
): Record<string, unknown> {
	const result = mergeAllowedFields(source, translated, ["title"]);
	const sourceItems = source.items;
	if (Array.isArray(sourceItems)) {
		result.items = mergeItems(sourceItems, isRecord(translated) ? translated.items : undefined, sectionType);
	}
	return result;
}

function mergeBasics(source: ResumeData["basics"], translated: unknown): ResumeData["basics"] {
	const result = mergeAllowedFields(source, translated, TRANSLATABLE_FIELDS.basics ?? []);
	const sourceCustomFields = source.customFields;
	const candidateFields = isRecord(translated) ? translated.customFields : undefined;
	result.customFields = sourceCustomFields.map((field, index) => {
		const candidate = Array.isArray(candidateFields) ? findTranslatedItem(field, candidateFields, index) : undefined;
		return mergeAllowedFields(field, candidate, ["text"]);
	});
	return result as ResumeData["basics"];
}

function getTranslatableTextLength(value: unknown, key?: string): number {
	if (key === "metadata" || key === "picture" || key === "id" || key === "hidden") return 0;
	if (
		key &&
		![
			"headline",
			"title",
			"content",
			"company",
			"school",
			"position",
			"description",
			"degree",
			"area",
			"name",
			"proficiency",
			"keywords",
			"language",
			"fluency",
			"awarder",
			"issuer",
			"publisher",
			"organization",
			"recipient",
			"text",
		].includes(key) &&
		typeof value === "string"
	)
		return 0;
	if (typeof value === "string") return value.length;
	if (Array.isArray(value)) return value.reduce((total, item) => total + getTranslatableTextLength(item), 0);
	if (!isRecord(value)) return 0;
	return Object.entries(value).reduce(
		(total, [childKey, childValue]) => total + getTranslatableTextLength(childValue, childKey),
		0,
	);
}

/**
 * A deterministic, dependency-free fingerprint suitable for detecting source edits.
 * This is intentionally not cryptographic: it is persisted only to drive review UX.
 */
function fingerprint(value: unknown): string {
	const text = JSON.stringify(value, (_key, nested) => {
		if (nested && typeof nested === "object" && !Array.isArray(nested)) {
			return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
		}
		return nested;
	});

	let hash = 2166136261;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function fingerprintSectionMetadata(section: unknown): string {
	if (!section || typeof section !== "object" || Array.isArray(section)) return fingerprint(section);

	const { items: _items, ...metadata } = section as Record<string, unknown>;
	return fingerprint(metadata);
}

/** Stable logical IDs, independent of section ordering and localized copy. */
export function getResumeBlockFingerprints(data: ResumeData): Record<string, string> {
	const blocks: Record<string, string> = {
		basics: fingerprint(data.basics),
		picture: fingerprint(data.picture),
		summary: fingerprint(data.summary),
	};

	for (const [sectionType, section] of Object.entries(data.sections)) {
		blocks[`section:${sectionType}`] = fingerprintSectionMetadata(section);
		for (const item of section.items) blocks[`item:${sectionType}:${item.id}`] = fingerprint(item);
	}

	for (const section of data.customSections) {
		blocks[`custom-section:${section.id}`] = fingerprintSectionMetadata(section);
		for (const item of section.items) blocks[`custom-item:${section.id}:${item.id}`] = fingerprint(item);
	}

	return blocks;
}

/**
 * Apply an AI translation without allowing it to add/remove blocks or change renderer structure.
 * Presentation metadata and media are intentionally kept from the source; only user-facing copy
 * inside basics, summary, standard sections, and custom sections is accepted from the model.
 */
export function mergeTranslatedResumeData(source: ResumeData, translated: ResumeData, locale: string): ResumeData {
	const next = structuredClone(source);
	next.basics = mergeBasics(source.basics, translated.basics);
	next.summary = mergeAllowedFields(
		source.summary,
		translated.summary,
		TRANSLATABLE_FIELDS.summary ?? [],
	) as ResumeData["summary"];

	for (const sectionType of Object.keys(source.sections) as Array<keyof ResumeData["sections"]>) {
		next.sections[sectionType] = mergeSection(
			source.sections[sectionType] as unknown as Record<string, unknown>,
			translated.sections[sectionType],
			sectionType,
		) as never;
	}

	next.customSections = source.customSections.map((section) => {
		const translatedSection = translated.customSections.find((candidate) => candidate.id === section.id);
		return mergeSection(section, translatedSection, section.type) as typeof section;
	});
	next.metadata.page.locale = locale;
	return next;
}

/** Deterministic copy-length heuristic used to flag likely pagination drift before the user edits. */
export function getResumeTextLengthDrift(source: ResumeData, target: ResumeData): VariantTextLengthDrift {
	const sourceLength = getTranslatableTextLength(source);
	const targetLength = getTranslatableTextLength(target);
	const ratio =
		sourceLength === 0 ? (targetLength === 0 ? 0 : 1) : Math.abs(targetLength - sourceLength) / sourceLength;
	return { sourceLength, targetLength, ratio, warning: ratio >= 0.2 };
}

export function createVariantBlockStatuses(data: ResumeData): VariantBlockStatuses {
	return Object.fromEntries(
		Object.entries(getResumeBlockFingerprints(data)).map(([blockId, sourceFingerprint]) => [
			blockId,
			{ status: "up-to-date", sourceFingerprint },
		]),
	);
}

/**
 * Reconcile the review state for a secondary variant after the primary document changes.
 * The source fingerprint is always advanced so an edit only produces one review task. A user
 * can explicitly mark a block as intentionally different to opt out of that task.
 */
export function reconcileVariantBlockStatuses(
	previousSource: Record<string, string>,
	nextSource: Record<string, string>,
	current: VariantBlockStatuses,
): VariantBlockStatuses {
	const next: VariantBlockStatuses = {};

	for (const [blockId, sourceFingerprint] of Object.entries(nextSource)) {
		const existing = current[blockId];
		const changed = previousSource[blockId] !== undefined && previousSource[blockId] !== sourceFingerprint;
		next[blockId] = {
			status:
				changed && existing?.status !== "intentionally-different" ? "needs-review" : (existing?.status ?? "missing"),
			sourceFingerprint,
		};
	}

	return next;
}
