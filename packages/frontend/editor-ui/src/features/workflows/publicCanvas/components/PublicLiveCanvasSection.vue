<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useClipboard } from '@n8n/composables/useClipboard';
import { useToast } from '@n8n/composables/useToast';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import {
	N8nButton,
	N8nInput,
	N8nSettingsEnableRow,
	N8nSettingsRowGroup,
	N8nTooltip,
} from '@n8n/design-system';

import {
	getPublicCanvasShareStatus,
	updatePublicCanvasShareStatus,
} from '@/features/workflows/publicCanvas/publicCanvas.api';

const props = defineProps<{
	projectId: string;
	workflowId: string;
	isWorkflowSaved: boolean;
	canUpdate: boolean;
	ensureWorkflowSaved: () => Promise<{ workflowId: string; projectId: string }>;
}>();

const i18n = useI18n();
const toast = useToast();
const rootStore = useRootStore();
const clipboard = useClipboard();

const isLoading = ref(false);
const isUpdating = ref(false);
const enabled = ref(false);
const shareToken = ref<string | null>(null);
const justCopied = ref(false);

const publicUrl = computed(() => {
	if (!enabled.value || !shareToken.value) return '';
	const basePath = (window.BASE_PATH ?? '/').replace(/\/?$/, '/');
	return `${window.location.origin}${basePath}public/workflow/${encodeURIComponent(shareToken.value)}`;
});

async function loadStatus() {
	if (!props.isWorkflowSaved || !props.projectId || !props.workflowId) {
		enabled.value = false;
		shareToken.value = null;
		return;
	}

	isLoading.value = true;
	try {
		const status = await getPublicCanvasShareStatus(
			rootStore.restApiContext,
			props.projectId,
			props.workflowId,
		);
		enabled.value = status.enabled;
		shareToken.value = status.shareToken;
	} catch {
		enabled.value = false;
		shareToken.value = null;
	} finally {
		isLoading.value = false;
	}
}

async function onToggleEnabled(nextEnabled: boolean) {
	if (isUpdating.value || !props.canUpdate) return;
	isUpdating.value = true;

	try {
		const target = props.isWorkflowSaved
			? { workflowId: props.workflowId, projectId: props.projectId }
			: await props.ensureWorkflowSaved();

		const status = await updatePublicCanvasShareStatus(
			rootStore.restApiContext,
			target.projectId,
			target.workflowId,
			{ enabled: nextEnabled },
		);
		enabled.value = status.enabled;
		shareToken.value = status.shareToken;

		toast.showMessage({
			title: i18n.baseText(
				status.enabled
					? 'workflows.shareModal.publicCanvas.enabledToast'
					: 'workflows.shareModal.publicCanvas.disabledToast',
			),
			type: 'success',
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('workflows.shareModal.publicCanvas.error'));
	} finally {
		isUpdating.value = false;
	}
}

async function onRotateLink() {
	if (isUpdating.value || !props.canUpdate || !enabled.value) return;
	isUpdating.value = true;

	try {
		const status = await updatePublicCanvasShareStatus(
			rootStore.restApiContext,
			props.projectId,
			props.workflowId,
			{ enabled: true, rotateToken: true },
		);
		enabled.value = status.enabled;
		shareToken.value = status.shareToken;

		toast.showMessage({
			title: i18n.baseText('workflows.shareModal.publicCanvas.rotated'),
			type: 'success',
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('workflows.shareModal.publicCanvas.error'));
	} finally {
		isUpdating.value = false;
	}
}

async function onCopyLink() {
	if (!publicUrl.value) return;
	await clipboard.copy(publicUrl.value);
	justCopied.value = true;
	toast.showMessage({
		title: i18n.baseText('workflows.shareModal.publicCanvas.copied'),
		type: 'success',
	});
	window.setTimeout(() => {
		justCopied.value = false;
	}, 2000);
}

function onOpenPublicView() {
	if (!publicUrl.value) return;
	window.open(publicUrl.value, '_blank', 'noopener,noreferrer');
}

onMounted(() => {
	void loadStatus();
});

watch(
	() => [props.workflowId, props.projectId, props.isWorkflowSaved],
	() => {
		void loadStatus();
	},
);
</script>

<template>
	<div :class="$style.section" data-test-id="public-live-canvas-section">
		<N8nSettingsRowGroup>
			<N8nSettingsEnableRow
				:title="i18n.baseText('workflows.shareModal.publicCanvas.title')"
				:description="i18n.baseText('workflows.shareModal.publicCanvas.description')"
				:enabled="enabled"
				:disabled="!canUpdate || isLoading || isUpdating"
				switch-test-id="public-live-canvas-toggle"
				@update:enabled="onToggleEnabled"
			/>
		</N8nSettingsRowGroup>

		<div
			v-if="enabled && publicUrl"
			:class="$style.linkRow"
			data-test-id="public-live-canvas-url-row"
		>
			<N8nInput
				:model-value="publicUrl"
				:readonly="true"
				size="small"
				:class="$style.urlInput"
				data-test-id="public-live-canvas-url-input"
			/>
			<div :class="$style.actions">
				<N8nTooltip :content="i18n.baseText('workflows.shareModal.publicCanvas.copy')">
					<N8nButton
						variant="subtle"
						size="small"
						:icon="justCopied ? 'check' : 'copy'"
						:aria-label="i18n.baseText('workflows.shareModal.publicCanvas.copy')"
						icon-only
						data-test-id="public-live-canvas-copy-button"
						data-attr="public-live-canvas-copy"
						@click="onCopyLink"
					/>
				</N8nTooltip>
				<N8nTooltip :content="i18n.baseText('workflows.shareModal.publicCanvas.open')">
					<N8nButton
						variant="subtle"
						size="small"
						icon="external-link"
						:aria-label="i18n.baseText('workflows.shareModal.publicCanvas.open')"
						icon-only
						data-test-id="public-live-canvas-open-button"
						data-attr="public-live-canvas-open"
						@click="onOpenPublicView"
					/>
				</N8nTooltip>
				<N8nTooltip
					v-if="canUpdate"
					:content="i18n.baseText('workflows.shareModal.publicCanvas.rotate')"
				>
					<N8nButton
						variant="subtle"
						size="small"
						icon="refresh-cw"
						:disabled="isUpdating"
						:aria-label="i18n.baseText('workflows.shareModal.publicCanvas.rotate')"
						icon-only
						data-test-id="public-live-canvas-rotate-button"
						data-attr="public-live-canvas-rotate"
						@click="onRotateLink"
					/>
				</N8nTooltip>
			</div>
		</div>
	</div>
</template>

<style lang="scss" module>
.section {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
	margin-top: var(--spacing--md);
	padding-top: var(--spacing--md);
	border-top: var(--border);
}

.linkRow {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.urlInput {
	flex: 1;
	min-width: 0;
}

.actions {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
	flex-shrink: 0;
}
</style>
