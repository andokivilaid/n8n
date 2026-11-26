import { UpdatePublicCanvasShareDto, type PublicCanvasShareStatusDto } from '@n8n/api-types';
import { AuthenticatedRequest } from '@n8n/db';
import { Body, Get, Param, ProjectScope, Put, RestController } from '@n8n/decorators';
import { NotFoundError } from '@n8n/errors';

import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

import { PublicCanvasShareService } from './public-canvas-share.service';
import { PublicCanvasStreamService } from './public-canvas-stream.service';

@RestController('/projects/:projectId/workflows/:workflowId/public-canvas')
export class PublicCanvasManagementController {
	constructor(
		private readonly shareService: PublicCanvasShareService,
		private readonly streamService: PublicCanvasStreamService,
		private readonly workflowFinderService: WorkflowFinderService,
	) {}

	@Get('/')
	@ProjectScope('workflow:read')
	async getStatus(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('projectId') projectId: string,
		@Param('workflowId') workflowId: string,
	): Promise<PublicCanvasShareStatusDto> {
		const workflow = await this.workflowFinderService.findWorkflowForUser(workflowId, req.user, [
			'workflow:read',
		]);
		if (!workflow || !(await this.shareService.isWorkflowInProject(workflowId, projectId))) {
			throw new NotFoundError('Workflow not found');
		}

		return this.shareService.getShareStatus(workflowId);
	}

	@Put('/')
	@ProjectScope('workflow:update')
	async updateStatus(
		req: AuthenticatedRequest,
		_res: unknown,
		@Param('projectId') projectId: string,
		@Param('workflowId') workflowId: string,
		@Body body: UpdatePublicCanvasShareDto,
	): Promise<PublicCanvasShareStatusDto> {
		const workflow = await this.workflowFinderService.findWorkflowForUser(workflowId, req.user, [
			'workflow:update',
		]);
		if (!workflow || !(await this.shareService.isWorkflowInProject(workflowId, projectId))) {
			throw new NotFoundError('Workflow not found');
		}

		const { status, previousToken } = await this.shareService.updateShare(workflowId, {
			enabled: body.enabled,
			rotateToken: body.rotateToken,
		});

		if (!status.enabled) {
			this.streamService.disconnectWorkflowSubscribers(workflowId);
		} else if (previousToken && previousToken !== status.shareToken) {
			this.streamService.disconnectWorkflowSubscribers(workflowId, previousToken);
		}

		return status;
	}
}
