import type { Logger } from '@n8n/backend-common';
import { EventService, type Publisher } from '@n8n/backend-services';
import type {
	OperationContext,
	Settings,
	SettingsRepository,
	SharedWorkflowRepository,
	TransactionRunner,
	WorkflowEntity,
	WorkflowRepository,
} from '@n8n/db';
import { mock } from 'vitest-mock-extended';

import type { NodeTypes } from '@/node-types';

import { PublicCanvasShareService } from '../public-canvas-share.service';

describe('PublicCanvasShareService', () => {
	function createSetup() {
		let storedValue: string | null = null;

		const settingsRepository = mock<SettingsRepository>();
		settingsRepository.findByKeyInContext.mockImplementation(async () =>
			storedValue === null ? null : mock<Settings>({ value: storedValue }),
		);
		settingsRepository.upsertByKey.mockImplementation(async (_key, value) => {
			storedValue = value;
			return mock<Settings>({ value });
		});

		const workflowRepository = mock<WorkflowRepository>();
		const sharedWorkflowRepository = mock<SharedWorkflowRepository>();
		const txRunner = mock<TransactionRunner>();
		txRunner.run.mockImplementation(
			async <T>(_ctx: OperationContext, fn: (ctx: OperationContext) => Promise<T>): Promise<T> =>
				await fn({}),
		);

		const nodeTypes = mock<NodeTypes>();
		const eventService = new EventService();
		const publisher = mock<Publisher>();
		publisher.publishCommand.mockResolvedValue(undefined);
		const logger = mock<Logger>();

		const service = new PublicCanvasShareService(
			settingsRepository,
			workflowRepository,
			sharedWorkflowRepository,
			txRunner,
			nodeTypes,
			eventService,
			publisher,
			logger,
		);

		return {
			service,
			settingsRepository,
			workflowRepository,
			sharedWorkflowRepository,
			nodeTypes,
			eventService,
			publisher,
		};
	}

	it('enables, rotates, and disables public share tokens cleanly', async () => {
		const { service } = createSetup();
		await service.init();

		expect(service.getShareStatus('wf-1')).toEqual({ enabled: false, shareToken: null });

		const first = await service.updateShare('wf-1', { enabled: true });
		expect(first.status.enabled).toBe(true);
		expect(first.status.shareToken).toBeTruthy();
		const token1 = first.status.shareToken!;
		expect(service.resolveWorkflowIdByToken(token1)).toBe('wf-1');

		const rotated = await service.updateShare('wf-1', { enabled: true, rotateToken: true });
		expect(rotated.previousToken).toBe(token1);
		expect(rotated.status.shareToken).not.toBe(token1);
		expect(service.resolveWorkflowIdByToken(token1)).toBeNull();
		expect(service.resolveWorkflowIdByToken(rotated.status.shareToken!)).toBe('wf-1');

		const disabled = await service.updateShare('wf-1', { enabled: false });
		expect(disabled.status).toEqual({ enabled: false, shareToken: null });
		expect(service.resolveWorkflowIdByToken(rotated.status.shareToken!)).toBeNull();
	});

	it('strips credentials, parameters, webhookIds, notes, and sticky notes when loading a public workflow', async () => {
		const { service, workflowRepository, nodeTypes } = createSetup();
		await service.init();

		const { status } = await service.updateShare('wf-secret', { enabled: true });

		workflowRepository.findById.mockResolvedValue({
			id: 'wf-secret',
			name: 'Customer Pipeline',
			isArchived: false,
			activeVersionId: 'ver-1',
			nodes: [
				{
					id: 'n1',
					name: 'Webhook',
					type: 'n8n-nodes-base.webhook',
					typeVersion: 2,
					position: [100, 200],
					webhookId: 'secret-webhook-id',
					parameters: { path: 'private-secret-endpoint' },
				},
				{
					id: 'n2',
					name: 'Postgres',
					type: 'n8n-nodes-base.postgres',
					typeVersion: 2.5,
					position: [360, 200],
					parameters: { query: 'SELECT * FROM users WHERE ssn = $1' },
					credentials: { postgres: { id: 'cred-123', name: 'Prod DB' } },
					notes: 'Internal DB password reminder',
				},
				{
					id: 'sticky-1',
					name: 'Sticky Note',
					type: 'n8n-nodes-base.stickyNote',
					typeVersion: 1,
					position: [0, 0],
					parameters: { content: 'Internal architecture notes' },
				},
			],
			connections: {
				Webhook: {
					main: [[{ node: 'Postgres', type: 'main', index: 0 }]],
				},
			},
		} as unknown as WorkflowEntity);

		nodeTypes.getByNameAndVersion.mockReturnValue({
			description: {
				displayName: 'Webhook',
				name: 'n8n-nodes-base.webhook',
				group: ['trigger'],
				version: 2,
				description: 'Starts workflow',
				defaults: { name: 'Webhook' },
				inputs: [],
				outputs: ['main'],
				properties: [
					{
						displayName: 'Path',
						name: 'path',
						type: 'string',
						default: '',
					},
				],
			},
		});

		const loaded = await service.loadSanitizedPublicWorkflow(status.shareToken!);
		expect(loaded).not.toBeNull();
		expect(loaded?.workflow.nodes).toEqual([
			{
				id: 'n1',
				name: 'Webhook',
				type: 'n8n-nodes-base.webhook',
				typeVersion: 2,
				position: [100, 200],
			},
			{
				id: 'n2',
				name: 'Postgres',
				type: 'n8n-nodes-base.postgres',
				typeVersion: 2.5,
				position: [360, 200],
			},
		]);
		expect(JSON.stringify(loaded)).not.toContain('private-secret-endpoint');
		expect(JSON.stringify(loaded)).not.toContain('SELECT * FROM users');
		expect(JSON.stringify(loaded)).not.toContain('cred-123');
		expect(JSON.stringify(loaded)).not.toContain('secret-webhook-id');
		expect(JSON.stringify(loaded)).not.toContain('Internal architecture notes');
		expect(loaded?.nodeTypes[0]?.properties).toEqual([]);
	});

	it('removes the share token when the workflow is deleted', async () => {
		const { service, eventService } = createSetup();
		await service.init();

		const { status } = await service.updateShare('wf-del', { enabled: true });
		expect(service.isWorkflowPubliclyShared('wf-del')).toBe(true);

		eventService.emit('workflow-deleted', {
			user: { id: 'u1' } as never,
			workflowId: 'wf-del',
			workflowName: 'Deleted WF',
			projectId: 'p1',
			publicApi: false,
		});
		await new Promise((resolve) => setImmediate(resolve));

		expect(service.isWorkflowPubliclyShared('wf-del')).toBe(false);
		expect(service.resolveWorkflowIdByToken(status.shareToken!)).toBeNull();
	});
});
