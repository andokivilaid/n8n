import type { PublicCanvasWorkflowResponse } from '@n8n/api-types';
import { Get, Param, RestController } from '@n8n/decorators';
import { NotFoundError, TooManyRequestsError } from '@n8n/errors';
import type { Request, Response } from 'express';

import { PublicCanvasShareService } from './public-canvas-share.service';
import { PublicCanvasStreamService } from './public-canvas-stream.service';

type FlushableResponse = Response & { flush?: () => void };

@RestController('/public-canvas')
export class PublicCanvasController {
	constructor(
		private readonly shareService: PublicCanvasShareService,
		private readonly streamService: PublicCanvasStreamService,
	) {}

	// Public read-only endpoint: do not add @GlobalScope or @ProjectScope.
	// Authorization is gated by the unguessable per-workflow `shareToken` when
	// public sharing is enabled, and the response strips credentials and parameters.
	@Get('/:shareToken', {
		skipAuth: true,
		allowBots: true,
		ipRateLimit: { limit: 60, windowMs: 60_000 },
	})
	async getPublicWorkflow(
		_req: Request,
		_res: Response,
		@Param('shareToken') shareToken: string,
	): Promise<PublicCanvasWorkflowResponse> {
		const loaded = await this.shareService.loadSanitizedPublicWorkflow(shareToken);
		if (!loaded) {
			throw new NotFoundError('Public workflow not found');
		}

		const activeRun = this.streamService.getActiveRunSnapshot(loaded.workflow.id);
		return {
			workflow: loaded.workflow,
			nodeTypes: loaded.nodeTypes,
			activeRun,
		};
	}

	// Public SSE live-status stream: do not add @GlobalScope or @ProjectScope.
	// Authorization is gated by `shareToken`, and events carry only node status metadata.
	@Get('/:shareToken/events', {
		skipAuth: true,
		allowBots: true,
		usesTemplates: true,
		ipRateLimit: { limit: 30, windowMs: 60_000 },
	})
	async streamPublicEvents(
		req: Request,
		res: FlushableResponse,
		@Param('shareToken') shareToken: string,
	): Promise<void> {
		const workflowId = this.shareService.resolveWorkflowIdByToken(shareToken);
		if (!workflowId) {
			throw new NotFoundError('Public workflow not found');
		}

		const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
		const admission = this.streamService.canAcceptSubscriber(workflowId, clientIp);
		if (!admission.allowed) {
			throw new TooManyRequestsError(admission.reason);
		}

		const removeSubscriber = this.streamService.addSubscriber(
			workflowId,
			shareToken,
			clientIp,
			res,
		);
		req.once('close', removeSubscriber);
		req.once('end', removeSubscriber);
		res.once('finish', removeSubscriber);

		req.socket.setTimeout(0);
		req.socket.setNoDelay(true);
		req.socket.setKeepAlive(true);
		(res as unknown as { compress: boolean }).compress = false;
		res.setHeader('Content-Type', 'text/event-stream; charset=UTF-8');
		res.setHeader('Cache-Control', 'no-cache, no-transform');
		res.setHeader('Connection', 'keep-alive');
		res.setHeader('X-Accel-Buffering', 'no');
		res.flushHeaders();
		res.write(':ok\n\n');
		res.flush?.();
	}
}
