import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, ref } from 'vue';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { fireEvent } from '@testing-library/vue';
import { flushPromises, mount } from '@vue/test-utils';
import type { InstanceAiHandoffContext } from '@n8n/api-types';

import { mockedStore } from '@/__tests__/utils';
import { createComponentRenderer } from '@/__tests__/render';
import { useInstanceAiStore } from '../../instanceAi.store';
import { useSidebarState } from '../../instanceAiLayout';
import { makeThread } from '../../__tests__/createThreadComponentRenderer';
import {
	clearPendingComposerDraft,
	clearPendingHandoffContext,
	getPendingComposerDraft,
	getPendingHandoffContext,
} from '../../composables/useInstanceAiHandoff';
import InstanceAiChatPanel from '../InstanceAiChatPanel.vue';
import type { InstanceAiEmbedSubject } from '../instanceAiEmbed.types';

vi.mock('uuid', () => ({ v4: () => 'thread-2' }));

const routerPush = vi.hoisted(() => vi.fn());
vi.mock('vue-router', async (importOriginal) => ({
	...(await importOriginal<typeof import('vue-router')>()),
	useRouter: () => ({ push: routerPush }),
}));

const showError = vi.hoisted(() => vi.fn());
const showMessage = vi.hoisted(() => vi.fn());
vi.mock('@n8n/composables/useToast', () => ({
	useToast: () => ({ showError, showMessage }),
}));

const buildingIds = ref(new Set<string>());
vi.mock('../../composables/useBuildingArtifactIds', () => ({
	useBuildingArtifactIds: () => computed(() => buildingIds.value),
}));

const useAgentMutationRefreshMock = vi.hoisted(() => vi.fn());
vi.mock('../../composables/useAgentMutationRefresh', () => ({
	useAgentMutationRefresh: useAgentMutationRefreshMock,
}));

// Minimal stand-ins: exercise the panel's own wiring, not the real children's
// internals (each has its own suite). The header stub re-implements just the
// sidebar-toggle affordance the "filters the list" case needs.
const InstanceAiViewHeaderStub = defineComponent({
	name: 'InstanceAiViewHeader',
	props: ['threadId'],
	setup() {
		return { sidebar: useSidebarState() };
	},
	template: `<div data-test-id="header-stub">
		<button data-test-id="header-toggle-sidebar" type="button" @click="sidebar.toggle" />
		<slot name="title" />
		<slot name="actions" />
	</div>`,
});

const InstanceAiThreadListStub = defineComponent({
	name: 'InstanceAiThreadList',
	props: ['threads', 'activeThreadId', 'disabled'],
	emits: ['collapse', 'select', 'new', 'deleted'],
	template: `<div data-test-id="list-stub" :data-disabled="String(Boolean(disabled))">
		<span data-test-id="list-count">{{ threads.length }}</span>
		<button data-test-id="list-new" type="button" @click="$emit('new')" />
		<button data-test-id="list-select" type="button" @click="$emit('select', 't-other')" />
	</div>`,
});

// `handoff()` reaches the conversation through a template ref, not props/emits
// — these two stand in for the real `defineExpose`d `isDirty`/`applyHandoff`.
const isDirtyMock = vi.hoisted(() => vi.fn(() => false));
const applyHandoffMock = vi.hoisted(() => vi.fn());

const InstanceAiConversationStub = defineComponent({
	name: 'InstanceAiConversation',
	props: ['beforeSend'],
	emits: ['thread-missing', 'agent-attachment-restored'],
	methods: {
		isDirty: isDirtyMock,
		applyHandoff: applyHandoffMock,
	},
	template: `<div data-test-id="conversation-stub" :data-has-before-send="String(typeof beforeSend === 'function')">
		<button data-test-id="conversation-thread-missing" type="button" @click="$emit('thread-missing')" />
	</div>`,
});

const panelStubs = {
	InstanceAiViewHeader: InstanceAiViewHeaderStub,
	InstanceAiThreadList: InstanceAiThreadListStub,
	InstanceAiConversation: InstanceAiConversationStub,
};

const renderPanel = createComponentRenderer(InstanceAiChatPanel, {
	global: { stubs: panelStubs },
});

// `handoff()` is an imperative method on the panel's public instance
// (`defineExpose`), which testing-library's `render()` doesn't expose —
// `@vue/test-utils`'s `mount()` does, via `wrapper.vm`.
function mountPanel(props: {
	subject: InstanceAiEmbedSubject;
	launch: typeof launch;
	threadId?: string;
}) {
	return mount(InstanceAiChatPanel, { props, global: { stubs: panelStubs } });
}

const subject: InstanceAiEmbedSubject = { type: 'agent', id: 'agent-1', projectId: 'p1' };
const launch = { source: 'agent_builder_page' as const, origin: 'internal' as const };

describe('InstanceAiChatPanel', () => {
	let store: ReturnType<typeof mockedStore<typeof useInstanceAiStore>>;

	beforeEach(() => {
		setActivePinia(createTestingPinia());
		store = mockedStore(useInstanceAiStore);
		store.threads = [];
		store.loadThreads.mockResolvedValue(true);
		store.syncThread.mockResolvedValue(undefined);
		store.updateThreadMetadata.mockResolvedValue(undefined);
		store.deleteThread.mockResolvedValue(true);
		store.getOrCreateRuntime.mockReturnValue(makeThread());
		store.getRuntime.mockReturnValue(makeThread());
		buildingIds.value = new Set();
		routerPush.mockClear();
		useAgentMutationRefreshMock.mockClear();
		showError.mockClear();
		showMessage.mockClear();
		isDirtyMock.mockReset().mockReturnValue(false);
		applyHandoffMock.mockClear();
		clearPendingHandoffContext('thread-2');
		clearPendingComposerDraft('thread-2');
	});

	it('mints a thread when none is given, calling beforeNewThread first', async () => {
		const order: string[] = [];
		const beforeNewThread = vi.fn().mockImplementation(async () => {
			order.push('before');
		});
		store.syncThread.mockImplementation(async () => {
			order.push('synced');
		});

		const { emitted } = renderPanel({ props: { subject, launch, beforeNewThread } });
		await vi.waitFor(() => expect(emitted('update:threadId')).toBeTruthy());

		expect(order).toEqual(['before', 'synced']);
		expect(emitted('update:threadId')?.[0]).toEqual(['thread-2']);
	});

	it('shows an error toast and leaves the panel without a thread when minting fails', async () => {
		store.updateThreadMetadata.mockRejectedValue(new Error('nope'));

		const { emitted } = renderPanel({ props: { subject, launch } });

		await vi.waitFor(() => expect(showError).toHaveBeenCalled());

		expect(showError).toHaveBeenCalledWith(expect.any(Error), "Couldn't open n8n Assistant");
		expect(emitted('update:threadId')).toBeFalsy();
	});

	it('mints immediately for a pending agent instead of waiting for loadThreads to resolve', async () => {
		const pending = Promise.withResolvers<boolean>();
		store.loadThreads.mockReturnValue(pending.promise);
		const pendingSubject: InstanceAiEmbedSubject = {
			type: 'agent',
			id: 'agent-1',
			projectId: 'p1',
			pending: true,
		};

		const { emitted } = renderPanel({ props: { subject: pendingSubject, launch } });

		// loadThreads is deliberately left unresolved: a mint that waited on it
		// first would never emit here.
		await vi.waitFor(() => expect(emitted('update:threadId')).toBeTruthy());
		expect(emitted('update:threadId')?.[0]).toEqual(['thread-2']);

		pending.resolve(true);
	});

	it('resumes the most recent thread for the subject instead of minting one', async () => {
		store.threads = [
			{
				id: 't-match',
				title: 'Existing',
				createdAt: '',
				updatedAt: '',
				metadata: { instanceAiAgentBuilderTarget: { agentId: 'agent-1', projectId: 'p1' } },
			},
		] as typeof store.threads;

		const { emitted } = renderPanel({ props: { subject, launch } });
		await vi.waitFor(() => expect(store.loadThreads).toHaveBeenCalled());
		await vi.waitFor(() => expect(emitted('update:threadId')).toBeTruthy());

		expect(emitted('update:threadId')?.[0]).toEqual(['t-match']);
		expect(store.syncThread).not.toHaveBeenCalled();
	});

	it('loads threads without blocking when a thread id is already given', async () => {
		renderPanel({ props: { subject, launch, threadId: 't-match' } });
		await vi.waitFor(() => expect(store.loadThreads).toHaveBeenCalled());
	});

	it('resumes or mints when the host clears the thread id while mounted', async () => {
		const { rerender, emitted } = renderPanel({ props: { subject, launch, threadId: 't-match' } });
		store.loadThreads.mockClear();

		await rerender({ subject, launch, threadId: undefined });

		await vi.waitFor(() => expect(store.loadThreads).toHaveBeenCalled());
		await vi.waitFor(() => expect(emitted('update:threadId')?.at(-1)).toEqual(['thread-2']));
	});

	it('drops an orphaned mint that resolves after the panel unmounts', async () => {
		const pending = Promise.withResolvers<void>();
		store.syncThread.mockImplementation(async () => {
			await pending.promise;
		});
		const { getByTestId, emitted, unmount } = renderPanel({
			props: { subject, launch, threadId: 't-match' },
		});
		await fireEvent.click(getByTestId('header-toggle-sidebar'));
		await fireEvent.click(getByTestId('list-new'));

		unmount();
		pending.resolve();
		await flushPromises();

		expect(emitted('update:threadId')).toBeFalsy();
		expect(store.deleteThread).toHaveBeenCalledWith('thread-2');
	});

	it('drops an orphaned mint that resolves after the subject changes', async () => {
		const pending = Promise.withResolvers<void>();
		store.syncThread.mockImplementation(async () => {
			await pending.promise;
		});
		const { getByTestId, rerender, emitted } = renderPanel({
			props: { subject, launch, threadId: 't-match' },
		});
		await fireEvent.click(getByTestId('header-toggle-sidebar'));
		await fireEvent.click(getByTestId('list-new'));

		const otherSubject: InstanceAiEmbedSubject = { type: 'agent', id: 'agent-2', projectId: 'p1' };
		await rerender({ subject: otherSubject, launch, threadId: 't-match' });
		pending.resolve();
		await flushPromises();

		expect(emitted('update:threadId')).toBeFalsy();
		expect(store.deleteThread).toHaveBeenCalledWith('thread-2');
	});

	it('filters the thread list by the subject', async () => {
		store.threads = [
			{
				id: 't-match',
				title: 'Matches',
				createdAt: '',
				updatedAt: '',
				metadata: { instanceAiAgentBuilderTarget: { agentId: 'agent-1', projectId: 'p1' } },
			},
			{
				id: 't-other',
				title: 'Other agent',
				createdAt: '',
				updatedAt: '',
				metadata: { instanceAiAgentBuilderTarget: { agentId: 'agent-2', projectId: 'p1' } },
			},
		] as typeof store.threads;

		const { getByTestId } = renderPanel({ props: { subject, launch, threadId: 't-match' } });
		await fireEvent.click(getByTestId('header-toggle-sidebar'));

		expect(getByTestId('list-count').textContent).toBe('1');
	});

	it('emits update:building for the subject', async () => {
		const { emitted } = renderPanel({ props: { subject, launch, threadId: 't-match' } });
		await vi.waitFor(() => expect(emitted('update:building')).toBeTruthy());
		expect(emitted('update:building')?.[0]).toEqual([false]);

		buildingIds.value = new Set(['agent-1']);
		await vi.waitFor(() => expect(emitted('update:building')?.at(-1)).toEqual([true]));
		expect(useAgentMutationRefreshMock).toHaveBeenCalled();
	});

	it('emits update:building false on unmount so a host closing the panel mid-build unlocks', async () => {
		const { emitted, unmount } = renderPanel({ props: { subject, launch, threadId: 't-match' } });
		await vi.waitFor(() => expect(emitted('update:building')).toBeTruthy());
		buildingIds.value = new Set(['agent-1']);
		await vi.waitFor(() => expect(emitted('update:building')?.at(-1)).toEqual([true]));

		unmount();

		expect(emitted('update:building')?.at(-1)).toEqual([false]);
	});

	it('marks the thread list disabled and ignores select/new from it while building', async () => {
		const { getByTestId, emitted } = renderPanel({
			props: { subject, launch, threadId: 't-match' },
		});
		await fireEvent.click(getByTestId('header-toggle-sidebar'));
		buildingIds.value = new Set(['agent-1']);
		await vi.waitFor(() => expect(emitted('update:building')?.at(-1)).toEqual([true]));

		expect(getByTestId('list-stub').dataset.disabled).toBe('true');

		await fireEvent.click(getByTestId('list-new'));
		await fireEvent.click(getByTestId('list-select'));

		expect(emitted('update:threadId')).toBeFalsy();
	});

	it('mints a new thread when the list emits new', async () => {
		const { getByTestId, emitted } = renderPanel({
			props: { subject, launch, threadId: 't-match' },
		});
		await fireEvent.click(getByTestId('header-toggle-sidebar'));
		await fireEvent.click(getByTestId('list-new'));

		await vi.waitFor(() => expect(emitted('update:threadId')?.at(-1)).toEqual(['thread-2']));
	});

	it('mints a new thread when the conversation reports thread-missing', async () => {
		const { getByTestId, emitted } = renderPanel({
			props: { subject, launch, threadId: 't-match' },
		});

		await fireEvent.click(getByTestId('conversation-thread-missing'));

		await vi.waitFor(() => expect(emitted('update:threadId')?.at(-1)).toEqual(['thread-2']));
	});

	it('passes beforeSend through to the conversation', async () => {
		const beforeSend = vi.fn();
		const { getByTestId } = renderPanel({
			props: { subject, launch, threadId: 't-match', beforeSend },
		});

		expect(getByTestId('conversation-stub').dataset.hasBeforeSend).toBe('true');
	});

	it('navigates to the full assistant thread view', async () => {
		const { getByTestId } = renderPanel({ props: { subject, launch, threadId: 't-match' } });

		await fireEvent.click(getByTestId('instance-ai-embed-open-full'));

		expect(routerPush).toHaveBeenCalledWith({
			name: 'InstanceAiThread',
			params: { threadId: 't-match' },
		});
	});

	it('emits close', async () => {
		const { getByTestId, emitted } = renderPanel({
			props: { subject, launch, threadId: 't-match' },
		});

		await fireEvent.click(getByTestId('instance-ai-embed-close'));

		expect(emitted('close')).toEqual([[]]);
	});

	it('disposes the runtime on thread change and unmount', async () => {
		const { rerender, unmount } = renderPanel({ props: { subject, launch, threadId: 't-match' } });

		await rerender({ subject, launch, threadId: 't-next' });
		expect(store.disposeRuntime).toHaveBeenCalledWith('t-match');

		unmount();
		expect(store.disposeRuntime).toHaveBeenCalledWith('t-next');
	});

	it('does not dispose the runtime handed off to the full assistant view', async () => {
		const { getByTestId, rerender, unmount } = renderPanel({
			props: { subject, launch, threadId: 't-match' },
		});

		await fireEvent.click(getByTestId('instance-ai-embed-open-full'));
		await rerender({ subject, launch, threadId: 't-next' });
		unmount();

		expect(store.disposeRuntime).not.toHaveBeenCalledWith('t-match');
		expect(store.disposeRuntime).toHaveBeenCalledWith('t-next');
	});

	describe('handoff', () => {
		const context: InstanceAiHandoffContext = {
			source: 'agent-preview',
			agentId: 'agent-1',
			threadId: 'preview-1',
		};

		it('applies the handoff directly when the conversation is mounted and clean', () => {
			const wrapper = mountPanel({ subject, launch, threadId: 't-match' });

			const result = wrapper.vm.handoff(context, 'Change the system prompt');

			expect(result).toBe(true);
			expect(applyHandoffMock).toHaveBeenCalledWith(context, 'Change the system prompt');
		});

		it('shows the finish-draft toast and skips applying when the conversation is dirty', () => {
			isDirtyMock.mockReturnValue(true);
			const wrapper = mountPanel({ subject, launch, threadId: 't-match' });

			const result = wrapper.vm.handoff(context);

			expect(result).toBe(false);
			expect(applyHandoffMock).not.toHaveBeenCalled();
			expect(showMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
		});

		it('queues the handoff until the thread being minted gets an id, then stashes it there', async () => {
			const pendingSubject: InstanceAiEmbedSubject = {
				type: 'agent',
				id: 'agent-1',
				projectId: 'p1',
				pending: true,
			};
			const syncing = Promise.withResolvers<void>();
			store.syncThread.mockImplementation(async () => {
				await syncing.promise;
			});

			// No thread-id prop yet: the panel is minting one for the pending agent.
			const wrapper = mountPanel({ subject: pendingSubject, launch });
			const result = wrapper.vm.handoff(context, 'Change the system prompt');

			expect(result).toBe(true);
			expect(applyHandoffMock).not.toHaveBeenCalled();
			expect(getPendingHandoffContext('thread-2')).toBeNull();

			syncing.resolve();
			await vi.waitFor(() => expect(wrapper.emitted('update:threadId')).toBeTruthy());

			expect(getPendingHandoffContext('thread-2')).toEqual(context);
			expect(getPendingComposerDraft('thread-2')).toBe('Change the system prompt');
			expect(store.updateThreadMetadata).toHaveBeenCalledWith('thread-2', {
				instanceAiAgentPreviewView: { agentId: 'agent-1', threadId: 'preview-1' },
			});
		});
	});
});
