import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { CircleNotchIcon, SparkleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useAIStore } from "@reactive-resume/ai/store";
import { findResumeVariantBlock } from "@reactive-resume/schema/resume/variants";
import { Button } from "@reactive-resume/ui/components/button";
import { Textarea } from "@reactive-resume/ui/components/textarea";
import { stripHtml } from "@reactive-resume/utils/string";
import { getLocaleOptions } from "@/features/locale/locale-options";
import { useResume } from "@/features/resume/builder/draft";
import { useHasUsableAiProvider } from "@/features/settings/integrations/hooks/use-has-usable-ai-provider";
import { getOrpcErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

type TranslatedEditorAssistProps = {
	sectionType: string;
	blockId: string;
	customSectionId?: string;
	onApply: (block: Record<string, unknown>) => void;
};

const NON_PROSE_KEYS = new Set([
	"id",
	"hidden",
	"url",
	"inlineLink",
	"period",
	"location",
	"grade",
	"level",
	"icon",
	"iconColor",
]);

function collectOriginalText(value: unknown, key?: string, output: string[] = []): string[] {
	if (typeof value === "string") {
		if (!key || !NON_PROSE_KEYS.has(key)) {
			const text = stripHtml(value).trim();
			if (text) output.push(text);
		}
		return output;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectOriginalText(item, key, output);
		return output;
	}
	if (value && typeof value === "object") {
		for (const [childKey, childValue] of Object.entries(value)) collectOriginalText(childValue, childKey, output);
	}
	return output;
}

function localeName(locale: string) {
	return getLocaleOptions().find((option) => option.value === locale)?.textValue ?? locale;
}

export function TranslatedEditorAssist({
	sectionType,
	blockId,
	customSectionId,
	onApply,
}: TranslatedEditorAssistProps) {
	const resume = useResume();
	const observability = useAIStore((state) => state.observability);
	const [instruction, setInstruction] = useState("");
	const [showInstruction, setShowInstruction] = useState(false);
	const { hasUsableProvider, isLoading: isLoadingProviders } = useHasUsableAiProvider();
	const resumeId = resume?.id ?? "";
	const variantLocale = resume?.variantLocale;
	const { data: primary } = useQuery({
		...orpc.resume.getById.queryOptions({ input: { id: resumeId } }),
		enabled: Boolean(resumeId && variantLocale),
	});
	const { mutate: translateBlock, isPending } = useMutation(orpc.resume.variants.translateBlock.mutationOptions());

	if (!resume?.variantLocale || !primary?.data) return null;

	const source = findResumeVariantBlock(primary.data, sectionType, blockId, customSectionId);
	if (!source) return null;

	const originalText = collectOriginalText(source.block).join("\n");
	const canTranslate = !isPending && !isLoadingProviders && hasUsableProvider;

	const handleTranslate = () => {
		if (!canTranslate) return;
		translateBlock(
			{
				resumeId,
				locale: resume.variantLocale as never,
				sectionType,
				blockId,
				...(customSectionId ? { customSectionId } : {}),
				...(instruction.trim() ? { instruction: instruction.trim() } : {}),
				...(observability ? { observability } : {}),
			} as never,
			{
				onSuccess: (result) => {
					onApply(result.block);
					toast.success(t`Translation applied. Review it before saving.`);
				},
				onError: (error) => {
					toast.error(
						getOrpcErrorMessage(error, {
							fallback: t`The block could not be translated. Try again or edit it manually.`,
							byCode: {
								BAD_GATEWAY: t`The AI provider could not be reached. Try again.`,
								BAD_REQUEST: t`The AI provider returned an invalid translation. Try again.`,
								PRECONDITION_FAILED: t`Translation is unavailable until an AI provider is configured and tested.`,
							},
						}),
					);
				},
			},
		);
	};

	return (
		<div className="rounded-lg border border-dashed bg-muted/20 p-3 sm:col-span-full">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="min-w-0">
					<p className="font-medium text-sm">
						<Trans>Original text ({localeName(primary.data.metadata.page.locale)})</Trans>
					</p>
					<p className="text-muted-foreground text-xs">
						<Trans>Use this as a reference while editing the translated version.</Trans>
					</p>
				</div>
				<Button type="button" size="sm" variant="outline" onClick={handleTranslate} disabled={!canTranslate}>
					{isPending ? <CircleNotchIcon className="animate-spin" /> : <SparkleIcon />}
					{isPending ? <Trans>Translating…</Trans> : <Trans>Translate with AI</Trans>}
				</Button>
			</div>

			{originalText ? (
				<p className="mt-3 max-h-28 overflow-y-auto whitespace-pre-wrap border-primary/30 border-s ps-3 text-muted-foreground text-xs leading-relaxed">
					{originalText}
				</p>
			) : null}

			<div className="mt-3">
				<Button type="button" size="xs" variant="ghost" onClick={() => setShowInstruction((value) => !value)}>
					{showInstruction ? <Trans>Hide instruction</Trans> : <Trans>Add an instruction</Trans>}
				</Button>
				{showInstruction ? (
					<Textarea
						value={instruction}
						onChange={(event) => setInstruction(event.target.value)}
						placeholder={t`For example: keep this concise, use a formal tone, or preserve the product name.`}
						maxLength={1000}
						className="mt-2 min-h-16 text-xs"
						disabled={isPending}
					/>
				) : null}
			</div>
		</div>
	);
}
