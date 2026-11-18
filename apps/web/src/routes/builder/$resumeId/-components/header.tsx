import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	CaretDownIcon,
	CheckCircleIcon,
	CircleNotchIcon,
	CopySimpleIcon,
	DownloadSimpleIcon,
	GlobeHemisphereWestIcon,
	HouseSimpleIcon,
	LockSimpleIcon,
	LockSimpleOpenIcon,
	PencilSimpleLineIcon,
	SidebarSimpleIcon,
	SparkleIcon,
	TrashSimpleIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { useAIStore } from "@reactive-resume/ai/store";
import { Button } from "@reactive-resume/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@reactive-resume/ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@reactive-resume/ui/components/dropdown-menu";
import { useDialogStore } from "@/dialogs/store";
import { getLocaleOptions } from "@/features/locale/locale-options";
import {
	useCurrentBuilderResumeSelector,
	useCurrentResume,
	usePatchResume,
	useResumeStore,
} from "@/features/resume/builder/draft";
import { ResumeDownloadDialog } from "@/features/resume/export/download-dialog";
import { useHasUsableAiProvider } from "@/features/settings/integrations/hooks/use-has-usable-ai-provider";
import { useConfirm } from "@/hooks/use-confirm";
import { getOrpcErrorMessage, getResumeErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";
import { useBuilderSidebar } from "../-store/sidebar";
import { BuilderAiAssistant } from "./ai-assistant";
import { BuilderVersionHistory } from "./version-history";

export function BuilderHeader() {
	// Subscribe to only the metadata fields this header renders. Selecting the whole resume re-renders
	// the header on every keystroke (immer replaces the resume reference on each content edit).
	const name = useCurrentBuilderResumeSelector((resume) => resume.name);
	const isLocked = useCurrentBuilderResumeSelector((resume) => resume.isLocked);
	const resumeId = useCurrentBuilderResumeSelector((resume) => resume.id);
	const variantLocale = useCurrentBuilderResumeSelector((resume) => resume.variantLocale);
	const { toggleSidebar } = useBuilderSidebar();

	// Equal-width flex-1 side groups keep the center title group truly centered regardless of the
	// wider Download button on the right.
	return (
		<div className="absolute inset-x-0 top-0 z-50 flex h-14 min-w-0 items-center gap-x-2 border-b bg-popover px-1.5">
			<div className="flex min-w-0 flex-1 items-center justify-start">
				{/* Hidden below `md`: on mobile the sidebar panels never mount, so `toggleSidebar` no-ops — the bottom tab bar handles this. */}
				<Button size="icon" variant="ghost" className="hidden md:flex" onClick={() => toggleSidebar("left")}>
					<SidebarSimpleIcon />
					<span className="sr-only">
						<Trans comment="Screen-reader label for opening or closing the left sidebar in resume builder">
							Toggle left sidebar
						</Trans>
					</span>
				</Button>
			</div>

			<div className="flex min-w-0 items-center gap-x-1">
				<Button
					size="icon"
					variant="ghost"
					aria-label={t({
						comment: "Accessible label for button navigating from builder to resumes dashboard",
						message: "Go to resumes dashboard",
					})}
					nativeButton={false}
					render={
						<Link to="/dashboard/resumes" search={{ sort: "lastUpdatedAt", tags: [] }}>
							<HouseSimpleIcon />
						</Link>
					}
				/>
				<span className="me-2.5 text-muted-foreground">/</span>
				<LanguageSwitcher />
				<span className="me-1 text-muted-foreground">/</span>
				<h2 className="min-w-0 truncate font-medium">{name}</h2>
				{isLocked && <LockSimpleIcon className="ms-2 text-muted-foreground" />}
				<SaveStatusIndicator />
				{!variantLocale && <BuilderAiAssistant resumeId={resumeId} />}
				{!variantLocale && <BuilderVersionHistory resumeId={resumeId} />}
				<BuilderHeaderDropdown />
			</div>

			<div className="flex min-w-0 flex-1 items-center justify-end gap-x-1">
				<ResumeDownloadButton />

				<Button size="icon" variant="ghost" className="hidden md:flex" onClick={() => toggleSidebar("right")}>
					<SidebarSimpleIcon className="-scale-x-100" />
					<span className="sr-only">
						<Trans comment="Screen-reader label for opening or closing the right sidebar in resume builder">
							Toggle right sidebar
						</Trans>
					</span>
				</Button>
			</div>
		</div>
	);
}

const LANGUAGE_OPTIONS = getLocaleOptions().map((option) => ({ locale: option.value, label: option.textValue }));

function localeLabel(locale: string) {
	return LANGUAGE_OPTIONS.find((option) => option.locale === locale)?.label ?? locale;
}

function localeCode(locale: string) {
	return locale.split("-")[0]?.toUpperCase() ?? locale.toUpperCase();
}

function LanguageSwitcher() {
	const resume = useCurrentResume();
	const patchResume = usePatchResume();
	const confirm = useConfirm();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [dialogOpen, setDialogOpen] = useState(false);
	const [newLocale, setNewLocale] = useState("");
	const [translationMode, setTranslationMode] = useState<"copy" | "ai">("copy");
	const [aiProviderIdOverride, setAiProviderIdOverride] = useState<string | undefined>();
	const observability = useAIStore((state) => state.observability);
	const { usableProviders, isLoading: isLoadingProviders, error: providersError } = useHasUsableAiProvider();
	const { data: primaryResume } = useQuery(orpc.resume.getById.queryOptions({ input: { id: resume.id } }));
	const { data: variants } = useQuery(orpc.resume.variants.list.queryOptions({ input: { resumeId: resume.id } }));
	const { mutate: createVariant, isPending: isCreating } = useMutation(orpc.resume.variants.create.mutationOptions());
	const { mutate: translateVariant, isPending: isTranslating } = useMutation(
		orpc.resume.variants.translate.mutationOptions(),
	);
	const { mutate: updateVariant } = useMutation(orpc.resume.variants.update.mutationOptions());
	const primaryLocale = primaryResume?.data.metadata.page.locale ?? resume.data.metadata.page.locale;
	const activeLocale = resume.variantLocale ?? primaryLocale ?? "en-US";
	const available = LANGUAGE_OPTIONS.filter(
		(option) => option.locale !== primaryLocale && !variants?.some((variant) => variant.locale === option.locale),
	);
	const canAddVariant = variants !== undefined && variants.length === 0 && available.length > 0;
	const aiProviderId = aiProviderIdOverride ?? usableProviders[0]?.id;
	const isPending = isCreating || isTranslating;
	const needsReviewCount = Object.values(resume.variantBlockStatuses ?? {}).filter(
		(status) => status.status === "needs-review",
	).length;
	const canCreate =
		Boolean(newLocale) && !isPending && (translationMode === "copy" || (!isLoadingProviders && Boolean(aiProviderId)));

	const switchTo = (locale: string | undefined) => {
		void navigate({
			to: "/builder/$resumeId",
			params: { resumeId: resume.id },
			search: locale ? { locale } : {},
		});
	};

	const handleCreate = () => {
		if (!canCreate || variants?.length) return;
		const onSuccess = (variant: NonNullable<typeof variants>[number]) => {
			setDialogOpen(false);
			setNewLocale("");
			setTranslationMode("copy");
			queryClient.setQueryData(
				orpc.resume.variants.list.queryOptions({ input: { resumeId: resume.id } }).queryKey,
				(currentVariants: typeof variants | undefined) => [...(currentVariants ?? []), variant],
			);
			void queryClient.invalidateQueries({
				queryKey: orpc.resume.variants.list.queryKey({ input: { resumeId: resume.id } }),
			});
			switchTo(variant.locale);
		};
		const onError = (error: unknown) => {
			toast.error(
				translationMode === "ai"
					? getOrpcErrorMessage(error, {
							fallback: t`Translation failed. Check your AI provider and try again.`,
							byCode: {
								BAD_GATEWAY: t`The AI provider could not be reached. Try again or choose another provider.`,
								BAD_REQUEST: t`The AI provider returned an invalid translation. Try again or edit the variant manually.`,
								PRECONDITION_FAILED: t`AI translation is unavailable until a provider is configured and tested.`,
								RESUME_VERSION_CONFLICT: t`The primary resume changed while translating. Start again to use the latest content.`,
							},
						})
					: getResumeErrorMessage(error),
			);
		};
		if (translationMode === "ai") {
			translateVariant(
				{
					resumeId: resume.id,
					locale: newLocale as never,
					...(aiProviderId ? { aiProviderId } : {}),
					...(observability ? { observability } : {}),
				} as never,
				{ onSuccess, onError },
			);
		} else {
			createVariant({ resumeId: resume.id, locale: newLocale as never }, { onSuccess, onError });
		}
	};
	const handleMarkReviewed = () => {
		if (!resume.variantLocale || needsReviewCount === 0) return;
		const blockStatuses = Object.fromEntries(
			Object.entries(resume.variantBlockStatuses ?? {}).map(([blockId, status]) => [
				blockId,
				status.status === "needs-review" ? { ...status, status: "up-to-date" as const } : status,
			]),
		);
		updateVariant(
			{
				resumeId: resume.id,
				locale: resume.variantLocale as never,
				blockStatuses,
				expectedUpdatedAt: resume.updatedAt,
			},
			{
				onSuccess: (variant) => {
					patchResume((draft) => {
						draft.variantBlockStatuses = variant.blockStatuses;
						draft.updatedAt = variant.updatedAt;
					});
					queryClient.setQueryData(
						orpc.resume.variants.get.queryOptions({
							input: { resumeId: resume.id, locale: resume.variantLocale as never },
						}).queryKey,
						variant,
					);
					void queryClient.invalidateQueries({
						queryKey: orpc.resume.variants.list.queryKey({ input: { resumeId: resume.id } }),
					});
				},
				onError: (error) => toast.error(getResumeErrorMessage(error)),
			},
		);
	};
	const handleToggleLayout = async () => {
		if (!resume.variantLocale) return;
		const nextMode = resume.variantLayoutMode === "custom" ? "shared" : "custom";
		if (nextMode === "shared") {
			const confirmed = await confirm(t`Use the primary language layout for this variant?`, {
				description: t`Custom spacing, typography, and page breaks will be replaced by the shared layout.`,
			});
			if (!confirmed) return;
		}
		updateVariant(
			{
				resumeId: resume.id,
				locale: resume.variantLocale as never,
				layoutMode: nextMode,
				expectedUpdatedAt: resume.updatedAt,
			},
			{
				onSuccess: (variant) => {
					patchResume((draft) => {
						draft.data = variant.data;
						draft.updatedAt = variant.updatedAt;
						draft.variantLayoutMode = variant.layoutMode;
					});
					queryClient.setQueryData(
						orpc.resume.variants.get.queryOptions({
							input: { resumeId: resume.id, locale: resume.variantLocale as never },
						}).queryKey,
						variant,
					);
					void queryClient.invalidateQueries({
						queryKey: orpc.resume.variants.list.queryKey({ input: { resumeId: resume.id } }),
					});
				},
				onError: (error) => toast.error(getResumeErrorMessage(error)),
			},
		);
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							size="sm"
							variant="ghost"
							className="max-w-32 gap-1 px-1.5 max-sm:max-w-14"
							aria-label={t`Switch resume language`}
						>
							<GlobeHemisphereWestIcon />
							<span className="truncate text-xs">
								<span className="sm:hidden">{localeCode(activeLocale)}</span>
								<span className="hidden sm:inline">{localeLabel(activeLocale)}</span>
							</span>
							{resume.variantLocale && (needsReviewCount > 0 || resume.variantTextLengthDrift?.warning) && (
								<WarningCircleIcon
									className="text-amber-600"
									aria-label={t`This translation may need review or change page breaks`}
								/>
							)}
							{resume.variantLocale && needsReviewCount > 0 && (
								<span className="text-[10px] text-amber-700" title={t`${needsReviewCount} blocks need review`}>
									{needsReviewCount}
								</span>
							)}
						</Button>
					}
				/>
				<DropdownMenuContent align="center">
					<DropdownMenuItem disabled={!primaryLocale} onClick={() => switchTo(undefined)}>
						{primaryLocale ? `${localeLabel(primaryLocale)} (Primary)` : localeLabel(resume.data.metadata.page.locale)}
					</DropdownMenuItem>
					{variants?.map((variant) => (
						<DropdownMenuItem key={variant.id} onClick={() => switchTo(variant.locale)}>
							{localeLabel(variant.locale)}
						</DropdownMenuItem>
					))}
					{resume.variantLocale && (
						<>
							{resume.variantTextLengthDrift?.warning && (
								<DropdownMenuItem disabled>
									<WarningCircleIcon className="text-amber-600" />
									<Trans>Translation may change page breaks</Trans>
								</DropdownMenuItem>
							)}
							{needsReviewCount > 0 && (
								<DropdownMenuItem onClick={handleMarkReviewed}>
									<Trans>Mark {needsReviewCount} translated blocks as reviewed</Trans>
								</DropdownMenuItem>
							)}
							<DropdownMenuItem onClick={handleToggleLayout}>
								{resume.variantLayoutMode === "custom" ? (
									<Trans>Use shared layout</Trans>
								) : (
									<Trans>Customize layout for this language</Trans>
								)}
							</DropdownMenuItem>
						</>
					)}
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={() => setDialogOpen(true)} disabled={!canAddVariant}>
						<Trans>Add language</Trans>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={dialogOpen} onOpenChange={(open) => !isPending && setDialogOpen(open)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							<Trans>Add a language variant</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>Start with a copy of this resume. You can translate each block independently.</Trans>
						</DialogDescription>
					</DialogHeader>
					<label className="grid gap-2">
						<span className="font-medium">
							<Trans>Language</Trans>
						</span>
						<select
							className="h-9 rounded-lg border bg-transparent px-2"
							value={newLocale}
							disabled={isPending}
							onChange={(event) => setNewLocale(event.target.value)}
						>
							<option value="">
								<Trans>Select a language</Trans>
							</option>
							{available.map((option) => (
								<option key={option.locale} value={option.locale}>
									{option.label}
								</option>
							))}
						</select>
					</label>
					<label className="grid gap-2">
						<span className="font-medium">
							<Trans>Starting point</Trans>
						</span>
						<select
							className="h-9 rounded-lg border bg-transparent px-2"
							value={translationMode}
							disabled={isPending}
							onChange={(event) => setTranslationMode(event.target.value as "copy" | "ai")}
						>
							<option value="copy">
								<Trans>Copy resume (translate manually)</Trans>
							</option>
							<option value="ai">
								<Trans>Translate with AI</Trans>
							</option>
						</select>
					</label>
					{translationMode === "ai" && (
						<div className="grid gap-2 rounded-lg border border-dashed p-3 text-sm">
							<label className="grid gap-2">
								<span className="font-medium">
									<Trans>AI provider</Trans>
								</span>
								<select
									className="h-9 rounded-lg border bg-transparent px-2"
									value={aiProviderId ?? ""}
									disabled={isPending || isLoadingProviders || usableProviders.length === 0}
									onChange={(event) => setAiProviderIdOverride(event.target.value || undefined)}
								>
									<option value="">{isLoadingProviders ? t`Loading providers…` : t`Select an AI provider`}</option>
									{usableProviders.map((provider) => (
										<option key={provider.id} value={provider.id}>
											{provider.label} · {provider.model}
										</option>
									))}
								</select>
							</label>
							{providersError ? (
								<p className="text-destructive">
									<Trans>AI providers are unavailable. Check your integrations settings.</Trans>
								</p>
							) : usableProviders.length === 0 && !isLoadingProviders ? (
								<p className="text-muted-foreground">
									<Trans>Connect and test an AI provider before using automatic translation.</Trans>
								</p>
							) : (
								<p className="flex items-center gap-1 text-muted-foreground">
									<SparkleIcon />
									<Trans>Preserves your resume structure and aims for similar text lengths.</Trans>
								</p>
							)}
						</div>
					)}
					<DialogFooter>
						<Button variant="outline" disabled={isPending} onClick={() => setDialogOpen(false)}>
							<Trans>Cancel</Trans>
						</Button>
						<Button disabled={!canCreate} onClick={handleCreate}>
							{isPending ? (
								<CircleNotchIcon className="animate-spin" />
							) : translationMode === "ai" ? (
								<SparkleIcon />
							) : null}
							{isPending ? <Trans>Translating…</Trans> : <Trans>Create variant</Trans>}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function ResumeDownloadButton() {
	const resume = useCurrentResume();

	return (
		<ResumeDownloadDialog
			resume={resume}
			trigger={(disabled) => (
				<Button
					size="sm"
					aria-label={t({
						comment: "Primary action in the builder header to open resume download options",
						message: "Download options",
					})}
					disabled={disabled}
					className="px-2 sm:px-2.5"
				>
					{disabled ? (
						<CircleNotchIcon className="animate-spin sm:me-1.5" />
					) : (
						<DownloadSimpleIcon className="sm:me-1.5" />
					)}
					<span className="hidden sm:inline">
						<Trans comment="Primary action in the builder header to open resume download options">Download</Trans>
					</span>
				</Button>
			)}
		/>
	);
}

function SaveStatusIndicator() {
	const status = useResumeStore((state) => state.saveStatus);
	if (status === "idle") return null;

	const { icon, label } = match(status)
		.with("saving", () => ({
			icon: <CircleNotchIcon className="animate-spin" />,
			label: t`Saving…`,
		}))
		.with("saved", () => ({ icon: <CheckCircleIcon />, label: t`Saved` }))
		.with("error", () => ({
			icon: <WarningCircleIcon className="text-destructive" />,
			label: t`Couldn't save`,
		}))
		.exhaustive();

	return (
		<span
			className="ms-1 flex shrink-0 items-center gap-x-1 text-muted-foreground text-xs"
			aria-live="polite"
			role="status"
		>
			{icon}
			<span className="hidden md:inline">{label}</span>
		</span>
	);
}

function BuilderHeaderDropdown() {
	const confirm = useConfirm();
	const navigate = useNavigate();
	const { openDialog } = useDialogStore();

	const resume = useCurrentResume();
	const patchResume = usePatchResume();
	const id = resume.id;
	const name = resume.name;
	const slug = resume.slug;
	const tags = resume.tags;
	const isLocked = resume.isLocked;

	const { mutate: deleteResume } = useMutation(orpc.resume.delete.mutationOptions());
	const { mutate: setLockedResume } = useMutation(orpc.resume.setLocked.mutationOptions());

	const handleUpdate = () => {
		openDialog("resume.update", { id, name, slug, tags });
	};

	const handleDuplicate = () => {
		openDialog("resume.duplicate", { id, name, slug, tags, shouldRedirect: true });
	};

	const handleToggleLock = async () => {
		if (!isLocked) {
			const confirmation = await confirm(t`Are you sure you want to lock this resume?`, {
				description: t`When locked, the resume cannot be updated or deleted.`,
			});

			if (!confirmation) return;
		}

		setLockedResume(
			{ id, isLocked: !isLocked },
			{
				onSuccess: () => {
					patchResume((draft) => {
						draft.isLocked = !isLocked;
					});
				},
				onError: (error) => {
					toast.error(getResumeErrorMessage(error));
				},
			},
		);
	};

	const handleDelete = async () => {
		const confirmation = await confirm(t`Are you sure you want to delete this resume?`, {
			description: t`This action cannot be undone.`,
		});

		if (!confirmation) return;

		const toastId = toast.loading(t`Deleting your resume...`);

		deleteResume(
			{ id },
			{
				onSuccess: () => {
					toast.success(t`Your resume has been deleted successfully.`, { id: toastId });
					void navigate({ to: "/dashboard/resumes", search: { sort: "lastUpdatedAt", tags: [] } });
				},
				onError: (error) => {
					toast.error(getResumeErrorMessage(error), { id: toastId });
				},
			},
		);
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button size="icon" variant="ghost" aria-label={t`Resume options`}>
						<CaretDownIcon />
					</Button>
				}
			/>

			<DropdownMenuContent>
				<DropdownMenuItem disabled={isLocked} onClick={handleUpdate}>
					<PencilSimpleLineIcon className="me-2" />
					<Trans>Edit details</Trans>
				</DropdownMenuItem>

				{!resume.variantLocale && (
					<DropdownMenuItem onClick={handleDuplicate}>
						<CopySimpleIcon className="me-2" />
						<Trans>Duplicate</Trans>
					</DropdownMenuItem>
				)}

				<DropdownMenuItem onClick={handleToggleLock}>
					{isLocked ? <LockSimpleOpenIcon className="me-2" /> : <LockSimpleIcon className="me-2" />}
					{isLocked ? <Trans>Unlock</Trans> : <Trans>Lock</Trans>}
				</DropdownMenuItem>

				<DropdownMenuSeparator />

				{!resume.variantLocale && (
					<DropdownMenuItem variant="destructive" disabled={isLocked} onClick={handleDelete}>
						<TrashSimpleIcon className="me-2" />
						<Trans>Delete</Trans>
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
