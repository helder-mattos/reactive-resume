import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	getById: vi.fn(),
	get: vi.fn(),
	list: vi.fn(),
	getDefaultRunnable: vi.fn(),
	getRunnableById: vi.fn(),
	translateResume: vi.fn(),
	translateResumeBlock: vi.fn(),
}));

vi.mock("../../context", async () => {
	const { os } = await vi.importActual<typeof import("@orpc/server")>("@orpc/server");
	return {
		protectedProcedure: os.$context<{
			locale: "en-US";
			reqHeaders: Headers;
			user: { id: string };
		}>(),
	};
});

vi.mock("./service", () => ({
	resumeService: {
		getById: mocks.getById,
		variants: { create: mocks.create, get: mocks.get, list: mocks.list },
	},
}));

vi.mock("../ai-providers/service", () => ({ aiProvidersService: mocks }));
vi.mock("../ai/service", () => ({
	aiService: { translateResume: mocks.translateResume, translateResumeBlock: mocks.translateResumeBlock },
}));

const { variantsRouter } = await import("./variants");

const variantResponse = (data: ResumeData) => ({
	id: "variant-id",
	resumeId: "resume-id",
	locale: "fr-FR",
	data,
	layoutMode: "shared" as const,
	blockStatuses: {},
	createdAt: new Date("2026-08-01T00:00:00.000Z"),
	updatedAt: new Date("2026-08-01T00:00:00.000Z"),
});

describe("resume variant routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getById.mockResolvedValue({
			data: structuredClone(defaultResumeData),
			isLocked: false,
			updatedAt: new Date("2026-08-01T00:00:00.000Z"),
		});
		mocks.list.mockResolvedValue([]);
		mocks.getDefaultRunnable.mockResolvedValue({
			provider: "openai-compatible",
			model: "test-model",
			apiKey: "test-key",
			baseURL: "https://example.test/v1",
		});
		mocks.getRunnableById.mockResolvedValue({
			provider: "openai-compatible",
			model: "test-model",
			apiKey: "test-key",
			baseURL: "https://example.test/v1",
		});
		mocks.translateResume.mockResolvedValue(structuredClone(defaultResumeData));
		mocks.translateResumeBlock.mockResolvedValue({ id: "experience-1", position: "Ingénieur" });
		mocks.get.mockResolvedValue(variantResponse(structuredClone(defaultResumeData)));
		mocks.create.mockImplementation(async (input: { data: ResumeData }) => variantResponse(input.data));
	});

	it("loads update under the nested resume/variants RPC path", () => {
		expect(variantsRouter.update).toBeDefined();
		expect(variantsRouter.update["~orpc"].route.path).toBe("/resumes/{resumeId}/variants/{locale}");
	});

	it("translates primary data server-side before creating an AI variant", async () => {
		const { createRouterClient } = await import("@orpc/server");
		const client = createRouterClient(variantsRouter, {
			context: { locale: "en-US", reqHeaders: new Headers(), user: { id: "user-id" } } as never,
		});

		await client.translate({
			resumeId: "resume-id",
			locale: "fr-FR",
			aiProviderId: "provider-id",
		});

		expect(mocks.getRunnableById).toHaveBeenCalledWith({ id: "provider-id", userId: "user-id" });
		expect(mocks.translateResume).toHaveBeenCalledWith(
			expect.objectContaining({ targetLocale: "fr-FR", resumeData: defaultResumeData }),
		);
		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				locale: "fr-FR",
				initialBlockStatus: "needs-review",
				expectedPrimaryUpdatedAt: new Date("2026-08-01T00:00:00.000Z"),
			}),
		);
	});

	it("translates one existing block with an optional instruction", async () => {
		const primaryData = structuredClone(defaultResumeData);
		primaryData.sections.experience.items.push({
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
		const targetData = structuredClone(primaryData);
		const targetItem = targetData.sections.experience.items[0];
		if (!targetItem) throw new Error("expected target block");
		targetItem.position = "Ingénieur";
		mocks.getById.mockResolvedValue({ data: primaryData, isLocked: false });
		mocks.get.mockResolvedValue(variantResponse(targetData));

		const { createRouterClient } = await import("@orpc/server");
		const client = createRouterClient(variantsRouter, {
			context: { locale: "en-US", reqHeaders: new Headers(), user: { id: "user-id" } } as never,
		});

		const result = await client.translateBlock({
			resumeId: "resume-id",
			locale: "fr-FR",
			sectionType: "experience",
			blockId: "experience-1",
			instruction: "Keep it concise",
		});

		expect(mocks.translateResumeBlock).toHaveBeenCalledWith(
			expect.objectContaining({
				targetLocale: "fr-FR",
				instruction: "Keep it concise",
				sourceBlock: expect.objectContaining({ position: "Engineer" }),
				targetBlock: expect.objectContaining({ position: "Ingénieur" }),
			}),
		);
		expect(result.block).toMatchObject({ id: "experience-1", position: "Ingénieur" });
		expect(result.block).toHaveProperty("company", "Example Corp");
	});
});
