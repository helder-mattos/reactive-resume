import type { Resume } from "@/features/resume/builder/draft";
import type { BuilderLayout } from "./-store/sidebar";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useMediaQuery } from "usehooks-ts";
import z from "zod";
import { getResumeTextLengthDrift } from "@reactive-resume/schema/resume/variants";
import { localeSchema } from "@reactive-resume/utils/locale";
import { useBuilderResumeUpdateSubscription, useResumeCleanup, useResumeStore } from "@/features/resume/builder/draft";
import { initializeStylesheetStore, useStylesheetStore } from "@/features/resume/stylesheet/store";
import { orpc } from "@/libs/orpc/client";
import { createNoindexFollowMeta } from "@/libs/seo";
import { DesktopBuilderShell } from "./-components/desktop-builder-shell";
import { MobileBuilderShell } from "./-components/mobile-builder-shell";
import { getBuilderLayout } from "./-store/sidebar";

export const Route = createFileRoute("/builder/$resumeId")({
	component: RouteComponent,
	validateSearch: z.object({ locale: z.string().optional() }),
	beforeLoad: ({ context }) => {
		if (!context.session) throw redirect({ to: "/auth/login", replace: true });
		return { session: context.session };
	},
	loader: async ({ params, context }) => {
		const [layout, resume] = await Promise.all([
			getBuilderLayout(),
			context.queryClient.ensureQueryData(orpc.resume.getById.queryOptions({ input: { id: params.resumeId } })),
			context.queryClient.ensureQueryData(
				orpc.resume.variants.list.queryOptions({ input: { resumeId: params.resumeId } }),
			),
			context.queryClient.ensureQueryData(
				orpc.resume.stylesheet.getState.queryOptions({ input: { id: params.resumeId } }),
			),
		]);
		return { layout, name: resume.name };
	},
	head: ({ loaderData }) => ({
		meta: loaderData
			? [{ title: `${loaderData.name} - Reactive Resume` }, createNoindexFollowMeta()]
			: [createNoindexFollowMeta()],
	}),
});

function RouteComponent() {
	const { layout: initialLayout } = Route.useLoaderData();

	const { resumeId } = Route.useParams();
	const { locale } = Route.useSearch();
	const navigate = useNavigate();
	const { data: resume } = useSuspenseQuery(orpc.resume.getById.queryOptions({ input: { id: resumeId } }));
	const { data: variants } = useSuspenseQuery(orpc.resume.variants.list.queryOptions({ input: { resumeId } }));
	const { data: stylesheet } = useSuspenseQuery(
		orpc.resume.stylesheet.getState.queryOptions({ input: { id: resumeId } }),
	);
	const initializeResumeStore = useResumeStore((state) => state.initialize);
	const mergeResumeMetadata = useResumeStore((state) => state.mergeResumeMetadata);
	const initializedResume = useResumeStore((state) => state.resume);
	const primaryLocale = resume.data.metadata.page.locale;
	const validRequestedLocale = locale === undefined || localeSchema.safeParse(locale).success;
	const activeVariantQuery = useQuery({
		...orpc.resume.variants.get.queryOptions({
			input: { resumeId, locale: (locale ?? primaryLocale) as never },
		}),
		enabled: Boolean(validRequestedLocale && locale && locale !== primaryLocale),
	});
	const selectedVariant =
		validRequestedLocale && locale && locale !== primaryLocale ? activeVariantQuery.data : undefined;
	const hasRequestedVariant =
		!locale ||
		(validRequestedLocale && (locale === primaryLocale || variants.some((variant) => variant.locale === locale)));
	const activeResume = (
		selectedVariant
			? {
					...resume,
					data: selectedVariant.data,
					updatedAt: selectedVariant.updatedAt,
					variantLocale: selectedVariant.locale,
					variantId: selectedVariant.id,
					variantLayoutMode: selectedVariant.layoutMode,
					variantBlockStatuses: selectedVariant.blockStatuses,
					variantTextLengthDrift: getResumeTextLengthDrift(resume.data, selectedVariant.data),
				}
			: resume
	) as Resume;
	const isInitialized =
		initializedResume?.id === resumeId && initializedResume?.variantLocale === selectedVariant?.locale;
	const isStylesheetInitialized = useStylesheetStore((state) => state.resumeId === resumeId);
	const stylesheetInitialization = useRef({ resume: activeResume, stylesheet });
	stylesheetInitialization.current = { resume: activeResume, stylesheet };

	useResumeCleanup();
	useBuilderResumeUpdateSubscription();

	useEffect(() => {
		if (!hasRequestedVariant || locale === primaryLocale) {
			void navigate({ to: "/builder/$resumeId", params: { resumeId }, search: {}, replace: true });
		}
	}, [hasRequestedVariant, locale, navigate, primaryLocale, resumeId]);

	useEffect(() => {
		if (isInitialized) return;
		initializeResumeStore(activeResume);
	}, [activeResume, initializeResumeStore, isInitialized]);

	useEffect(() => {
		if (!isInitialized) return;
		const initial = stylesheetInitialization.current;
		return initializeStylesheetStore({
			resumeId,
			initial: initial.stylesheet,
			resumeData: initial.resume.data,
		});
	}, [isInitialized, resumeId]);

	useEffect(() => {
		mergeResumeMetadata(activeResume);
	}, [mergeResumeMetadata, activeResume]);

	if ((locale && locale !== primaryLocale && !activeVariantQuery.data) || !isInitialized || !isStylesheetInitialized)
		return null;

	return <BuilderLayoutShell initialLayout={initialLayout} />;
}

function BuilderLayoutShell({ initialLayout }: { initialLayout: BuilderLayout }) {
	// Single breakpoint (below `md`) switches between the desktop resizable panels and the mobile tabbed shell.
	const isMobile = useMediaQuery("(max-width: 767px)", { initializeWithValue: false });

	if (isMobile) return <MobileBuilderShell />;
	return <DesktopBuilderShell initialLayout={initialLayout} />;
}
