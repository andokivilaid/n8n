import type { Logger } from '@n8n/backend-common';
import type { Publisher } from '@n8n/backend-services';
import type { ExecutionsConfig } from '@n8n/config';
import type { Response } from 'express';
import type { InstanceSettings } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import {
	MAX_PUBLIC_SUBSCRIBERS_PER_IP,
	PublicCanvasStreamService,
} from '../public-canvas-stream.service';

describe('PublicCanvasStreamService', () => {
	function createService() {
		const instanceSettings = mock<InstanceSettings>({
			instanceType: 'main',
			isMultiMain: false,
		});
		const executionsConfig = mock<ExecutionsConfig>({ mode: 'regular' });
		const publisher = mock<Publisher>();
		publisher.publishCommand.mockResolvedValue(undefined);
		const logger = mock<Logger>();

		return new PublicCanvasStreamService(instanceSettings, executionsConfig, publisher, logger);
	}

	it('broadcasts live lifecycle events to subscribed SSE responses and tracks active run snapshots', () => {
		const service = createService();
		const writes: string[] = [];
		const fakeRes = {
			write: vi.fn((chunk: string) => {
				writes.push(chunk);
				return true;
			}),
			flush: vi.fn(),
			end: vi.fn(),
		} as unknown as Response;

		const unsubscribe = service.addSubscriber('wf-1', 'tok-1', '203.0.113.10', fakeRes);

		service.publishLifecycleEvent('wf-1', {
			type: 'workflowExecuteBefore',
			executionId: 'exec-1',
			startedAt: '2026-11-26T22:00:00.000Z',
		});
		service.publishLifecycleEvent('wf-1', {
			type: 'nodeExecuteBefore',
			executionId: 'exec-1',
			nodeName: 'Webhook',
			executionIndex: 0,
		});
		service.publishLifecycleEvent('wf-1', {
			type: 'nodeExecuteAfter',
			executionId: 'exec-1',
			nodeName: 'Webhook',
			executionIndex: 0,
			status: 'success',
			executionTime: 12,
			itemCountByConnectionType: { main: [2] },
		});
		service.publishLifecycleEvent('wf-1', {
			type: 'nodeExecuteBefore',
			executionId: 'exec-1',
			nodeName: 'HTTP Request',
			executionIndex: 1,
		});

		const snapshot = service.getActiveRunSnapshot('wf-1');
		expect(snapshot).toEqual({
			executionId: 'exec-1',
			startedAt: '2026-11-26T22:00:00.000Z',
			executingNodes: [{ nodeName: 'HTTP Request', executionIndex: 1 }],
			completedNodes: {
				Webhook: [
					{
						executionIndex: 0,
						status: 'success',
						executionTime: 12,
						itemCountByConnectionType: { main: [2] },
					},
				],
			},
		});

		service.publishLifecycleEvent('wf-1', {
			type: 'workflowExecuteAfter',
			executionId: 'exec-1',
			status: 'success',
		});
		expect(service.getActiveRunSnapshot('wf-1')).toBeNull();
		expect(writes).toHaveLength(5);

		unsubscribe();
		service.shutdown();
	});

	it('enforces per-IP SSE connection limits', () => {
		const service = createService();
		const cleanups: Array<() => void> = [];

		for (let i = 0; i < MAX_PUBLIC_SUBSCRIBERS_PER_IP; i++) {
			expect(service.canAcceptSubscriber(`wf-${i}`, '198.51.100.5')).toEqual({ allowed: true });
			const res = { write: vi.fn(), end: vi.fn() } as unknown as Response;
			cleanups.push(service.addSubscriber(`wf-${i}`, `tok-${i}`, '198.51.100.5', res));
		}

		expect(service.canAcceptSubscriber('wf-extra', '198.51.100.5').allowed).toBe(false);
		cleanups[0]!();
		expect(service.canAcceptSubscriber('wf-extra', '198.51.100.5').allowed).toBe(true);

		service.shutdown();
	});
});
