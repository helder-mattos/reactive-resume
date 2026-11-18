import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { VariantBlockStatuses, VariantTextLengthDrift } from "@reactive-resume/schema/resume/variants";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { WritableDraft } from "immer";
import { t } from "@lingui/core/macro";
import { consumeEventIterator } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { debounce, isEqual } from "es-toolkit";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { immer } from "zustand/middleware/immer";
import { create } from "zustand/react";
import { getResumeTextLengthDrift } from "@reactive-resume/schema/resume/variants";
import { refreshStylesheetStore } from "@/features/resume/stylesheet/store";
import { orpc, streamClient } from "@/libs/orpc/client";

export type Resume = {
	id: string;
	name: string;
	slug: string;
	tags: string[];
	data: ResumeData;
	isLocked: boolean;
	updatedAt: Date;
	hasPassword?: boolean;
	isPublic?: boolean;
	/** Present only while editing a secondary language variant. */
	variantLocale?: string;
	variantId?: string;
	variantLayoutMode?: "shared" | "custom";
	variantBlockStatuses?: VariantBlockStatuses;
	variantTextLengthDrift?: VariantTextLengthDrift;
};

// Mirrors the server-side ResumeUpdatedEvent discriminator (packages/api resume/events.ts).
type ResumeUpdateMutation = "sync" | "create" | "update" | "patch" | "lock" | "password" | "delete" | "stylesheet";
type ResumeUpdateEvent = { mutation: ResumeUpdateMutation };

type SaveStatus = "idle" | "saving" | "saved" | "error";

type ResumeStoreState = {
	resume: Resume | null;
	resumeId?: string;
	isReady: boolean;
	saveStatus: SaveStatus;
	// Client-side undo/redo stacks holding whole-`ResumeData` snapshots (see recordHistory helpers below).
	undoStack: ResumeData[];
	redoStack: ResumeData[];
	canUndo: boolean;
	canRedo: boolean;
};

type ResumeStoreActions = {
	initialize: (resume: Resume | null) => void;
	reset: () => void;
	replaceResumeDraft: (resume: Resume) => void;
	replaceResumeFromServer: (resume: Resume) => void;
	updateResumeData: (fn: (draft: WritableDraft<ResumeData>) => void) => void;
	patchResume: (fn: (draft: WritableDraft<Resume>) => void) => void;
	mergeResumeMetadata: (resume: Resume) => void;
	setSaveStatus: (status: SaveStatus) => void;
	undo: () => void;
	redo: () => void;
};

type ResumeStore = ResumeStoreState & ResumeStoreActions;

type Runtime = {
	abortController: AbortController;
	queryClient?: QueryClient;
	hasPendingLocalChanges: boolean;
	isSaving: boolean;
	pendingResume?: Resume;
	inFlightResume?: Resume;
	latestResume?: Resume;
	syncErrorToastId?: string | number;
	syncResume: ReturnType<typeof debounce<(resume: Resume) => void>>;
	beforeUnloadHandler?: () => void;
	deferredRemoteResume?: Resume;
	deferredFocusHandler?: () => void;
	disposeWhenIdle?: boolean;
};

type ResumeUpdateSubscriptionOptions = {
	resumeId?: string;
	onUpdate: (event: ResumeUpdateEvent) => Promise<void> | void;
	onError?: (error: unknown) => void;
};

const SAVE_DEBOUNCE_MS = 500;
// Rapid edits within this window coalesce into a single undo step (e.g. typing a word / dragging).
const HISTORY_COALESCE_MS = 500;
// Bounded stacks: keep undo/redo memory (whole-resume snapshots) predictable during a long session.
const MAX_HISTORY_ENTRIES = 50;
const runtimes = new Map<string, Runtime>();

// Coalescing bookkeeping. Not reactive — only decides whether the next edit opens a new undo step.
let historyLastEditAt = 0;
let historyCanCoalesce = false;

function resetHistoryRuntime() {
	historyLastEditAt = 0;
	historyCanCoalesce = false;
}

let lockedToastId: string | number | undefined;

const MISSING_RESUME = Symbol("missing-resume");
type MissingResume = typeof MISSING_RESUME;

function getResumeQueryKey(id: string): QueryKey {
	return orpc.resume.getById.queryOptions({ input: { id } }).queryKey as QueryKey;
}

function getResumeRuntimeKey(resume: Pick<Resume, "id" | "variantLocale">): string {
	return `${resume.id}:${resume.variantLocale ?? "primary"}`;
}

function cloneResumeData(data: ResumeData): ResumeData {
	return structuredClone(data);
}

function cloneResume(resume: Resume): Resume {
	return { ...resume, data: cloneResumeData(resume.data) };
}

export function isEditableElementFocused(): boolean {
	if (typeof document === "undefined") return false;
	const element = document.activeElement as HTMLElement | null;
	if (!element) return false;
	return (
		element.tagName === "INPUT" ||
		element.tagName === "TEXTAREA" ||
		element.tagName === "SELECT" ||
		element.isContentEditable ||
		element.closest(".cm-editor") !== null
	);
}

function externalUpdateMessage(mutation: ResumeUpdateMutation): string {
	if (mutation === "patch") return t`This resume was updated by an AI agent.`;
	if (mutation === "lock" || mutation === "password") return t`This resume's sharing settings changed elsewhere.`;
	return t`Synced changes made in another tab.`;
}

function notifyExternalUpdate(mutation: ResumeUpdateMutation) {
	toast.info(externalUpdateMessage(mutation), { id: "resume-external-update" });
}

// #54: applies a remote update that was deferred because the user was typing.
function applyDeferredRemoteResume(id: string) {
	const current = useResumeStore.getState().resume;
	const runtime = current?.id === id ? runtimes.get(getResumeRuntimeKey(current)) : runtimes.get(id);
	if (!runtime?.deferredRemoteResume) return;

	const resume = runtime.deferredRemoteResume;
	runtime.deferredRemoteResume = undefined;
	if (runtime.deferredFocusHandler && typeof document !== "undefined") {
		document.removeEventListener("focusout", runtime.deferredFocusHandler, true);
		runtime.deferredFocusHandler = undefined;
	}

	// The user may have started editing again while the update was deferred; local edits win.
	if (runtime.hasPendingLocalChanges) return;

	useResumeStore.getState().replaceResumeFromServer(resume);
	notifyExternalUpdate("update");
}

// #54: don't overwrite a focused field mid-keystroke; stash the remote resume and apply it on blur.
function deferRemoteResumeUntilBlur(id: string, resume: Resume) {
	const runtime = getRuntime(getResumeRuntimeKey(resume));
	runtime.deferredRemoteResume = resume;

	if (runtime.deferredFocusHandler || typeof document === "undefined") return;

	const handler = () => {
		// Let focus settle (e.g. tabbing between fields) before deciding editing has ended.
		window.setTimeout(() => {
			if (isEditableElementFocused()) return;
			applyDeferredRemoteResume(id);
		}, 0);
	};

	runtime.deferredFocusHandler = handler;
	document.addEventListener("focusout", handler, true);
}

function setRuntimeBaseline(resume: Resume) {
	const runtime = getRuntime(getResumeRuntimeKey(resume));
	if (runtime.pendingResume || runtime.inFlightResume || runtime.hasPendingLocalChanges) {
		runtime.hasPendingLocalChanges = true;
		return;
	}
	runtime.hasPendingLocalChanges = false;
	runtime.pendingResume = undefined;
	runtime.latestResume = undefined;
}

async function flushResumeSave(id: string, requestedRuntimeKey?: string) {
	const current = useResumeStore.getState().resume;
	const runtimeKey = requestedRuntimeKey ?? (current?.id === id ? getResumeRuntimeKey(current) : id);
	const runtime = runtimes.get(runtimeKey);
	if (!runtime || runtime.isSaving || !runtime.pendingResume) return;

	const submitted = runtime.pendingResume;
	const submittedData = cloneResumeData(submitted.data);
	runtime.pendingResume = undefined;
	runtime.inFlightResume = submitted;
	runtime.isSaving = true;

	try {
		let updated: Resume;
		if (submitted.variantLocale) {
			const saved = (await orpc.resume.variants.update.call(
				{
					resumeId: submitted.id,
					locale: submitted.variantLocale as never,
					data: submittedData,
					expectedUpdatedAt: submitted.updatedAt,
				},
				{ signal: runtime.abortController.signal },
			)) as {
				id: string;
				resumeId: string;
				locale: string;
				data: ResumeData;
				layoutMode: "shared" | "custom";
				blockStatuses: Record<string, unknown>;
				createdAt: Date;
				updatedAt: Date;
			};
			updated = { ...submitted, data: saved.data, updatedAt: saved.updatedAt };
			runtime.queryClient?.setQueryData(
				orpc.resume.variants.get.queryOptions({
					input: { resumeId: submitted.id, locale: submitted.variantLocale as never },
				}).queryKey,
				saved as never,
			);
			runtime.queryClient?.setQueryData(
				orpc.resume.variants.list.queryOptions({ input: { resumeId: submitted.id } }).queryKey,
				((currentVariants: Array<typeof saved> | undefined) =>
					currentVariants?.map((variant) => (variant.locale === saved.locale ? saved : variant))) as never,
			);
		} else {
			updated = (await orpc.resume.update.call(
				{ id: submitted.id, data: submittedData },
				{ signal: runtime.abortController.signal },
			)) as Resume;
		}

		if (!submitted.variantLocale) {
			runtime.queryClient?.setQueryData(getResumeQueryKey(submitted.id), updated);
			void runtime.queryClient?.invalidateQueries({
				queryKey: orpc.resume.variants.list.queryOptions({ input: { resumeId: submitted.id } }).queryKey,
			});
			void runtime.queryClient?.invalidateQueries({ queryKey: ["resume", "variant", submitted.id] });
		}

		// A newer edit can already be queued while this request is in flight. Rebase every queued
		// snapshot onto the successful server timestamp so its optimistic-concurrency check does not
		// immediately fail on the retry.
		if (submitted.variantLocale) {
			const pendingResume = runtime.pendingResume as Resume | undefined;
			const latestResume = runtime.latestResume as Resume | undefined;
			if (pendingResume && pendingResume.variantLocale === submitted.variantLocale) {
				runtime.pendingResume = { ...pendingResume, updatedAt: updated.updatedAt };
			}
			if (latestResume && latestResume.variantLocale === submitted.variantLocale) {
				runtime.latestResume = { ...latestResume, updatedAt: updated.updatedAt };
			}
		}

		const currentResume = useResumeStore.getState().resume;
		const currentResumeIsSubmissionVariant =
			currentResume?.id === submitted.id && getResumeRuntimeKey(currentResume) === runtimeKey;
		const currentDataStillMatchesSubmission =
			currentResumeIsSubmissionVariant && isEqual(currentResume.data, submittedData);

		if (currentDataStillMatchesSubmission && !runtime.pendingResume) {
			runtime.hasPendingLocalChanges = false;
			if (runtime.latestResume && isEqual(runtime.latestResume.data, submittedData)) runtime.latestResume = undefined;
			// The local data still equals what we just saved, so the client already holds the canonical
			// data — only server-owned metadata (updatedAt, etc.) can differ. Merge just that instead of
			// replacing the whole resume: a full replace swaps every nested reference (the server strips
			// `undefined`s, so an equality check on its echo can't even confirm they match), which fires
			// every `data` selector and remounts the entire builder tree on each save-after-typing.
			if (!isEqual(updated.data, submittedData)) useResumeStore.getState().replaceResumeFromServer(updated);
			else useResumeStore.getState().mergeResumeMetadata(updated);
			useResumeStore.getState().setSaveStatus("saved");
		} else if (currentResumeIsSubmissionVariant) {
			runtime.hasPendingLocalChanges = true;
			useResumeStore.getState().mergeResumeMetadata(updated);

			const latestResume = runtime.latestResume ?? currentResume;
			if (
				!runtime.pendingResume &&
				latestResume?.id === submitted.id &&
				getResumeRuntimeKey(latestResume) === runtimeKey &&
				!isEqual(latestResume.data, submittedData)
			) {
				runtime.syncResume.cancel();
				runtime.pendingResume = cloneResume({ ...latestResume, updatedAt: updated.updatedAt });
			}
		} else {
			// A language switch may have happened while this variant save was in flight. Keep its
			// runtime alive and let the next visit fetch the canonical variant; never merge its metadata
			// into the primary-language draft.
			runtime.hasPendingLocalChanges = false;
		}

		if (runtime.syncErrorToastId !== undefined) {
			toast.dismiss(runtime.syncErrorToastId);
			runtime.syncErrorToastId = undefined;
		}
	} catch (error: unknown) {
		if (error instanceof DOMException && error.name === "AbortError") return;

		runtime.pendingResume ??= submitted;
		runtime.hasPendingLocalChanges = true;
		useResumeStore.getState().setSaveStatus("error");
		runtime.syncErrorToastId = toast.error(t`Your latest changes could not be saved.`, {
			id: runtime.syncErrorToastId,
			duration: Number.POSITIVE_INFINITY,
		});
	} finally {
		runtime.isSaving = false;
		if (runtime.inFlightResume === submitted) runtime.inFlightResume = undefined;
		if (runtime.pendingResume && runtime.syncErrorToastId === undefined) void flushResumeSave(id, runtimeKey);
		if (!runtime.pendingResume && runtime.disposeWhenIdle) disposeRuntime(runtimeKey);
	}
}

function queueResumeSave(resume: Resume) {
	const runtime = getRuntime(getResumeRuntimeKey(resume));
	runtime.pendingResume = cloneResume(resume);
	runtime.hasPendingLocalChanges = true;
	void flushResumeSave(resume.id, getResumeRuntimeKey(resume));
}

function createRuntime(): Runtime {
	const abortController = new AbortController();

	const syncResume = debounce(
		(resume: Resume) => {
			queueResumeSave(runtime.latestResume ?? resume);
		},
		SAVE_DEBOUNCE_MS,
		{ signal: abortController.signal },
	);

	const runtime: Runtime = {
		abortController,
		hasPendingLocalChanges: false,
		isSaving: false,
		syncResume,
	};

	if (typeof window !== "undefined") {
		runtime.beforeUnloadHandler = () => runtime.syncResume.flush();
		window.addEventListener("beforeunload", runtime.beforeUnloadHandler);
	}

	return runtime;
}

function getRuntime(id: string): Runtime {
	const existing = runtimes.get(id);
	if (existing) return existing;

	const runtime = createRuntime();
	runtimes.set(id, runtime);
	return runtime;
}

function bindRuntimeQueryClient(id: string, queryClient: QueryClient) {
	const current = useResumeStore.getState().resume;
	getRuntime(current?.id === id ? getResumeRuntimeKey(current) : `${id}:primary`).queryClient = queryClient;
}

function hasPendingLocalChanges(id: string, variantLocale?: string): boolean {
	return getRuntime(`${id}:${variantLocale ?? "primary"}`).hasPendingLocalChanges;
}

function disposeRuntime(id: string) {
	const runtime = runtimes.get(id);
	if (!runtime) return;

	runtime.abortController.abort();

	if (runtime.beforeUnloadHandler && typeof window !== "undefined") {
		window.removeEventListener("beforeunload", runtime.beforeUnloadHandler);
	}

	if (runtime.deferredFocusHandler && typeof document !== "undefined") {
		document.removeEventListener("focusout", runtime.deferredFocusHandler, true);
	}

	runtimes.delete(id);
}

function cleanupRuntime(id: string) {
	const runtime = runtimes.get(id);
	if (!runtime) return;

	// Flush the debounce, but keep this locale runtime alive until its request resolves. This prevents
	// a fast language switch or route change from aborting a valid autosave.
	runtime.syncResume.flush();
	if (runtime.isSaving || runtime.pendingResume) {
		runtime.disposeWhenIdle = true;
		return;
	}
	disposeRuntime(id);
}

function cleanupResumeRuntimes(resumeId: string) {
	for (const key of runtimes.keys()) {
		if (key === resumeId || key.startsWith(`${resumeId}:`)) cleanupRuntime(key);
	}
}

function syncCurrentResume(id: string) {
	const resume = useResumeStore.getState().resume;
	if (!resume || resume.id !== id) return;

	const runtime = getRuntime(getResumeRuntimeKey(resume));
	// Keep the latest draft outside the debounce closure. A locale switch can unmount/re-mount the
	// builder before the timer fires; returning to the original locale must still save its latest data.
	runtime.latestResume = cloneResume(resume);
	runtime.syncResume(resume);
}

export const useResumeStore = create<ResumeStore>()(
	immer((set, get) => ({
		resume: null,
		resumeId: undefined,
		isReady: false,
		saveStatus: "idle",
		undoStack: [],
		redoStack: [],
		canUndo: false,
		canRedo: false,

		initialize: (resume) => {
			const runtime = resume ? getRuntime(getResumeRuntimeKey(resume)) : undefined;
			const runtimeDraft = runtime
				? (runtime.pendingResume ??
					(runtime.hasPendingLocalChanges ? runtime.latestResume : undefined) ??
					runtime.inFlightResume)
				: undefined;
			const nextResume = runtimeDraft ?? resume;
			if (nextResume) setRuntimeBaseline(nextResume);
			resetHistoryRuntime();

			set((state) => {
				state.resume = nextResume;
				state.resumeId = nextResume?.id;
				state.isReady = nextResume !== null;
				state.undoStack = [];
				state.redoStack = [];
				state.canUndo = false;
				state.canRedo = false;
			});
		},

		reset: () => {
			resetHistoryRuntime();

			set((state) => {
				state.resume = null;
				state.resumeId = undefined;
				state.isReady = false;
				state.undoStack = [];
				state.redoStack = [];
				state.canUndo = false;
				state.canRedo = false;
			});
		},

		replaceResumeDraft: (resume) => {
			resetHistoryRuntime();

			set((state) => {
				state.resume = resume;
				state.resumeId = resume.id;
				state.isReady = true;
				state.undoStack = [];
				state.redoStack = [];
				state.canUndo = false;
				state.canRedo = false;
			});
		},

		replaceResumeFromServer: (resume) => {
			setRuntimeBaseline(resume);

			// This runs both for the echo of our own autosave (identical data → keep history) and for
			// external/cross-tab/AI rebases (different data → local undo history no longer applies).
			const current = get().resume;
			const isRebase = !current || !isEqual(current.data, resume.data);
			if (isRebase) resetHistoryRuntime();

			set((state) => {
				state.resume = resume;
				state.resumeId = resume.id;
				state.isReady = true;

				if (isRebase) {
					state.undoStack = [];
					state.redoStack = [];
					state.canUndo = false;
					state.canRedo = false;
				}
			});
		},

		patchResume: (fn) => {
			set((state) => {
				if (!state.resume) return;
				fn(state.resume as WritableDraft<Resume>);
			});
		},

		setSaveStatus: (status) => {
			set((state) => {
				state.saveStatus = status;
			});
		},

		mergeResumeMetadata: (resume) => {
			set((state) => {
				if (!state.resume || state.resume.id !== resume.id) return;

				state.resume.name = resume.name;
				state.resume.slug = resume.slug;
				state.resume.tags = resume.tags;
				state.resume.isLocked = resume.isLocked;
				state.resume.updatedAt = resume.updatedAt;
				state.resume.hasPassword = resume.hasPassword;
				state.resume.isPublic = resume.isPublic;
			});
		},

		updateResumeData: (fn) => {
			const currentResume = get().resume;
			if (!currentResume) return;

			if (currentResume.isLocked) {
				lockedToastId = toast.error(t`This resume is locked and cannot be updated.`, {
					id: lockedToastId,
				});
				return;
			}

			// Coalesce bursts: only the first edit of a burst opens a new undo step by snapshotting the
			// pre-edit state. Edits within HISTORY_COALESCE_MS of the previous one fold into that step.
			const now = Date.now();
			const coalesce = historyCanCoalesce && now - historyLastEditAt < HISTORY_COALESCE_MS;
			const snapshotBefore = coalesce ? undefined : cloneResumeData(currentResume.data);
			historyLastEditAt = now;
			historyCanCoalesce = true;

			set((state) => {
				if (!state.resume) return;

				if (snapshotBefore) {
					state.undoStack.push(snapshotBefore);
					if (state.undoStack.length > MAX_HISTORY_ENTRIES) state.undoStack.shift();
					// A fresh edit invalidates the redo branch.
					state.redoStack = [];
				}

				fn(state.resume.data as WritableDraft<ResumeData>);
				state.saveStatus = "saving";
				state.canUndo = state.undoStack.length > 0;
				state.canRedo = state.redoStack.length > 0;
			});

			getRuntime(getResumeRuntimeKey(currentResume)).hasPendingLocalChanges = true;
			syncCurrentResume(currentResume.id);
		},

		undo: () => {
			applyHistoryStep(get, set, "undo");
		},

		redo: () => {
			applyHistoryStep(get, set, "redo");
		},
	})),
);

type ImmerSet = (fn: (state: WritableDraft<ResumeStore>) => void) => void;
type StoreGet = () => ResumeStore;

// Shared undo/redo: move the current data to the opposite stack and install the popped snapshot,
// then route the change through the normal autosave path so the preview and sync react as usual.
function applyHistoryStep(get: StoreGet, set: ImmerSet, direction: "undo" | "redo") {
	const state = get();
	const currentResume = state.resume;
	if (!currentResume) return;

	if (currentResume.isLocked) {
		lockedToastId = toast.error(t`This resume is locked and cannot be updated.`, { id: lockedToastId });
		return;
	}

	const source = direction === "undo" ? state.undoStack : state.redoStack;
	if (source.length === 0) return;

	// The next edit after an undo/redo must start a brand-new undo step.
	resetHistoryRuntime();
	const current = cloneResumeData(currentResume.data);

	set((draft) => {
		if (!draft.resume) return;

		const from = direction === "undo" ? draft.undoStack : draft.redoStack;
		const to = direction === "undo" ? draft.redoStack : draft.undoStack;

		const snapshot = from.pop();
		if (snapshot === undefined) return;

		to.push(current as WritableDraft<ResumeData>);
		if (to.length > MAX_HISTORY_ENTRIES) to.shift();

		draft.resume.data = snapshot;
		draft.saveStatus = "saving";
		draft.canUndo = draft.undoStack.length > 0;
		draft.canRedo = draft.redoStack.length > 0;
	});

	getRuntime(getResumeRuntimeKey(currentResume)).hasPendingLocalChanges = true;
	syncCurrentResume(currentResume.id);
}

// Mobile builder keeps the live preview mounted across tabs (to preserve zoom/pan), but pauses its PDF
// re-render while the Edit/Design overlay covers it — otherwise every keystroke re-renders a hidden PDF.
// Desktop never pauses. Lives here because it's the SSR-safe module both the shell and preview import.
type PreviewPausedStore = {
	paused: boolean;
	setPaused: (paused: boolean) => void;
};

export const usePreviewPausedStore = create<PreviewPausedStore>()((set) => ({
	paused: false,
	setPaused: (paused) => set({ paused }),
}));

export function usePatchResume() {
	return useResumeStore((state) => state.patchResume);
}

function useBuilderResumeSelector<T>(selector: (resume: Resume) => T): T | MissingResume {
	const params = useParams({ strict: false }) as { resumeId?: string };
	const resumeId = params.resumeId;

	return useResumeStore((state) => {
		if (!resumeId || !state.resume || state.resume.id !== resumeId) return MISSING_RESUME;
		return selector(state.resume);
	});
}

export function useCurrentBuilderResumeSelector<T>(selector: (resume: Resume) => T): T {
	const selected = useBuilderResumeSelector(selector);
	if (selected === MISSING_RESUME) throw new Error("Resume data is required before rendering this component.");
	return selected;
}

export function useResume(): Resume | undefined {
	const resume = useBuilderResumeSelector((current) => current);
	return resume === MISSING_RESUME ? undefined : resume;
}

export function useCurrentResume(): Resume {
	const resume = useResume();
	if (!resume) throw new Error("Resume data is required before rendering this component.");
	return resume;
}

export function useResumeData(): ResumeData | undefined {
	const data = useBuilderResumeSelector((resume) => resume.data);
	return data === MISSING_RESUME ? undefined : data;
}

export function useIsResumeLocked(): boolean {
	const isLocked = useBuilderResumeSelector((resume) => resume.isLocked);
	return isLocked === MISSING_RESUME ? false : isLocked;
}

export function useUpdateResumeData() {
	const queryClient = useQueryClient();
	const params = useParams({ strict: false }) as { resumeId?: string };
	const resumeId = params.resumeId;
	const updateResumeData = useResumeStore((state) => state.updateResumeData);

	return useCallback(
		(fn: (draft: WritableDraft<ResumeData>) => void) => {
			if (!resumeId) return;
			bindRuntimeQueryClient(resumeId, queryClient);
			updateResumeData(fn);
		},
		[queryClient, resumeId, updateResumeData],
	);
}

export function useResumeUpdateSubscription({ resumeId, onUpdate, onError }: ResumeUpdateSubscriptionOptions) {
	const [_retryNonce, setRetryNonce] = useState(0);

	useEffect(() => {
		if (!resumeId) return;

		let didCancel = false;
		let retryTimer: number | undefined;
		const cancel = consumeEventIterator(streamClient.resume.updates.subscribe({ id: resumeId }), {
			onEvent: async (event) => {
				try {
					await onUpdate((event ?? { mutation: "sync" }) as ResumeUpdateEvent);
				} catch (error) {
					if (error instanceof DOMException && error.name === "AbortError") return;
					onError?.(error);
				}
			},
			onError: (error) => {
				if (didCancel) return;
				onError?.(error);
				retryTimer = window.setTimeout(() => setRetryNonce((value) => value + 1), 2500);
			},
		});

		return () => {
			didCancel = true;
			if (retryTimer) window.clearTimeout(retryTimer);
			void cancel().catch(() => {});
		};
	}, [onError, onUpdate, resumeId]);
}

export function useBuilderResumeUpdateSubscription() {
	const queryClient = useQueryClient();
	const replaceResumeFromServer = useResumeStore((state) => state.replaceResumeFromServer);
	const params = useParams({ strict: false }) as { resumeId?: string };
	const resumeId = params.resumeId;

	const onUpdate = useCallback(
		async (event: ResumeUpdateEvent) => {
			if (!resumeId) return;

			bindRuntimeQueryClient(resumeId, queryClient);
			if (event.mutation === "stylesheet") {
				await refreshStylesheetStore(resumeId);
				return;
			}
			const current = useResumeStore.getState().resume;
			let resume: Resume;
			if (current?.variantLocale) {
				const [variant, primary] = await Promise.all([
					orpc.resume.variants.get.call({
						resumeId,
						locale: current.variantLocale as never,
					}),
					orpc.resume.getById.call({ id: resumeId }) as Promise<Resume>,
				]);
				queryClient.setQueryData(
					orpc.resume.variants.get.queryOptions({
						input: { resumeId, locale: current.variantLocale as never },
					}).queryKey,
					variant,
				);
				queryClient.setQueryData(getResumeQueryKey(resumeId), primary);
				resume = {
					...current,
					data: variant.data,
					updatedAt: variant.updatedAt,
					variantBlockStatuses: variant.blockStatuses,
					variantTextLengthDrift: getResumeTextLengthDrift(primary.data, variant.data),
				} as Resume;
			} else {
				resume = (await orpc.resume.getById.call({ id: resumeId })) as Resume;
			}

			if (!resume.variantLocale) queryClient.setQueryData(getResumeQueryKey(resumeId), resume);
			await refreshStylesheetStore(resumeId, resume.data);

			if (hasPendingLocalChanges(resumeId, resume.variantLocale)) {
				useResumeStore.getState().mergeResumeMetadata(resume);
				return;
			}

			const isExternalChange =
				event.mutation !== "sync" && current?.id === resume.id && !isEqual(current.data, resume.data);

			if (!isExternalChange) {
				replaceResumeFromServer(resume);
				return;
			}

			// #54: never overwrite a field the user is editing; defer the swap until blur.
			if (isEditableElementFocused()) {
				useResumeStore.getState().mergeResumeMetadata(resume);
				deferRemoteResumeUntilBlur(resumeId, resume);
				return;
			}

			// #53: attribute cross-tab / AI-agent edits instead of silently swapping the document.
			replaceResumeFromServer(resume);
			notifyExternalUpdate(event.mutation);
		},
		[queryClient, replaceResumeFromServer, resumeId],
	);

	const onError = useCallback((error: unknown) => {
		console.warn("Resume update stream failed, reconnecting:", error);
	}, []);

	useResumeUpdateSubscription({ resumeId, onUpdate, onError });
}

export function useResumeCleanup() {
	const params = useParams({ strict: false }) as { resumeId?: string };
	const resumeId = params.resumeId;
	const reset = useResumeStore((state) => state.reset);

	useEffect(() => {
		if (!resumeId) return;

		return () => {
			cleanupResumeRuntimes(resumeId);
			reset();
		};
	}, [resumeId, reset]);
}
