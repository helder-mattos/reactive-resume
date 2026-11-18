import { lazy, Suspense } from "react";
import { useCurrentResume } from "@/features/resume/builder/draft";
import { useSectionStore } from "../../../-store/section";
import { SectionBase } from "../shared/section-base";

const StylesheetEditorShell = lazy(() => import("@/features/resume/stylesheet/editor"));

export function CustomStylesSectionBuilder() {
	const resume = useCurrentResume();
	const sharedLayout = resume.variantLocale && resume.variantLayoutMode === "shared";
	const collapsed = useSectionStore((state) => state.sections.styles?.collapsed ?? false);

	return (
		<SectionBase type="styles" className={`space-y-4 ${sharedLayout ? "pointer-events-none opacity-60" : ""}`}>
			{collapsed ? null : (
				<Suspense
					fallback={
						<div role="status" className="h-72 animate-pulse rounded-md bg-muted" aria-label="Loading editor" />
					}
				>
					<StylesheetEditorShell />
				</Suspense>
			)}
		</SectionBase>
	);
}
