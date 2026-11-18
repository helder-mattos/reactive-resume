import type { AIObservabilityInput } from "@reactive-resume/ai/observability";
import { ORPCError } from "@orpc/client";
import { AISDKError } from "ai";
import { ZodError } from "zod";
import {
	findResumeVariantBlock,
	mergeTranslatedResumeBlock,
	mergeTranslatedResumeData,
} from "@reactive-resume/schema/resume/variants";
import { protectedProcedure } from "../../context";
import { resumeDto } from "../../dto/resume";
import { aiRequestRateLimit, resumeMutationRateLimit } from "../../middleware/rate-limit";
import { aiService } from "../ai/service";
import { aiProvidersService } from "../ai-providers/service";
import { resumeService } from "./service";

function isInvalidAiBaseUrlError(error: unknown): boolean {
	return error instanceof Error && error.message === "INVALID_AI_BASE_URL";
}

function isCredentialEncryptionUnavailable(error: unknown): boolean {
	return error instanceof Error && error.message === "AI_CREDENTIAL_ENCRYPTION_UNAVAILABLE";
}

function throwAiProviderGatewayError(cause?: unknown): never {
	throw new ORPCError("BAD_GATEWAY", { message: "Could not reach the AI provider.", cause });
}

async function translateVariant(input: {
	resumeData: Parameters<typeof mergeTranslatedResumeData>[0];
	targetLocale: string;
	userId: string;
	aiProviderId?: string;
	observability?: AIObservabilityInput;
}) {
	try {
		const provider = input.aiProviderId
			? await aiProvidersService.getRunnableById({ id: input.aiProviderId, userId: input.userId })
			: await aiProvidersService.getDefaultRunnable({ userId: input.userId });
		if (!provider) throw new ORPCError("BAD_REQUEST", { message: "No tested AI provider is available." });

		return await aiService.translateResume({
			provider: provider.provider,
			model: provider.model,
			apiKey: provider.apiKey,
			baseURL: provider.baseURL ?? "",
			observability: input.observability,
			resumeData: input.resumeData,
			targetLocale: input.targetLocale,
		});
	} catch (error) {
		if (isCredentialEncryptionUnavailable(error)) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message: "AI providers are unavailable because ENCRYPTION_SECRET is not configured.",
			});
		}
		if (error instanceof ORPCError) throw error;
		if (isInvalidAiBaseUrlError(error))
			throw new ORPCError("BAD_REQUEST", { message: "Invalid AI provider configuration." });
		if (error instanceof AISDKError) throwAiProviderGatewayError(error);
		if (
			error instanceof SyntaxError ||
			error instanceof ZodError ||
			(error instanceof Error && error.message.startsWith("AI returned"))
		) {
			throw new ORPCError("BAD_REQUEST", { message: "The AI provider returned invalid translated resume data." });
		}
		throw error;
	}
}

async function createAiVariant(input: {
	resumeId: string;
	locale: string;
	userId: string;
	aiProviderId?: string;
	observability?: AIObservabilityInput;
}) {
	const primary = await resumeService.getById({ id: input.resumeId, userId: input.userId });
	if (primary.isLocked) throw new ORPCError("RESUME_LOCKED");
	if (primary.data.metadata.page.locale === input.locale) {
		throw new ORPCError("BAD_REQUEST", { status: 400, message: "A variant must use a different locale." });
	}
	const existingVariants = await resumeService.variants.list({ resumeId: input.resumeId, userId: input.userId });
	if (existingVariants.length > 0) {
		throw new ORPCError("BAD_REQUEST", {
			status: 400,
			message: "This resume already has a language variant.",
		});
	}
	const translated = await translateVariant({
		resumeData: primary.data,
		targetLocale: input.locale,
		userId: input.userId,
		...(input.aiProviderId ? { aiProviderId: input.aiProviderId } : {}),
		...(input.observability ? { observability: input.observability } : {}),
	});
	const data = mergeTranslatedResumeData(primary.data, translated, input.locale);

	return resumeService.variants.create({
		resumeId: input.resumeId,
		locale: input.locale,
		userId: input.userId,
		data,
		initialBlockStatus: "needs-review",
		expectedPrimaryUpdatedAt: primary.updatedAt,
	});
}

async function translateVariantBlock(input: {
	resumeId: string;
	locale: string;
	sectionType: string;
	blockId: string;
	customSectionId?: string;
	instruction?: string;
	userId: string;
	aiProviderId?: string;
	observability?: AIObservabilityInput;
}) {
	const [primary, variant] = await Promise.all([
		resumeService.getById({ id: input.resumeId, userId: input.userId }),
		resumeService.variants.get({ resumeId: input.resumeId, locale: input.locale, userId: input.userId }),
	]);
	if (primary.isLocked) throw new ORPCError("RESUME_LOCKED");

	const source = findResumeVariantBlock(primary.data, input.sectionType, input.blockId, input.customSectionId);
	const target = findResumeVariantBlock(variant.data, input.sectionType, input.blockId, input.customSectionId);
	if (!source || !target) {
		throw new ORPCError("NOT_FOUND", { message: "The requested translated block no longer exists." });
	}

	try {
		const provider = input.aiProviderId
			? await aiProvidersService.getRunnableById({ id: input.aiProviderId, userId: input.userId })
			: await aiProvidersService.getDefaultRunnable({ userId: input.userId });
		if (!provider) throw new ORPCError("BAD_REQUEST", { message: "No tested AI provider is available." });

		const translated = await aiService.translateResumeBlock({
			provider: provider.provider,
			model: provider.model,
			apiKey: provider.apiKey,
			baseURL: provider.baseURL ?? "",
			observability: input.observability,
			sourceBlock: source.block,
			targetBlock: target.block,
			sectionType: target.sectionType,
			targetLocale: input.locale,
			...(input.instruction ? { instruction: input.instruction } : {}),
		});

		return {
			block: mergeTranslatedResumeBlock(target.block, translated, target.sectionType),
			sectionType: target.sectionType,
		};
	} catch (error) {
		if (isCredentialEncryptionUnavailable(error)) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message: "AI providers are unavailable because ENCRYPTION_SECRET is not configured.",
			});
		}
		if (error instanceof ORPCError) throw error;
		if (isInvalidAiBaseUrlError(error))
			throw new ORPCError("BAD_REQUEST", { message: "Invalid AI provider configuration." });
		if (error instanceof AISDKError) throwAiProviderGatewayError(error);
		if (
			error instanceof SyntaxError ||
			error instanceof ZodError ||
			(error instanceof Error && error.message.startsWith("AI returned"))
		) {
			throw new ORPCError("BAD_REQUEST", { message: "The AI provider returned an invalid block translation." });
		}
		throw error;
	}
}

/** Authenticated CRUD for the optional language variants of a resume. */
export const variantsRouter = {
	list: protectedProcedure
		.route({
			method: "GET",
			path: "/resumes/{resumeId}/variants",
			tags: ["Resumes"],
			operationId: "listResumeVariants",
			summary: "List resume language variants",
			successDescription: "The language variants belonging to the resume.",
		})
		.input(resumeDto.variants.list.input)
		.output(resumeDto.variants.list.output)
		.handler(({ context, input }) =>
			resumeService.variants.list({ resumeId: input.resumeId, userId: context.user.id }),
		),

	get: protectedProcedure
		.route({
			method: "GET",
			path: "/resumes/{resumeId}/variants/{locale}",
			tags: ["Resumes"],
			operationId: "getResumeVariant",
			summary: "Get a resume language variant",
			successDescription: "The requested language variant.",
		})
		.input(resumeDto.variants.get.input)
		.output(resumeDto.variants.get.output)
		.handler(({ context, input }) =>
			resumeService.variants.get({ resumeId: input.resumeId, locale: input.locale, userId: context.user.id }),
		),

	create: protectedProcedure
		.route({
			method: "POST",
			path: "/resumes/{resumeId}/variants",
			tags: ["Resumes"],
			operationId: "createResumeVariant",
			summary: "Create a resume language variant",
			successDescription: "The new language variant.",
		})
		.input(resumeDto.variants.create.input)
		.use(resumeMutationRateLimit)
		.output(resumeDto.variants.create.output)
		.handler(({ context, input }) =>
			resumeService.variants.create({
				resumeId: input.resumeId,
				locale: input.locale,
				userId: context.user.id,
			}),
		),

	translate: protectedProcedure
		.route({
			method: "POST",
			path: "/resumes/{resumeId}/variants/translate",
			tags: ["Resumes"],
			operationId: "translateResumeVariant",
			summary: "Create an AI-translated resume language variant",
			successDescription: "The translated language variant.",
		})
		.input(resumeDto.variants.translate.input)
		.use(aiRequestRateLimit)
		.output(resumeDto.variants.translate.output)
		.errors({
			BAD_REQUEST: { message: "The translation request or AI provider configuration is invalid.", status: 400 },
			BAD_GATEWAY: { message: "Could not reach the AI provider.", status: 502 },
			PRECONDITION_FAILED: { message: "AI providers are unavailable.", status: 412 },
			RESUME_VERSION_CONFLICT: { message: "The primary resume changed during translation.", status: 409 },
		})
		.handler(({ context, input }) =>
			createAiVariant({
				resumeId: input.resumeId,
				locale: input.locale,
				userId: context.user.id,
				...(input.aiProviderId ? { aiProviderId: input.aiProviderId } : {}),
				...(input.observability ? { observability: input.observability } : {}),
			}),
		),

	translateBlock: protectedProcedure
		.route({
			method: "POST",
			path: "/resumes/{resumeId}/variants/{locale}/blocks/translate",
			tags: ["Resumes"],
			operationId: "translateResumeVariantBlock",
			summary: "Translate one block in a resume language variant",
			successDescription: "The translated block suggestion.",
		})
		.input(resumeDto.variants.translateBlock.input)
		.use(aiRequestRateLimit)
		.output(resumeDto.variants.translateBlock.output)
		.errors({
			BAD_REQUEST: { message: "The block translation request or AI provider configuration is invalid.", status: 400 },
			BAD_GATEWAY: { message: "Could not reach the AI provider.", status: 502 },
			PRECONDITION_FAILED: { message: "AI providers are unavailable.", status: 412 },
		})
		.handler(({ context, input }) =>
			translateVariantBlock({
				resumeId: input.resumeId,
				locale: input.locale,
				sectionType: input.sectionType,
				blockId: input.blockId,
				...(input.customSectionId ? { customSectionId: input.customSectionId } : {}),
				...(input.instruction ? { instruction: input.instruction } : {}),
				userId: context.user.id,
				...(input.aiProviderId ? { aiProviderId: input.aiProviderId } : {}),
				...(input.observability ? { observability: input.observability } : {}),
			}),
		),

	update: protectedProcedure
		.route({
			method: "PUT",
			path: "/resumes/{resumeId}/variants/{locale}",
			tags: ["Resumes"],
			operationId: "updateResumeVariant",
			summary: "Update a resume language variant",
			successDescription: "The updated language variant.",
		})
		.input(resumeDto.variants.update.input)
		.use(resumeMutationRateLimit)
		.output(resumeDto.variants.update.output)
		.errors({
			RESUME_VERSION_CONFLICT: {
				message: "The language variant changed after this edit was generated.",
				status: 409,
			},
		})
		.handler(({ context, input }) =>
			resumeService.variants.update({
				resumeId: input.resumeId,
				locale: input.locale,
				userId: context.user.id,
				...(input.data ? { data: input.data } : {}),
				...(input.layoutMode ? { layoutMode: input.layoutMode } : {}),
				...(input.blockStatuses ? { blockStatuses: input.blockStatuses } : {}),
				...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
			}),
		),

	delete: protectedProcedure
		.route({
			method: "DELETE",
			path: "/resumes/{resumeId}/variants/{locale}",
			tags: ["Resumes"],
			operationId: "deleteResumeVariant",
			summary: "Delete a resume language variant",
			successDescription: "The language variant was deleted.",
		})
		.input(resumeDto.variants.delete.input)
		.use(resumeMutationRateLimit)
		.output(resumeDto.variants.delete.output)
		.handler(({ context, input }) =>
			resumeService.variants.delete({ resumeId: input.resumeId, locale: input.locale, userId: context.user.id }),
		),
};
