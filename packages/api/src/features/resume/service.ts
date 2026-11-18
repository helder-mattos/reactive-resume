import type { JsonPatchOperation } from "@reactive-resume/resume/patch";
import type { StoredResumeAnalysis } from "@reactive-resume/schema/resume/analysis";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { VariantBlockStatuses, VariantLayoutMode, VariantStatus } from "@reactive-resume/schema/resume/variants";
import type { Locale } from "@reactive-resume/utils/locale";
import type { ResumeUpdatedEvent } from "./events";
import { ORPCError } from "@orpc/client";
import { compare, hash } from "bcrypt";
import { and, arrayContains, asc, desc, eq, gte, isNotNull, notInArray, sql } from "drizzle-orm";
import { get } from "es-toolkit/compat";
import { match } from "ts-pattern";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { applyResumePatches, ResumePatchError } from "@reactive-resume/resume/patch";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { getResumeBlockFingerprints, reconcileVariantBlockStatuses } from "@reactive-resume/schema/resume/variants";
import { generateId } from "@reactive-resume/utils/string";
import { getStorageService } from "../storage/service";
import { grantResumeAccess, hasResumeAccess } from "./access";
import { assertCanView, isOwner, redactResumeForViewer, shouldCountForStatistics } from "./access-policy";
import { publishResumeUpdated } from "./events";
import { parseStoredResumeData, parseWritableResumeData } from "./resume-data-validation";
import { hasRenderDataChanged, preserveServerStylesheet } from "./stylesheet-preservation";
import { clientKeyFromHeaders, shouldCountView } from "./view-dedup";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

type VariantRow = typeof schema.resumeVariant.$inferSelect;

function variantResponse(row: VariantRow) {
	return {
		...row,
		locale: row.locale as Locale,
		data: parseStoredResumeData(row.data),
		layoutMode: row.layoutMode as VariantLayoutMode,
		blockStatuses: (row.blockStatuses ?? {}) as VariantBlockStatuses,
	};
}

/** Keep review metadata in sync when the primary language changes. This is deliberately conservative:
 * it never edits translated copy or silently clears an intentional difference. */
async function reconcileVariantReviewState(
	client: DbOrTx,
	input: { resumeId: string; previous: ResumeData; next: ResumeData },
) {
	const [variants, previousSource, nextSource] = await Promise.all([
		client
			.select({
				id: schema.resumeVariant.id,
				data: schema.resumeVariant.data,
				layoutMode: schema.resumeVariant.layoutMode,
				blockStatuses: schema.resumeVariant.blockStatuses,
			})
			.from(schema.resumeVariant)
			.where(eq(schema.resumeVariant.resumeId, input.resumeId)),
		Promise.resolve(getResumeBlockFingerprints(input.previous)),
		Promise.resolve(getResumeBlockFingerprints(input.next)),
	]);

	for (const variant of variants) {
		const blockStatuses = reconcileVariantBlockStatuses(
			previousSource,
			nextSource,
			(variant.blockStatuses ?? {}) as VariantBlockStatuses,
		);
		const data = parseStoredResumeData(variant.data);
		// A shared variant follows primary pagination/layout changes but keeps its locale and copy.
		if (variant.layoutMode === "shared") {
			data.metadata.template = input.next.metadata.template;
			data.metadata.layout = structuredClone(input.next.metadata.layout);
			data.metadata.design = structuredClone(input.next.metadata.design);
			data.metadata.typography = structuredClone(input.next.metadata.typography);
			data.metadata.page = {
				...data.metadata.page,
				gapX: input.next.metadata.page.gapX,
				gapY: input.next.metadata.page.gapY,
				marginX: input.next.metadata.page.marginX,
				marginY: input.next.metadata.page.marginY,
				format: input.next.metadata.page.format,
				hideLinkUnderline: input.next.metadata.page.hideLinkUnderline,
				hideIcons: input.next.metadata.page.hideIcons,
				hideSectionIcons: input.next.metadata.page.hideSectionIcons,
			};
		}
		await client
			.update(schema.resumeVariant)
			.set({ data, blockStatuses })
			.where(eq(schema.resumeVariant.id, variant.id));
	}
}

function resumeVersionConflict(updatedAt: Date) {
	return new ORPCError("RESUME_VERSION_CONFLICT", {
		status: 409,
		message: "The resume changed after this patch was generated.",
		data: { updatedAt: updatedAt.toISOString() },
	});
}

function invalidPatchOperation(message: string, index?: number, operation?: JsonPatchOperation) {
	if (index !== undefined && operation !== undefined) {
		return new ORPCError("INVALID_PATCH_OPERATIONS", { status: 400, message, data: { index, operation } });
	}

	return new ORPCError("INVALID_PATCH_OPERATIONS", { status: 400, message });
}

type JsonPointerClass = "root" | "metadata" | "stylesheet" | "other";

function classifyJsonPointer(pointer: string): JsonPointerClass | undefined {
	if (pointer === "") return "root";
	if (!pointer.startsWith("/")) return undefined;

	const segments = pointer
		.slice(1)
		.split("/")
		.map((segment) => {
			if (/~(?:[^01]|$)/.test(segment)) return undefined;
			return segment.replace(/~[01]/g, (encoded) => (encoded === "~1" ? "/" : "~"));
		});
	if (segments.some((segment) => segment === undefined)) return undefined;
	if (segments[0] !== "metadata") return "other";
	if (segments.length === 1) return "metadata";
	return segments[1] === "stylesheet" ? "stylesheet" : "other";
}

function assertSafePatchPointers(operation: JsonPatchOperation, index: number) {
	const pathClass = classifyJsonPointer(operation.path);
	if (!pathClass) {
		throw invalidPatchOperation("Operation `path` property is not a valid JSON Pointer string.", index, operation);
	}

	let fromClass: JsonPointerClass | undefined;
	if ("from" in operation) {
		fromClass = classifyJsonPointer(operation.from);
		if (!fromClass) {
			throw invalidPatchOperation("Operation `from` property is not a valid JSON Pointer string.", index, operation);
		}
	}

	const protectedPath =
		pathClass === "stylesheet" || (operation.op !== "test" && (pathClass === "root" || pathClass === "metadata"));
	const protectedSource = fromClass === "stylesheet" || fromClass === "root" || fromClass === "metadata";
	if (protectedPath || protectedSource) {
		throw invalidPatchOperation(
			"The server-owned stylesheet cannot be changed through generic resume patches.",
			index,
			operation,
		);
	}
}

// Version history: keep a bounded, rolling window of snapshots per resume.
const MAX_VERSIONS_PER_RESUME = 30;
// Manual-save milestones are debounced server-side: an autosave only checkpoints if the newest
// snapshot is older than this. Explicit milestones (import, AI edit, restore) always checkpoint.
const SNAPSHOT_THROTTLE_MS = 2 * 60 * 1000;

async function writeResumeVersion(
	client: DbOrTx,
	input: { resumeId: string; userId: string; data: ResumeData; label: string },
) {
	const data = parseWritableResumeData(input.data);

	await client.insert(schema.resumeVersion).values({
		resumeId: input.resumeId,
		userId: input.userId,
		data,
		label: input.label,
	});

	// Prune everything beyond the newest N snapshots for this resume.
	const keep = client
		.select({ id: schema.resumeVersion.id })
		.from(schema.resumeVersion)
		.where(eq(schema.resumeVersion.resumeId, input.resumeId))
		.orderBy(desc(schema.resumeVersion.createdAt))
		.limit(MAX_VERSIONS_PER_RESUME);

	await client
		.delete(schema.resumeVersion)
		.where(and(eq(schema.resumeVersion.resumeId, input.resumeId), notInArray(schema.resumeVersion.id, keep)));
}

// Best-effort, throttled snapshot on the autosave/manual-save path. Never blocks or fails the save.
async function maybeSnapshotOnSave(input: { resumeId: string; userId: string; data: ResumeData; label: string }) {
	try {
		const [latest] = await db
			.select({ createdAt: schema.resumeVersion.createdAt })
			.from(schema.resumeVersion)
			.where(eq(schema.resumeVersion.resumeId, input.resumeId))
			.orderBy(desc(schema.resumeVersion.createdAt))
			.limit(1);

		if (latest && Date.now() - latest.createdAt.getTime() < SNAPSHOT_THROTTLE_MS) return;

		await writeResumeVersion(db, input);
	} catch (error) {
		console.warn("Failed to snapshot resume version:", error);
	}
}

async function applyResumePatchTx(
	client: DbOrTx,
	input: {
		id: string;
		userId: string;
		operations: JsonPatchOperation[];
		expectedUpdatedAt?: Date;
		versionLabel?: string;
	},
) {
	const [existing] = await client
		.select({
			data: schema.resume.data,
			isLocked: schema.resume.isLocked,
			renderDataVersion: schema.resume.renderDataVersion,
			updatedAt: schema.resume.updatedAt,
		})
		.from(schema.resume)
		.where(and(eq(schema.resume.id, input.id), eq(schema.resume.userId, input.userId)))
		.for("update");

	if (!existing) throw new ORPCError("NOT_FOUND");
	if (existing.isLocked) throw new ORPCError("RESUME_LOCKED");
	if (input.expectedUpdatedAt && existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
		throw resumeVersionConflict(existing.updatedAt);
	}

	input.operations.forEach(assertSafePatchPointers);

	let patchedData: ResumeData;

	try {
		patchedData = applyResumePatches(existing.data, input.operations);
	} catch (error) {
		if (error instanceof ResumePatchError) {
			throw new ORPCError("INVALID_PATCH_OPERATIONS", {
				status: 400,
				message: error.message,
				data: { code: error.code, index: error.index, operation: error.operation },
			});
		}

		throw new ORPCError("INVALID_PATCH_OPERATIONS", {
			status: 400,
			message: error instanceof Error ? error.message : "Failed to apply patch operations",
		});
	}

	patchedData = parseWritableResumeData(preserveServerStylesheet(existing.data, patchedData));
	if (patchedData.metadata.page.locale !== existing.data.metadata.page.locale) {
		const [localeCollision] = await client
			.select({ id: schema.resumeVariant.id })
			.from(schema.resumeVariant)
			.where(
				and(
					eq(schema.resumeVariant.resumeId, input.id),
					eq(schema.resumeVariant.locale, patchedData.metadata.page.locale),
				),
			)
			.limit(1);
		if (localeCollision) {
			throw new ORPCError("BAD_REQUEST", {
				status: 400,
				message: "The primary resume locale is already used by a language variant.",
			});
		}
	}
	if (
		existing.data.metadata.stylesheet?.mode === "semantic" &&
		JSON.stringify(existing.data.metadata.styleRules) !== JSON.stringify(patchedData.metadata.styleRules)
	) {
		throw invalidPatchOperation("Legacy style rules cannot be changed while Semantic CSS mode is active.");
	}

	const renderDataChanged = hasRenderDataChanged(existing.data, patchedData);
	// `existing` was selected FOR UPDATE above, so the application-level version check is
	// sufficient here; comparing timestamp equality in SQL loses PostgreSQL microsecond precision.
	const [resume] = await client
		.update(schema.resume)
		.set({
			data: patchedData,
			...(renderDataChanged ? { renderDataVersion: existing.renderDataVersion + 1 } : {}),
		})
		.where(
			and(eq(schema.resume.id, input.id), eq(schema.resume.isLocked, false), eq(schema.resume.userId, input.userId)),
		)
		.returning({
			id: schema.resume.id,
			name: schema.resume.name,
			slug: schema.resume.slug,
			tags: schema.resume.tags,
			data: schema.resume.data,
			isPublic: schema.resume.isPublic,
			isLocked: schema.resume.isLocked,
			updatedAt: schema.resume.updatedAt,
			hasPassword: sql<boolean>`${schema.resume.password} IS NOT NULL`,
		});

	if (!resume) {
		if (input.expectedUpdatedAt) throw resumeVersionConflict(existing.updatedAt);
		throw new ORPCError("NOT_FOUND");
	}

	await reconcileVariantReviewState(client, {
		resumeId: resume.id,
		previous: existing.data,
		next: patchedData,
	});

	// Checkpoint every patch (AI/API edit) atomically within the same transaction as the edit.
	// ponytail: a multi-patch agent turn writes one row per patch; the prune cap (30) bounds it.
	await writeResumeVersion(client, {
		resumeId: resume.id,
		userId: input.userId,
		data: resume.data,
		label: input.versionLabel ?? "AI edit",
	});

	return resume;
}

const tags = {
	list: async (input: { userId: string }) => {
		const result = await db
			.select({ tags: schema.resume.tags })
			.from(schema.resume)
			.where(eq(schema.resume.userId, input.userId));

		return [...new Set(result.flatMap((tag) => tag.tags))].sort((a, b) => a.localeCompare(b));
	},
};

const statistics = {
	getById: async (input: { id: string; userId: string }) => {
		const [statistics] = await db
			.select({
				isPublic: schema.resume.isPublic,
				views: schema.resumeStatistics.views,
				downloads: schema.resumeStatistics.downloads,
				lastViewedAt: schema.resumeStatistics.lastViewedAt,
				lastDownloadedAt: schema.resumeStatistics.lastDownloadedAt,
			})
			.from(schema.resumeStatistics)
			.rightJoin(schema.resume, eq(schema.resumeStatistics.resumeId, schema.resume.id))
			.where(and(eq(schema.resume.id, input.id), eq(schema.resume.userId, input.userId)));

		if (!statistics) throw new ORPCError("NOT_FOUND");

		return {
			isPublic: statistics.isPublic,
			views: statistics.views ?? 0,
			downloads: statistics.downloads ?? 0,
			lastViewedAt: statistics.lastViewedAt,
			lastDownloadedAt: statistics.lastDownloadedAt,
		};
	},

	increment: async (input: { id: string; views?: boolean; downloads?: boolean }) => {
		const views = input.views ? 1 : 0;
		const downloads = input.downloads ? 1 : 0;
		const lastViewedAt = input.views ? sql`now()` : undefined;
		const lastDownloadedAt = input.downloads ? sql`now()` : undefined;
		const today = new Date().toISOString().slice(0, 10);

		await db.transaction(async (tx) => {
			await tx
				.insert(schema.resumeStatistics)
				.values({
					resumeId: input.id,
					views,
					downloads,
					lastViewedAt,
					lastDownloadedAt,
				})
				.onConflictDoUpdate({
					target: [schema.resumeStatistics.resumeId],
					set: {
						views: sql`${schema.resumeStatistics.views} + ${views}`,
						downloads: sql`${schema.resumeStatistics.downloads} + ${downloads}`,
						lastViewedAt,
						lastDownloadedAt,
					},
				});

			await tx
				.insert(schema.resumeStatisticsDaily)
				.values({ resumeId: input.id, date: today, views, downloads })
				.onConflictDoUpdate({
					target: [schema.resumeStatisticsDaily.resumeId, schema.resumeStatisticsDaily.date],
					set: {
						views: sql`${schema.resumeStatisticsDaily.views} + ${views}`,
						downloads: sql`${schema.resumeStatisticsDaily.downloads} + ${downloads}`,
					},
				});
		});
	},

	// Returns the last `days` (default 30) of daily view/download counts, zero-filled so the series is continuous.
	getDailySeries: async (input: { id: string; userId: string; days?: number }) => {
		const days = input.days ?? 30;

		const [resume] = await db
			.select({ id: schema.resume.id })
			.from(schema.resume)
			.where(and(eq(schema.resume.id, input.id), eq(schema.resume.userId, input.userId)));

		if (!resume) throw new ORPCError("NOT_FOUND");

		const now = new Date();
		const utcDay = (offset: number) =>
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset)).toISOString().slice(0, 10);
		const start = utcDay(days - 1);
		const dates = Array.from({ length: days }, (_, i) => utcDay(days - 1 - i));

		const rows = await db
			.select({
				date: schema.resumeStatisticsDaily.date,
				views: schema.resumeStatisticsDaily.views,
				downloads: schema.resumeStatisticsDaily.downloads,
			})
			.from(schema.resumeStatisticsDaily)
			.where(and(eq(schema.resumeStatisticsDaily.resumeId, input.id), gte(schema.resumeStatisticsDaily.date, start)));

		const byDate = new Map(rows.map((row) => [row.date, row]));

		return dates.map((date) => ({
			date,
			views: byDate.get(date)?.views ?? 0,
			downloads: byDate.get(date)?.downloads ?? 0,
		}));
	},
};

const analysis = {
	getById: async (input: { id: string; userId: string }) => {
		const [result] = await db
			.select({ analysis: schema.resumeAnalysis.analysis })
			.from(schema.resume)
			.leftJoin(schema.resumeAnalysis, eq(schema.resumeAnalysis.resumeId, schema.resume.id))
			.where(and(eq(schema.resume.id, input.id), eq(schema.resume.userId, input.userId)));

		if (!result) throw new ORPCError("NOT_FOUND");

		return result.analysis ?? null;
	},

	upsert: async (input: { id: string; userId: string; analysis: StoredResumeAnalysis }) => {
		const [resume] = await db
			.select({ id: schema.resume.id })
			.from(schema.resume)
			.where(and(eq(schema.resume.id, input.id), eq(schema.resume.userId, input.userId)));

		if (!resume) throw new ORPCError("NOT_FOUND");

		await db
			.insert(schema.resumeAnalysis)
			.values({
				resumeId: input.id,
				analysis: input.analysis,
			})
			.onConflictDoUpdate({
				target: [schema.resumeAnalysis.resumeId],
				set: {
					analysis: input.analysis,
				},
			});

		return input.analysis;
	},
};

function toSharedResumeResponse(
	resume: {
		id: string;
		name: string;
		slug: string;
		tags: string[];
		data: ResumeData;
		isPublic: boolean;
		isLocked: boolean;
	},
	hasPassword: boolean,
	stylesheetMode: "legacy" | "semantic",
) {
	return {
		id: resume.id,
		name: resume.name,
		slug: resume.slug,
		tags: resume.tags,
		data: resume.data,
		isPublic: resume.isPublic,
		isLocked: resume.isLocked,
		hasPassword,
		stylesheetMode,
	};
}

async function notifyResumeUpdated(event: ResumeUpdatedEvent) {
	try {
		await publishResumeUpdated(event);
	} catch (error) {
		console.warn("Failed to publish resume.updated event:", error);
	}
}

export const resumeService = {
	tags,
	statistics,
	analysis,

	variants: {
		list: async (input: { resumeId: string; userId: string }) => {
			const [owner] = await db
				.select({ id: schema.resume.id })
				.from(schema.resume)
				.where(and(eq(schema.resume.id, input.resumeId), eq(schema.resume.userId, input.userId)));
			if (!owner) throw new ORPCError("NOT_FOUND");

			const rows = await db
				.select()
				.from(schema.resumeVariant)
				.where(eq(schema.resumeVariant.resumeId, input.resumeId))
				.orderBy(asc(schema.resumeVariant.createdAt));
			return rows.map(variantResponse);
		},

		get: async (input: { resumeId: string; locale: string; userId: string }) => {
			const [row] = await db
				.select({ variant: schema.resumeVariant })
				.from(schema.resumeVariant)
				.innerJoin(schema.resume, eq(schema.resumeVariant.resumeId, schema.resume.id))
				.where(
					and(
						eq(schema.resumeVariant.resumeId, input.resumeId),
						eq(schema.resumeVariant.locale, input.locale),
						eq(schema.resume.userId, input.userId),
					),
				);
			if (!row) throw new ORPCError("NOT_FOUND");
			return variantResponse(row.variant);
		},

		create: async (input: {
			resumeId: string;
			locale: string;
			userId: string;
			data?: ResumeData;
			initialBlockStatus?: VariantStatus;
			expectedPrimaryUpdatedAt?: Date;
		}) => {
			const result = await db.transaction(async (tx) => {
				const [resume] = await tx
					.select({
						id: schema.resume.id,
						data: schema.resume.data,
						isLocked: schema.resume.isLocked,
						updatedAt: schema.resume.updatedAt,
					})
					.from(schema.resume)
					.where(and(eq(schema.resume.id, input.resumeId), eq(schema.resume.userId, input.userId)))
					.for("update");
				if (!resume) throw new ORPCError("NOT_FOUND");
				if (resume.isLocked) throw new ORPCError("RESUME_LOCKED");
				if (input.expectedPrimaryUpdatedAt && resume.updatedAt.getTime() !== input.expectedPrimaryUpdatedAt.getTime()) {
					throw new ORPCError("RESUME_VERSION_CONFLICT", {
						status: 409,
						message: "The primary resume changed while its translation was being generated.",
						data: { updatedAt: resume.updatedAt.toISOString() },
					});
				}
				const primary = parseStoredResumeData(resume.data);
				if (primary.metadata.page.locale === input.locale) {
					throw new ORPCError("BAD_REQUEST", { status: 400, message: "A variant must use a different locale." });
				}
				const [existingVariant] = await tx
					.select({ id: schema.resumeVariant.id })
					.from(schema.resumeVariant)
					.where(eq(schema.resumeVariant.resumeId, input.resumeId))
					.limit(1);
				if (existingVariant) {
					throw new ORPCError("BAD_REQUEST", {
						status: 400,
						message: "This resume already has a language variant.",
					});
				}

				const data = parseWritableResumeData(structuredClone(input.data ?? primary));
				data.metadata.page.locale = input.locale as typeof data.metadata.page.locale;
				data.metadata.template = primary.metadata.template;
				data.metadata.layout = structuredClone(primary.metadata.layout);
				data.metadata.design = structuredClone(primary.metadata.design);
				data.metadata.typography = structuredClone(primary.metadata.typography);
				data.metadata.page = {
					...data.metadata.page,
					gapX: primary.metadata.page.gapX,
					gapY: primary.metadata.page.gapY,
					marginX: primary.metadata.page.marginX,
					marginY: primary.metadata.page.marginY,
					format: primary.metadata.page.format,
					hideLinkUnderline: primary.metadata.page.hideLinkUnderline,
					hideIcons: primary.metadata.page.hideIcons,
					hideSectionIcons: primary.metadata.page.hideSectionIcons,
					locale: input.locale as typeof data.metadata.page.locale,
				};
				const [created] = await tx
					.insert(schema.resumeVariant)
					.values({
						resumeId: input.resumeId,
						locale: input.locale,
						data,
						layoutMode: "shared",
						blockStatuses: {
							...Object.fromEntries(
								Object.entries(getResumeBlockFingerprints(primary)).map(([blockId, sourceFingerprint]) => [
									blockId,
									{ status: input.initialBlockStatus ?? "missing", sourceFingerprint },
								]),
							),
						} satisfies VariantBlockStatuses,
					})
					.returning();
				if (!created) throw new ORPCError("INTERNAL_SERVER_ERROR");
				return created;
			});

			await notifyResumeUpdated({
				type: "resume.updated",
				resumeId: input.resumeId,
				userId: input.userId,
				updatedAt: result.updatedAt.toISOString(),
				mutation: "update",
			});
			return variantResponse(result);
		},

		update: async (input: {
			resumeId: string;
			locale: string;
			userId: string;
			data?: ResumeData;
			layoutMode?: VariantLayoutMode;
			blockStatuses?: VariantBlockStatuses;
			expectedUpdatedAt?: Date;
		}) => {
			const result = await db.transaction(async (tx) => {
				const [row] = await tx
					.select({ variant: schema.resumeVariant, primary: schema.resume })
					.from(schema.resumeVariant)
					.innerJoin(schema.resume, eq(schema.resumeVariant.resumeId, schema.resume.id))
					.where(
						and(
							eq(schema.resumeVariant.resumeId, input.resumeId),
							eq(schema.resumeVariant.locale, input.locale),
							eq(schema.resume.userId, input.userId),
						),
					)
					.for("update");
				if (!row) throw new ORPCError("NOT_FOUND");
				if (row.primary.isLocked) throw new ORPCError("RESUME_LOCKED");
				if (input.expectedUpdatedAt && row.variant.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
					throw new ORPCError("RESUME_VERSION_CONFLICT", {
						status: 409,
						message: "The language variant changed after this edit was generated.",
						data: { updatedAt: row.variant.updatedAt.toISOString() },
					});
				}
				// The row is locked by the SELECT ... FOR UPDATE above. Keep the version check in
				// application code: PostgreSQL timestamps can contain microseconds that JavaScript
				// Date values (and the JSON transport) cannot round-trip in an equality predicate.

				const layoutMode = input.layoutMode ?? (row.variant.layoutMode as VariantLayoutMode);
				const primary = parseStoredResumeData(row.primary.data);
				const data = input.data
					? parseWritableResumeData(structuredClone(input.data))
					: parseStoredResumeData(row.variant.data);
				data.metadata.page.locale = input.locale as typeof data.metadata.page.locale;
				if (layoutMode === "shared") {
					data.metadata.template = primary.metadata.template;
					data.metadata.layout = structuredClone(primary.metadata.layout);
					data.metadata.design = structuredClone(primary.metadata.design);
					data.metadata.typography = structuredClone(primary.metadata.typography);
					data.metadata.page = {
						...data.metadata.page,
						gapX: primary.metadata.page.gapX,
						gapY: primary.metadata.page.gapY,
						marginX: primary.metadata.page.marginX,
						marginY: primary.metadata.page.marginY,
						format: primary.metadata.page.format,
						hideLinkUnderline: primary.metadata.page.hideLinkUnderline,
						hideIcons: primary.metadata.page.hideIcons,
						hideSectionIcons: primary.metadata.page.hideSectionIcons,
					};
				}

				const [updated] = await tx
					.update(schema.resumeVariant)
					.set({
						data,
						layoutMode,
						...(input.blockStatuses ? { blockStatuses: input.blockStatuses } : {}),
					})
					.where(eq(schema.resumeVariant.id, row.variant.id))
					.returning();
				if (!updated) throw new ORPCError("NOT_FOUND");
				return updated;
			});

			await notifyResumeUpdated({
				type: "resume.updated",
				resumeId: input.resumeId,
				userId: input.userId,
				updatedAt: result.updatedAt.toISOString(),
				mutation: "update",
			});
			return variantResponse(result);
		},

		delete: async (input: { resumeId: string; locale: string; userId: string }) => {
			const [row] = await db
				.select({
					variantId: schema.resumeVariant.id,
					isLocked: schema.resume.isLocked,
					updatedAt: schema.resume.updatedAt,
				})
				.from(schema.resumeVariant)
				.innerJoin(schema.resume, eq(schema.resumeVariant.resumeId, schema.resume.id))
				.where(
					and(
						eq(schema.resumeVariant.resumeId, input.resumeId),
						eq(schema.resumeVariant.locale, input.locale),
						eq(schema.resume.userId, input.userId),
					),
				);
			if (!row) throw new ORPCError("NOT_FOUND");
			if (row.isLocked) throw new ORPCError("RESUME_LOCKED");
			await db.delete(schema.resumeVariant).where(eq(schema.resumeVariant.id, row.variantId));
			await notifyResumeUpdated({
				type: "resume.updated",
				resumeId: input.resumeId,
				userId: input.userId,
				updatedAt: row.updatedAt.toISOString(),
				mutation: "update",
			});
		},
	},

	versions: {
		list: async (input: { resumeId: string; userId: string }) => {
			const [owner] = await db
				.select({ id: schema.resume.id })
				.from(schema.resume)
				.where(and(eq(schema.resume.id, input.resumeId), eq(schema.resume.userId, input.userId)));

			if (!owner) throw new ORPCError("NOT_FOUND");

			return db
				.select({
					id: schema.resumeVersion.id,
					label: schema.resumeVersion.label,
					createdAt: schema.resumeVersion.createdAt,
				})
				.from(schema.resumeVersion)
				.where(eq(schema.resumeVersion.resumeId, input.resumeId))
				.orderBy(desc(schema.resumeVersion.createdAt))
				.limit(MAX_VERSIONS_PER_RESUME);
		},

		// Best-effort checkpoint used by non-transactional milestones (e.g. import).
		snapshot: async (input: { resumeId: string; userId: string; data: ResumeData; label: string }) => {
			try {
				await writeResumeVersion(db, input);
			} catch (error) {
				console.warn("Failed to snapshot resume version:", error);
			}
		},

		// Non-destructive restore: writes the snapshot's data back through the normal update path, so
		// prior versions remain and the restore is itself just another (snapshot-able, undoable) change.
		restore: async (input: {
			resumeId: string;
			versionId: string;
			userId: string;
			prepareData(input: { data: ResumeData; stylesheetRevision: number }): Promise<ResumeData>;
		}) => {
			// Check lock state before loading or validating historical data so locked resumes fail without expensive work.
			const current = await resumeService.getById({ id: input.resumeId, userId: input.userId });
			if (current.isLocked) throw new ORPCError("RESUME_LOCKED");

			const [version] = await db
				.select({ data: schema.resumeVersion.data })
				.from(schema.resumeVersion)
				.innerJoin(schema.resume, eq(schema.resumeVersion.resumeId, schema.resume.id))
				.where(
					and(
						eq(schema.resumeVersion.id, input.versionId),
						eq(schema.resumeVersion.resumeId, input.resumeId),
						eq(schema.resume.userId, input.userId),
					),
				);

			if (!version) throw new ORPCError("NOT_FOUND");
			const versionData = parseStoredResumeData(version.data);

			// Capture the pre-restore state first so the restore itself is undoable.
			const restoredData = await input.prepareData({
				data: versionData,
				stylesheetRevision: current.stylesheetRevision,
			});
			await resumeService.versions.snapshot({
				resumeId: input.resumeId,
				userId: input.userId,
				data: current.data,
				label: "Before restore",
			});

			const updated = await resumeService.update({
				id: input.resumeId,
				userId: input.userId,
				data: restoredData,
				restoreStylesheet: true,
				skipAutoSnapshot: true,
			});

			await resumeService.versions.snapshot({
				resumeId: input.resumeId,
				userId: input.userId,
				data: updated.data,
				label: "Restored version",
			});

			return updated;
		},
	},

	list: (input: { userId: string; tags: string[]; sort: "lastUpdatedAt" | "createdAt" | "name" }) =>
		db
			.select({
				id: schema.resume.id,
				name: schema.resume.name,
				slug: schema.resume.slug,
				tags: schema.resume.tags,
				isPublic: schema.resume.isPublic,
				isLocked: schema.resume.isLocked,
				createdAt: schema.resume.createdAt,
				updatedAt: schema.resume.updatedAt,
			})
			.from(schema.resume)
			.where(
				and(
					eq(schema.resume.userId, input.userId),
					match(input.tags.length)
						.with(0, () => undefined)
						.otherwise(() => arrayContains(schema.resume.tags, input.tags)),
				),
			)
			.orderBy(
				match(input.sort)
					.with("lastUpdatedAt", () => desc(schema.resume.updatedAt))
					.with("createdAt", () => asc(schema.resume.createdAt))
					.with("name", () => asc(schema.resume.name))
					.exhaustive(),
			),

	getById: async (input: { id: string; userId: string }) => {
		const [resume] = await db
			.select({
				id: schema.resume.id,
				name: schema.resume.name,
				slug: schema.resume.slug,
				tags: schema.resume.tags,
				data: schema.resume.data,
				isPublic: schema.resume.isPublic,
				isLocked: schema.resume.isLocked,
				stylesheetRevision: schema.resume.stylesheetRevision,
				updatedAt: schema.resume.updatedAt,
				hasPassword: sql<boolean>`${schema.resume.password} IS NOT NULL`,
			})
			.from(schema.resume)
			.where(and(eq(schema.resume.id, input.id), eq(schema.resume.userId, input.userId)));

		if (!resume) throw new ORPCError("NOT_FOUND");

		return resume;
	},

	getBySlug: async (input: { username: string; slug: string; requestHeaders: Headers; currentUserId?: string }) => {
		const [resume] = await db
			.select({
				id: schema.resume.id,
				userId: schema.resume.userId,
				name: schema.resume.name,
				slug: schema.resume.slug,
				tags: schema.resume.tags,
				data: schema.resume.data,
				isPublic: schema.resume.isPublic,
				isLocked: schema.resume.isLocked,
				passwordHash: schema.resume.password,
				hasPassword: sql<boolean>`${schema.resume.password} IS NOT NULL`,
			})
			.from(schema.resume)
			.innerJoin(schema.user, eq(schema.resume.userId, schema.user.id))
			.where(and(eq(schema.resume.slug, input.slug), eq(schema.user.username, input.username)));

		if (!resume) throw new ORPCError("NOT_FOUND");

		const viewer = input.currentUserId ? { id: input.currentUserId } : null;
		assertCanView(resume, viewer);

		if (resume.hasPassword && !hasResumeAccess(input.requestHeaders, resume.id, resume.passwordHash)) {
			throw new ORPCError("NEED_PASSWORD", {
				status: 401,
				data: { username: input.username, slug: input.slug },
			});
		}

		if (shouldCountForStatistics(resume, viewer)) {
			const key = `${resume.id}:${clientKeyFromHeaders(input.requestHeaders)}`;
			if (shouldCountView(key, Date.now())) {
				await resumeService.statistics.increment({ id: resume.id, views: true });
			}
		}

		const stylesheetMode = resume.data.metadata.stylesheet?.mode ?? "legacy";
		return toSharedResumeResponse(
			redactResumeForViewer(resume, isOwner(resume, viewer)),
			resume.hasPassword,
			stylesheetMode,
		);
	},

	create: async (input: {
		id?: string;
		userId: string;
		name: string;
		slug: string;
		tags: string[];
		locale: Locale;
		data?: ResumeData;
	}) => {
		const id = input.id ?? generateId();
		const data = parseWritableResumeData(structuredClone(input.data ?? defaultResumeData));
		data.metadata.page.locale = input.locale;

		try {
			await db.insert(schema.resume).values({
				id,
				name: input.name,
				slug: input.slug,
				tags: input.tags,
				userId: input.userId,
				data,
			});

			await notifyResumeUpdated({
				type: "resume.updated",
				resumeId: id,
				userId: input.userId,
				updatedAt: new Date().toISOString(),
				mutation: "create",
			});

			return id;
		} catch (error) {
			const constraint = get(error, "cause.constraint") as string | undefined;

			if (constraint === "resume_slug_user_id_unique") {
				throw new ORPCError("RESUME_SLUG_ALREADY_EXISTS", { status: 400 });
			}

			console.error("Failed to create resume:", error);
			throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Failed to create resume" });
		}
	},

	update: async (input: {
		id: string;
		userId: string;
		name?: string;
		slug?: string;
		tags?: string[];
		data?: ResumeData;
		isPublic?: boolean;
		restoreStylesheet?: boolean;
		skipAutoSnapshot?: boolean;
	}) => {
		const resume = await db
			.transaction(async (tx) => {
				const [existing] = await tx
					.select({
						data: schema.resume.data,
						isLocked: schema.resume.isLocked,
						stylesheetRevision: schema.resume.stylesheetRevision,
						renderDataVersion: schema.resume.renderDataVersion,
					})
					.from(schema.resume)
					.where(and(eq(schema.resume.id, input.id), eq(schema.resume.userId, input.userId)))
					.for("update");

				if (!existing) throw new ORPCError("NOT_FOUND");
				if (existing.isLocked) throw new ORPCError("RESUME_LOCKED");
				const inputData = input.data ? parseWritableResumeData(input.data) : undefined;

				const data = inputData
					? input.restoreStylesheet
						? inputData
						: preserveServerStylesheet(existing.data, inputData)
					: undefined;
				const normalizedData = data ? parseWritableResumeData(data) : undefined;
				if (normalizedData && normalizedData.metadata.page.locale !== existing.data.metadata.page.locale) {
					const [localeCollision] = await tx
						.select({ id: schema.resumeVariant.id })
						.from(schema.resumeVariant)
						.where(
							and(
								eq(schema.resumeVariant.resumeId, input.id),
								eq(schema.resumeVariant.locale, normalizedData.metadata.page.locale),
							),
						)
						.limit(1);
					if (localeCollision) {
						throw new ORPCError("BAD_REQUEST", {
							status: 400,
							message: "The primary resume locale is already used by a language variant.",
						});
					}
				}
				const dataForRenderComparison =
					normalizedData && input.restoreStylesheet
						? preserveServerStylesheet(existing.data, normalizedData)
						: normalizedData;
				const renderDataChanged = dataForRenderComparison
					? hasRenderDataChanged(existing.data, dataForRenderComparison)
					: false;
				const updateData: Partial<typeof schema.resume.$inferSelect> = {
					...(input.name !== undefined ? { name: input.name } : {}),
					...(input.slug !== undefined ? { slug: input.slug } : {}),
					...(input.tags !== undefined ? { tags: input.tags } : {}),
					...(normalizedData ? { data: normalizedData } : {}),
					...(input.isPublic !== undefined ? { isPublic: input.isPublic } : {}),
					...(input.restoreStylesheet ? { stylesheetRevision: existing.stylesheetRevision + 1 } : {}),
					...(renderDataChanged ? { renderDataVersion: existing.renderDataVersion + 1 } : {}),
				};

				const [updated] = await tx
					.update(schema.resume)
					.set(updateData)
					.where(
						and(
							eq(schema.resume.id, input.id),
							eq(schema.resume.isLocked, false),
							eq(schema.resume.userId, input.userId),
						),
					)
					.returning({
						id: schema.resume.id,
						name: schema.resume.name,
						slug: schema.resume.slug,
						tags: schema.resume.tags,
						data: schema.resume.data,
						isPublic: schema.resume.isPublic,
						isLocked: schema.resume.isLocked,
						stylesheetRevision: schema.resume.stylesheetRevision,
						renderDataVersion: schema.resume.renderDataVersion,
						updatedAt: schema.resume.updatedAt,
						hasPassword: sql<boolean>`${schema.resume.password} IS NOT NULL`,
					});

				if (!updated) throw new ORPCError("NOT_FOUND");
				if (normalizedData) {
					await reconcileVariantReviewState(tx, {
						resumeId: input.id,
						previous: existing.data,
						next: normalizedData,
					});
				}
				return updated;
			})
			.catch((error: unknown) => {
				if (error instanceof ORPCError) throw error;

				if (get(error, "cause.constraint") === "resume_slug_user_id_unique") {
					throw new ORPCError("RESUME_SLUG_ALREADY_EXISTS", { status: 400 });
				}

				console.error("Failed to update resume:", error);
				throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Failed to update resume" });
			});

		// Debounced manual-save milestone: only snapshots data edits, and only when the previous
		// snapshot is old enough (see SNAPSHOT_THROTTLE_MS). Covers template switches and typing.
		if (input.data !== undefined && !input.skipAutoSnapshot) {
			await maybeSnapshotOnSave({
				resumeId: resume.id,
				userId: input.userId,
				data: resume.data,
				label: "Manual save",
			});
		}

		await notifyResumeUpdated({
			type: "resume.updated",
			resumeId: resume.id,
			userId: input.userId,
			updatedAt: resume.updatedAt.toISOString(),
			mutation: "update",
		});

		return resume;
	},

	patch: async (input: { id: string; userId: string; operations: JsonPatchOperation[]; expectedUpdatedAt?: Date }) => {
		const resume = await db.transaction((tx) => applyResumePatchTx(tx, input));

		await notifyResumeUpdated({
			type: "resume.updated",
			resumeId: resume.id,
			userId: input.userId,
			updatedAt: resume.updatedAt.toISOString(),
			mutation: "patch",
		});

		return resume;
	},

	patchInTransaction: applyResumePatchTx,

	notifyResumePatched: async (input: { resumeId: string; userId: string; updatedAt: Date }) => {
		await notifyResumeUpdated({
			type: "resume.updated",
			resumeId: input.resumeId,
			userId: input.userId,
			updatedAt: input.updatedAt.toISOString(),
			mutation: "patch",
		});
	},

	setLocked: async (input: { id: string; userId: string; isLocked: boolean }) => {
		const [resume] = await db
			.update(schema.resume)
			.set({ isLocked: input.isLocked })
			.where(and(eq(schema.resume.id, input.id), eq(schema.resume.userId, input.userId)))
			.returning({ id: schema.resume.id, updatedAt: schema.resume.updatedAt });

		if (!resume) throw new ORPCError("NOT_FOUND");

		await notifyResumeUpdated({
			type: "resume.updated",
			resumeId: resume.id,
			userId: input.userId,
			updatedAt: resume.updatedAt.toISOString(),
			mutation: "lock",
		});
	},

	setPassword: async (input: { id: string; userId: string; password: string }) => {
		const hashedPassword = await hash(input.password, 10);

		const [resume] = await db
			.update(schema.resume)
			.set({ password: hashedPassword })
			.where(and(eq(schema.resume.id, input.id), eq(schema.resume.userId, input.userId)))
			.returning({ id: schema.resume.id, updatedAt: schema.resume.updatedAt });

		if (!resume) throw new ORPCError("NOT_FOUND");

		await notifyResumeUpdated({
			type: "resume.updated",
			resumeId: resume.id,
			userId: input.userId,
			updatedAt: resume.updatedAt.toISOString(),
			mutation: "password",
		});
	},

	verifyPassword: async (input: { slug: string; username: string; password: string; responseHeaders?: Headers }) => {
		const [resume] = await db
			.select({ id: schema.resume.id, password: schema.resume.password })
			.from(schema.resume)
			.innerJoin(schema.user, eq(schema.resume.userId, schema.user.id))
			.where(
				and(
					isNotNull(schema.resume.password),
					eq(schema.resume.slug, input.slug),
					eq(schema.user.username, input.username),
				),
			);

		if (!resume) throw new ORPCError("INVALID_PASSWORD", { status: 401 });

		const passwordHash = resume.password as string;
		const isValid = await compare(input.password, passwordHash);

		if (!isValid) throw new ORPCError("INVALID_PASSWORD", { status: 401 });

		if (input.responseHeaders) grantResumeAccess(input.responseHeaders, resume.id, passwordHash);

		return true;
	},

	removePassword: async (input: { id: string; userId: string }) => {
		const [resume] = await db
			.update(schema.resume)
			.set({ password: null })
			.where(and(eq(schema.resume.id, input.id), eq(schema.resume.userId, input.userId)))
			.returning({ id: schema.resume.id, updatedAt: schema.resume.updatedAt });

		if (!resume) throw new ORPCError("NOT_FOUND");

		await notifyResumeUpdated({
			type: "resume.updated",
			resumeId: resume.id,
			userId: input.userId,
			updatedAt: resume.updatedAt.toISOString(),
			mutation: "password",
		});
	},

	delete: async (input: { id: string; userId: string }) => {
		await db.transaction(async (tx) => {
			const [resume] = await tx
				.select({ isLocked: schema.resume.isLocked })
				.from(schema.resume)
				.where(and(eq(schema.resume.id, input.id), eq(schema.resume.userId, input.userId)));

			if (!resume) throw new ORPCError("NOT_FOUND");
			if (resume.isLocked) throw new ORPCError("RESUME_LOCKED");

			await tx.delete(schema.resume).where(and(eq(schema.resume.id, input.id), eq(schema.resume.userId, input.userId)));
		});

		// Clean up storage files after the DB transaction succeeds
		const storageService = getStorageService();
		await Promise.allSettled([
			storageService.delete(`uploads/${input.userId}/screenshots/${input.id}`),
			storageService.delete(`uploads/${input.userId}/pdfs/${input.id}`),
		]);

		await notifyResumeUpdated({
			type: "resume.updated",
			resumeId: input.id,
			userId: input.userId,
			updatedAt: new Date().toISOString(),
			mutation: "delete",
		});
	},
};
