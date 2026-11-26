import { OnLifecycleEvent } from '@n8n/decorators';
import type {
	NodeExecuteAfterContext,
	NodeExecuteBeforeContext,
	WorkflowExecuteAfterContext,
	WorkflowExecuteBeforeContext,
} from '@n8n/decorators';
import { Service } from '@n8n/di';

import { getItemCountByConnectionType } from '@/utils/get-item-count-by-connection-type';

import { PublicCanvasShareService } from './public-canvas-share.service';
import { PublicCanvasStreamService } from './public-canvas-stream.service';

@Service()
export class PublicCanvasLifecycleHandler {
	constructor(
		private readonly shareService: PublicCanvasShareService,
		private readonly streamService: PublicCanvasStreamService,
	) {}

	@OnLifecycleEvent('workflowExecuteBefore')
	async onWorkflowExecuteBefore(ctx: WorkflowExecuteBeforeContext): Promise<void> {
		const workflowId = ctx.workflow.id;
		if (!workflowId || !this.shareService.isWorkflowPubliclyShared(workflowId)) return;

		this.streamService.publishLifecycleEvent(workflowId, {
			type: 'workflowExecuteBefore',
			executionId: ctx.executionId,
			startedAt: new Date().toISOString(),
		});
	}

	@OnLifecycleEvent('nodeExecuteBefore')
	async onNodeExecuteBefore(ctx: NodeExecuteBeforeContext): Promise<void> {
		const workflowId = ctx.workflow.id;
		if (!workflowId || !this.shareService.isWorkflowPubliclyShared(workflowId)) return;

		this.streamService.publishLifecycleEvent(workflowId, {
			type: 'nodeExecuteBefore',
			executionId: ctx.executionId,
			nodeName: ctx.nodeName,
			executionIndex: ctx.taskData.executionIndex,
		});
	}

	@OnLifecycleEvent('nodeExecuteAfter')
	async onNodeExecuteAfter(ctx: NodeExecuteAfterContext): Promise<void> {
		const workflowId = ctx.workflow.id;
		if (!workflowId || !this.shareService.isWorkflowPubliclyShared(workflowId)) return;

		const rawStatus = ctx.taskData.executionStatus;
		const status: 'success' | 'error' | 'waiting' =
			ctx.taskData.error || rawStatus === 'error' || rawStatus === 'crashed'
				? 'error'
				: rawStatus === 'waiting'
					? 'waiting'
					: 'success';

		// Item counts are pure integer arrays per port — never forward JSON or binary payloads.
		const itemCountByConnectionType = ctx.taskData.data
			? getItemCountByConnectionType(ctx.taskData.data)
			: undefined;

		this.streamService.publishLifecycleEvent(workflowId, {
			type: 'nodeExecuteAfter',
			executionId: ctx.executionId,
			nodeName: ctx.nodeName,
			executionIndex: ctx.taskData.executionIndex,
			status,
			executionTime: ctx.taskData.executionTime ?? 0,
			...(itemCountByConnectionType && Object.keys(itemCountByConnectionType).length > 0
				? { itemCountByConnectionType }
				: {}),
		});
	}

	@OnLifecycleEvent('workflowExecuteAfter')
	async onWorkflowExecuteAfter(ctx: WorkflowExecuteAfterContext): Promise<void> {
		const workflowId = ctx.workflow.id;
		if (!workflowId || !this.shareService.isWorkflowPubliclyShared(workflowId)) return;
		if (ctx.runData.status === 'waiting') return;

		const rawStatus = ctx.runData.status;
		const status: 'success' | 'error' | 'canceled' =
			rawStatus === 'canceled' ? 'canceled' : rawStatus === 'success' ? 'success' : 'error';

		this.streamService.publishLifecycleEvent(workflowId, {
			type: 'workflowExecuteAfter',
			executionId: ctx.executionId,
			status,
		});
	}
}
