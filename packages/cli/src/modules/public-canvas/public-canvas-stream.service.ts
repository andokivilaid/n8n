import type {
	PublicCanvasActiveRunSnapshot,
	PublicCanvasCompletedNodeState,
	PublicCanvasPushEvent,
} from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { Publisher } from '@n8n/backend-services';
import { ExecutionsConfig } from '@n8n/config';
import { OnPubSubEvent } from '@n8n/decorators';
import { Service } from '@n8n/di';
import type { Response } from 'express';
import { InstanceSettings } from 'n8n-core';

export const MAX_PUBLIC_SUBSCRIBERS_PER_WORKFLOW = 100;
export const MAX_PUBLIC_SUBSCRIBERS_PER_IP = 20;
const KEEPALIVE_INTERVAL_MS = 20_000;
const STALE_RUN_TTL_MS = 30 * 60_000;

type FlushableResponse = Response & { flush?: () => void };

interface SubscriberEntry {
	res: FlushableResponse;
	clientIp: string;
	shareToken: string;
}

interface TrackedActiveRun {
	executionId: string;
	startedAt: string;
	startedAtMs: number;
	executingNodes: Map<string, number>;
	completedNodes: Record<string, PublicCanvasCompletedNodeState[]>;
}

@Service()
export class PublicCanvasStreamService {
	private readonly subscribersByWorkflow = new Map<string, Set<SubscriberEntry>>();

	private readonly subscriberCountByIp = new Map<string, number>();

	private readonly activeRunByWorkflow = new Map<string, TrackedActiveRun>();

	private keepAliveTimer?: NodeJS.Timeout;

	constructor(
		private readonly instanceSettings: InstanceSettings,
		private readonly executionsConfig: ExecutionsConfig,
		private readonly publisher: Publisher,
		private readonly logger: Logger,
	) {}

	init(): void {
		if (this.instanceSettings.instanceType !== 'main' || this.keepAliveTimer) return;

		this.keepAliveTimer = setInterval(() => {
			this.sendKeepAliveAndPruneStaleRuns();
		}, KEEPALIVE_INTERVAL_MS);
		this.keepAliveTimer.unref();
	}

	shutdown(): void {
		if (this.keepAliveTimer) {
			clearInterval(this.keepAliveTimer);
			this.keepAliveTimer = undefined;
		}
		for (const entries of this.subscribersByWorkflow.values()) {
			for (const entry of entries) {
				try {
					entry.res.end();
				} catch {}
			}
		}
		this.subscribersByWorkflow.clear();
		this.subscriberCountByIp.clear();
		this.activeRunByWorkflow.clear();
	}

	canAcceptSubscriber(
		workflowId: string,
		clientIp: string,
	): { allowed: true } | { allowed: false; reason: string } {
		const workflowSubs = this.subscribersByWorkflow.get(workflowId)?.size ?? 0;
		if (workflowSubs >= MAX_PUBLIC_SUBSCRIBERS_PER_WORKFLOW) {
			return { allowed: false, reason: 'Too many live viewers for this workflow' };
		}

		const ipSubs = this.subscriberCountByIp.get(clientIp) ?? 0;
		if (ipSubs >= MAX_PUBLIC_SUBSCRIBERS_PER_IP) {
			return { allowed: false, reason: 'Too many live stream connections from this address' };
		}

		return { allowed: true };
	}

	addSubscriber(
		workflowId: string,
		shareToken: string,
		clientIp: string,
		res: FlushableResponse,
	): () => void {
		const entry: SubscriberEntry = { res, clientIp, shareToken };
		let set = this.subscribersByWorkflow.get(workflowId);
		if (!set) {
			set = new Set();
			this.subscribersByWorkflow.set(workflowId, set);
		}
		set.add(entry);
		this.subscriberCountByIp.set(clientIp, (this.subscriberCountByIp.get(clientIp) ?? 0) + 1);

		let removed = false;
		return () => {
			if (removed) return;
			removed = true;

			const currentSet = this.subscribersByWorkflow.get(workflowId);
			if (currentSet) {
				currentSet.delete(entry);
				if (currentSet.size === 0) {
					this.subscribersByWorkflow.delete(workflowId);
				}
			}

			const count = (this.subscriberCountByIp.get(clientIp) ?? 1) - 1;
			if (count <= 0) {
				this.subscriberCountByIp.delete(clientIp);
			} else {
				this.subscriberCountByIp.set(clientIp, count);
			}
		};
	}

	disconnectWorkflowSubscribers(workflowId: string, onlyShareToken?: string): void {
		const set = this.subscribersByWorkflow.get(workflowId);
		if (!set) return;

		for (const entry of [...set]) {
			if (onlyShareToken && entry.shareToken !== onlyShareToken) continue;
			try {
				entry.res.end();
			} catch {}
		}
	}

	getActiveRunSnapshot(workflowId: string): PublicCanvasActiveRunSnapshot | null {
		const run = this.activeRunByWorkflow.get(workflowId);
		if (!run) return null;
		if (Date.now() - run.startedAtMs > STALE_RUN_TTL_MS) {
			this.activeRunByWorkflow.delete(workflowId);
			return null;
		}

		return {
			executionId: run.executionId,
			startedAt: run.startedAt,
			executingNodes: Array.from(run.executingNodes.entries()).map(
				([nodeName, executionIndex]) => ({
					nodeName,
					executionIndex,
				}),
			),
			completedNodes: structuredClone(run.completedNodes),
		};
	}

	publishLifecycleEvent(workflowId: string, event: PublicCanvasPushEvent): void {
		if (this.instanceSettings.instanceType === 'main') {
			this.applyAndBroadcastLocal(workflowId, event);
		}

		// In queue mode or multi-main, relay across processes so every main with connected viewers gets it.
		if (
			this.executionsConfig.mode === 'queue' ||
			this.instanceSettings.instanceType !== 'main' ||
			this.instanceSettings.isMultiMain
		) {
			void this.publisher
				.publishCommand({
					command: 'relay-public-canvas-event',
					payload: { workflowId, event },
				})
				.catch((error: unknown) => {
					this.logger.debug('Failed to relay public canvas event over pubsub', { error });
				});
		}
	}

	@OnPubSubEvent('relay-public-canvas-event', { instanceType: 'main' })
	handleRelayedEvent({
		workflowId,
		event,
	}: {
		workflowId: string;
		event: PublicCanvasPushEvent;
	}): void {
		this.applyAndBroadcastLocal(workflowId, event);
	}

	private applyAndBroadcastLocal(workflowId: string, event: PublicCanvasPushEvent): void {
		this.updateActiveRunState(workflowId, event);

		const subscribers = this.subscribersByWorkflow.get(workflowId);
		if (!subscribers || subscribers.size === 0) return;

		const serialized = `data: ${JSON.stringify(event)}\n\n`;
		for (const subscriber of subscribers) {
			try {
				subscriber.res.write(serialized);
				subscriber.res.flush?.();
			} catch {
				// Socket cleanup runs on close/finish.
			}
		}
	}

	private updateActiveRunState(workflowId: string, event: PublicCanvasPushEvent): void {
		switch (event.type) {
			case 'workflowExecuteBefore': {
				this.activeRunByWorkflow.set(workflowId, {
					executionId: event.executionId,
					startedAt: event.startedAt,
					startedAtMs: Date.now(),
					executingNodes: new Map(),
					completedNodes: {},
				});
				return;
			}
			case 'nodeExecuteBefore': {
				const run = this.activeRunByWorkflow.get(workflowId);
				if (!run || run.executionId !== event.executionId) return;
				run.executingNodes.set(event.nodeName, event.executionIndex);
				return;
			}
			case 'nodeExecuteAfter': {
				const run = this.activeRunByWorkflow.get(workflowId);
				if (!run || run.executionId !== event.executionId) return;
				run.executingNodes.delete(event.nodeName);
				const runsForNode = run.completedNodes[event.nodeName] ?? [];
				runsForNode.push({
					executionIndex: event.executionIndex,
					status: event.status,
					executionTime: event.executionTime,
					...(event.itemCountByConnectionType
						? { itemCountByConnectionType: event.itemCountByConnectionType }
						: {}),
				});
				run.completedNodes[event.nodeName] = runsForNode;
				return;
			}
			case 'workflowExecuteAfter': {
				const run = this.activeRunByWorkflow.get(workflowId);
				if (run && run.executionId === event.executionId) {
					this.activeRunByWorkflow.delete(workflowId);
				}
				return;
			}
		}
	}

	private sendKeepAliveAndPruneStaleRuns(): void {
		const now = Date.now();
		for (const [workflowId, run] of this.activeRunByWorkflow.entries()) {
			if (now - run.startedAtMs > STALE_RUN_TTL_MS) {
				this.activeRunByWorkflow.delete(workflowId);
			}
		}

		for (const subscribers of this.subscribersByWorkflow.values()) {
			for (const subscriber of subscribers) {
				try {
					subscriber.res.write(':ping\n\n');
					subscriber.res.flush?.();
				} catch {}
			}
		}
	}
}
