<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, shallowRef } from 'vue';
import { useRoute } from 'vue-router';
import type {
	PublicCanvasActiveRunSnapshot,
	PublicCanvasPushEvent,
	PublicCanvasWorkflowPayload,
	PushPayload,
} from '@n8n/api-types';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { N8nBadge, N8nIcon, N8nText } from '@n8n/design-system';
import {
	createRunExecutionData,
	TRIMMED_TASK_DATA_CONNECTIONS_KEY,
	type INodeExecutionData,
	type ITaskData,
} from 'n8n-workflow';

import type { IWorkflowDb } from '@/Interface';
import {
	EditorEnabledFeaturesKey,
	WorkflowDocumentStoreKey,
	WorkflowIdKey,
} from '@/app/constants/injectionKeys';
import { DEFAULT_SETTINGS } from '@/app/constants/workflows';
import { initializeExpressionEngine } from '@/app/init/expressionEngine';
import {
	createExecutionDataId,
	disposeExecutionDataStore,
	useExecutionDataStore,
} from '@/app/stores/executionData.store';
import { useNodeTypesStore } from '@/app/stores/nodeTypes.store';
import {
	createWorkflowDocumentId,
	disposeWorkflowDocumentStore,
	useWorkflowDocumentStore,
	type WorkflowDocumentId,
	type WorkflowDocumentStore,
} from '@/app/stores/workflowDocument.store';
import {
	disposeWorkflowExecutionStateStore,
	useWorkflowExecutionStateStore,
} from '@/app/stores/workflowExecutionState.store';
import { isValidNodeConnectionType } from '@/app/utils/typeGuards';
import WorkflowCanvas from '@/features/workflows/canvas/components/WorkflowCanvas.vue';
import { fetchPublicCanvasWorkflow } from '@/features/workflows/publicCanvas/publicCanvas.api';

const PUBLIC_DOCUMENT_VERSION = 'public-live';

const route = useRoute();
const i18n = useI18n();
const rootStore = useRootStore();
const settingsStore = useSettingsStore();
const nodeTypesStore = useNodeTypesStore();

const isLoading = ref(true);
const isUnavailable = ref(false);
const connectionState = ref<'connecting' | 'live' | 'reconnecting'>('connecting');
const workflowName = ref('');
const currentWorkflowId = ref<string | undefined>(undefined);
const currentDocumentId = ref<WorkflowDocumentId | null>(null);
const currentWorkflowDocumentStore = shallowRef<WorkflowDocumentStore | null>(null);

let eventSource: EventSource | null = null;
let sequenceCounter = 0;
const seenExecutionIds = new Set<string>();

provide(WorkflowIdKey, currentWorkflowId);
provide(WorkflowDocumentStoreKey, currentWorkflowDocumentStore);
provide(
	EditorEnabledFeaturesKey,
	computed(() => ({
		readOnly: true,
		credentialSetupWarnings: false,
		aiAssistant: false,
		aiBuilder: false,
		askAi: false,
		instanceAi: false,
		executionSuccessToasts: false,
		executionErrorToasts: false,
	})),
);

const isExecuting = computed(() => {
	const docId = currentDocumentId.value;
	if (!docId) return false;
	const stateStore = useWorkflowExecutionStateStore(docId);
	return Boolean(stateStore.activeExecutionId);
});

const statusLabel = computed(() => {
	if (isExecuting.value) {
		return i18n.baseText('publicCanvas.status.running');
	}
	if (connectionState.value === 'live') {
		return i18n.baseText('publicCanvas.status.live');
	}
	if (connectionState.value === 'reconnecting') {
		return i18n.baseText('publicCanvas.status.reconnecting');
	}
	return i18n.baseText('publicCanvas.status.connecting');
});

function toHydratableWorkflow(payload: PublicCanvasWorkflowPayload): IWorkflowDb {
	const nowIso = new Date().toISOString();
	return {
		id: payload.id,
		name: payload.name,
		active: payload.active,
		activeVersionId: payload.active ? PUBLIC_DOCUMENT_VERSION : null,
		isArchived: false,
		createdAt: nowIso,
		updatedAt: nowIso,
		versionId: PUBLIC_DOCUMENT_VERSION,
		nodes: payload.nodes.map((node) => ({
			id: node.id,
			name: node.name,
			type: node.type,
			typeVersion: node.typeVersion,
			position: [node.position[0], node.position[1]],
			parameters: node.emptyGroupAnchor ? { emptyGroupAnchor: true } : {},
			...(node.disabled ? { disabled: true } : {}),
		})),
		connections: payload.connections,
		nodeGroups: payload.nodeGroups.map((group) => ({
			...group,
			nodeIds: [...group.nodeIds],
		})),
		settings: { ...DEFAULT_SETTINGS },
		tags: [],
		pinData: {},
		usedCredentials: [],
		scopes: [],
		sharedWithProjects: [],
	};
}

function buildPlaceholderOutputData(
	itemCountByConnectionType?: Record<string, number[]>,
): ITaskData['data'] {
	const placeholder: ITaskData['data'] = { main: [] };
	if (!itemCountByConnectionType) return placeholder;

	const fillObject: INodeExecutionData = {
		json: { [TRIMMED_TASK_DATA_CONNECTIONS_KEY]: true },
	};
	for (const [connectionType, outputs] of Object.entries(itemCountByConnectionType)) {
		if (isValidNodeConnectionType(connectionType) && Array.isArray(outputs)) {
			placeholder[connectionType] = outputs.map((count) =>
				Array.from({ length: Math.max(0, count) }, () => fillObject),
			);
		}
	}
	return placeholder;
}

function startTrackingExecution(
	docId: WorkflowDocumentId,
	executionId: string,
	startedAt?: string,
) {
	const docStore = useWorkflowDocumentStore(docId);
	const stateStore = useWorkflowExecutionStateStore(docId);

	stateStore.executingNode.clearNodeExecutionQueue();
	stateStore.promotePendingExecution(executionId);

	seenExecutionIds.add(executionId);
	const startedDate = startedAt ? new Date(startedAt) : new Date();
	const execDataStore = useExecutionDataStore(createExecutionDataId(executionId));
	execDataStore.setExecution({
		id: executionId,
		finished: false,
		mode: 'webhook',
		status: 'running',
		createdAt: startedDate,
		startedAt: startedDate,
		workflowData: docStore.getSnapshot(),
		data: createRunExecutionData(),
	});
}

function applyNodeStarted(
	docId: WorkflowDocumentId,
	executionId: string,
	nodeName: string,
	executionIndex: number,
) {
	const stateStore = useWorkflowExecutionStateStore(docId);
	const seq = ++sequenceCounter;
	const startTime = Date.now();

	stateStore.executingNode.addExecutingNode(nodeName, executionId, seq, executionIndex);
	useExecutionDataStore(createExecutionDataId(executionId)).addNodeExecutionStartedData({
		executionId,
		nodeName,
		sequenceNumber: seq,
		data: {
			startTime,
			executionIndex,
			source: [],
		},
	});
}

function applyNodeFinished(
	docId: WorkflowDocumentId,
	event: {
		executionId: string;
		nodeName: string;
		executionIndex: number;
		status: 'success' | 'error' | 'waiting';
		executionTime: number;
		itemCountByConnectionType?: Record<string, number[]>;
	},
) {
	const stateStore = useWorkflowExecutionStateStore(docId);
	const taskPayload: PushPayload<'nodeExecuteAfterData'> = {
		executionId: event.executionId,
		nodeName: event.nodeName,
		itemCountByConnectionType: event.itemCountByConnectionType ?? {},
		data: {
			startTime: Date.now() - event.executionTime,
			executionTime: event.executionTime,
			executionIndex: event.executionIndex,
			executionStatus: event.status,
			source: [],
			data: buildPlaceholderOutputData(event.itemCountByConnectionType),
			...(event.status === 'error'
				? {
						error: {
							name: 'NodeExecutionError',
							message: 'Execution failed',
							timestamp: Date.now(),
						} as ITaskData['error'],
					}
				: {}),
		},
	};

	useExecutionDataStore(createExecutionDataId(event.executionId)).updateNodeExecutionStatus(
		taskPayload,
	);
	stateStore.executingNode.removeExecutingNode(event.nodeName, event.executionIndex);
}

function hydrateActiveRunSnapshot(
	docId: WorkflowDocumentId,
	snapshot: PublicCanvasActiveRunSnapshot | null,
) {
	if (!snapshot) return;
	startTrackingExecution(docId, snapshot.executionId, snapshot.startedAt);

	for (const [nodeName, runs] of Object.entries(snapshot.completedNodes)) {
		for (const run of runs) {
			applyNodeFinished(docId, {
				executionId: snapshot.executionId,
				nodeName,
				executionIndex: run.executionIndex,
				status: run.status,
				executionTime: run.executionTime,
				itemCountByConnectionType: run.itemCountByConnectionType,
			});
		}
	}

	for (const active of snapshot.executingNodes) {
		applyNodeStarted(docId, snapshot.executionId, active.nodeName, active.executionIndex);
	}
}

function handlePushEvent(event: PublicCanvasPushEvent) {
	const docId = currentDocumentId.value;
	if (!docId) return;

	const stateStore = useWorkflowExecutionStateStore(docId);

	if (event.type === 'workflowExecuteBefore') {
		startTrackingExecution(docId, event.executionId, event.startedAt);
		return;
	}

	// If a viewer connected right after `workflowExecuteBefore`, initialize lazily on first node event.
	if (!stateStore.activeExecutionId && event.type === 'nodeExecuteBefore') {
		startTrackingExecution(docId, event.executionId);
	}

	if (stateStore.activeExecutionId !== event.executionId) {
		return;
	}

	if (event.type === 'nodeExecuteBefore') {
		applyNodeStarted(docId, event.executionId, event.nodeName, event.executionIndex);
		return;
	}

	if (event.type === 'nodeExecuteAfter') {
		applyNodeFinished(docId, event);
		return;
	}

	if (event.type === 'workflowExecuteAfter') {
		stateStore.executingNode.clearNodeExecutionQueue();
		const execDataStore = useExecutionDataStore(createExecutionDataId(event.executionId));
		const snapshot = execDataStore.getExecutionSnapshot();
		if (snapshot) {
			execDataStore.setExecution({
				...snapshot,
				finished: event.status === 'success',
				status: event.status,
				stoppedAt: new Date(),
			});
		}
		stateStore.setDisplayedExecutionId(event.executionId);
		stateStore.setActiveExecutionId(undefined);
	}
}

function connectStream(shareToken: string) {
	const base = rootStore.restUrl.replace(/\/$/, '');
	const streamUrl = `${base}/public-canvas/${encodeURIComponent(shareToken)}/events`;
	eventSource = new EventSource(streamUrl);

	eventSource.onopen = () => {
		connectionState.value = 'live';
	};

	eventSource.onmessage = (messageEvent) => {
		try {
			const parsed = JSON.parse(messageEvent.data) as PublicCanvasPushEvent;
			handlePushEvent(parsed);
		} catch {
			// Ignore malformed frames.
		}
	};

	eventSource.onerror = () => {
		connectionState.value = 'reconnecting';
	};
}

function cleanupStores() {
	eventSource?.close();
	eventSource = null;

	for (const execId of seenExecutionIds) {
		disposeExecutionDataStore(createExecutionDataId(execId));
	}
	seenExecutionIds.clear();

	const docId = currentDocumentId.value;
	if (docId) {
		disposeWorkflowExecutionStateStore(docId);
		disposeWorkflowDocumentStore(docId);
	}
	currentDocumentId.value = null;
	currentWorkflowDocumentStore.value = null;
}

onMounted(async () => {
	const rawParam = route.params.shareToken;
	const shareToken = Array.isArray(rawParam) ? rawParam[0] : rawParam;
	if (!shareToken) {
		isUnavailable.value = true;
		isLoading.value = false;
		return;
	}

	try {
		await initializeExpressionEngine(settingsStore.settings.expressionEngine).catch(() => {});
		const response = await fetchPublicCanvasWorkflow(rootStore.restUrl, shareToken);

		nodeTypesStore.setNodeTypes(response.nodeTypes);

		const docId = createWorkflowDocumentId(response.workflow.id, PUBLIC_DOCUMENT_VERSION);
		const docStore = useWorkflowDocumentStore(docId);
		docStore.hydrate(toHydratableWorkflow(response.workflow));

		currentWorkflowId.value = response.workflow.id;
		currentDocumentId.value = docId;
		currentWorkflowDocumentStore.value = docStore;
		workflowName.value = response.workflow.name;
		document.title = `${response.workflow.name} · n8n`;

		hydrateActiveRunSnapshot(docId, response.activeRun);
		connectStream(shareToken);
	} catch {
		isUnavailable.value = true;
	} finally {
		isLoading.value = false;
	}
});

onBeforeUnmount(() => {
	cleanupStores();
});
</script>

<template>
	<div :class="$style.page" data-test-id="public-workflow-view">
		<header
			v-if="!isUnavailable && !isLoading"
			:class="$style.topBar"
			data-test-id="public-workflow-header"
		>
			<div :class="$style.titleGroup">
				<N8nIcon icon="workflow" size="medium" :class="$style.titleIcon" />
				<N8nText bold size="medium" color="text-dark" :class="$style.workflowTitle">
					{{ workflowName }}
				</N8nText>
				<N8nBadge theme="default" size="small">
					{{ i18n.baseText('publicCanvas.readOnlyBadge') }}
				</N8nBadge>
			</div>

			<div
				:class="[
					$style.statusPill,
					isExecuting && $style.statusRunning,
					!isExecuting && connectionState === 'live' && $style.statusLive,
					connectionState === 'reconnecting' && $style.statusReconnecting,
				]"
				data-test-id="public-workflow-status-pill"
			>
				<span :class="$style.statusDot" />
				<N8nText size="small" bold color="text-dark">
					{{ statusLabel }}
				</N8nText>
			</div>
		</header>

		<div v-if="isLoading" :class="$style.centerState" data-test-id="public-workflow-loading">
			<N8nText color="text-light" size="medium">
				{{ i18n.baseText('publicCanvas.loading') }}
			</N8nText>
		</div>

		<div
			v-else-if="isUnavailable || !currentWorkflowDocumentStore || !currentWorkflowId"
			:class="$style.centerState"
			data-test-id="public-workflow-unavailable"
		>
			<div :class="$style.unavailableCard">
				<N8nIcon icon="eye-off" size="xlarge" color="text-light" />
				<N8nText tag="h2" bold size="large" color="text-dark">
					{{ i18n.baseText('publicCanvas.notFound.title') }}
				</N8nText>
				<N8nText size="small" color="text-base">
					{{ i18n.baseText('publicCanvas.notFound.description') }}
				</N8nText>
			</div>
		</div>

		<WorkflowCanvas
			v-else
			:id="currentWorkflowId"
			:read-only="true"
			:can-execute="false"
			:executing="isExecuting"
		/>
	</div>
</template>

<style lang="scss" module>
.page {
	position: relative;
	width: 100%;
	height: 100vh;
	overflow: hidden;
	background-color: var(--canvas--color--background);
}

.topBar {
	position: absolute;
	top: var(--spacing--sm);
	left: var(--spacing--sm);
	right: var(--spacing--sm);
	z-index: 10;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
	pointer-events: none;
}

.titleGroup {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	max-width: 70%;
	padding: var(--spacing--3xs) var(--spacing--xs);
	background-color: var(--color--background--light-3);
	border: var(--border);
	border-radius: var(--radius--lg);
	box-shadow: var(--shadow);
	pointer-events: auto;
}

.titleIcon {
	flex-shrink: 0;
	color: var(--color--primary);
}

.workflowTitle {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.statusPill {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	padding: var(--spacing--3xs) var(--spacing--xs);
	background-color: var(--color--background--light-3);
	border: var(--border);
	border-radius: var(--radius--full);
	box-shadow: var(--shadow);
	pointer-events: auto;
}

.statusDot {
	width: var(--height--5xs);
	height: var(--height--5xs);
	border-radius: var(--radius--full);
	background-color: var(--color--text--tint-1);
}

.statusLive .statusDot {
	background-color: var(--color--success);
}

.statusRunning .statusDot {
	background-color: var(--color--primary);
	animation: publicCanvasPulse 1.2s ease-in-out infinite;
}

.statusReconnecting .statusDot {
	background-color: var(--color--warning);
}

@keyframes publicCanvasPulse {
	0%,
	100% {
		opacity: 1;
		transform: scale(1);
	}

	50% {
		opacity: 0.4;
		transform: scale(1.25);
	}
}

.centerState {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 100%;
	height: 100%;
	padding: var(--spacing--lg);
}

.unavailableCard {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--spacing--xs);
	max-width: 420px;
	padding: var(--spacing--xl);
	text-align: center;
	background-color: var(--color--background--light-3);
	border: var(--border);
	border-radius: var(--radius--lg);
	box-shadow: var(--shadow);
}
</style>
