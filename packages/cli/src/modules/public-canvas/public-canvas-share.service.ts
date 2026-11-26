import { randomBytes } from 'node:crypto';
import type {
	PublicCanvasShareStatusDto,
	PublicCanvasWorkflowGroup,
	PublicCanvasWorkflowNode,
	PublicCanvasWorkflowPayload,
} from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { EventService, Publisher } from '@n8n/backend-services';
import {
	type OperationContext,
	SettingsRepository,
	SharedWorkflowRepository,
	TransactionRunner,
	type WorkflowEntity,
	WorkflowRepository,
} from '@n8n/db';
import { OnPubSubEvent } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { type INodeTypeDescription, jsonParse } from 'n8n-workflow';

import { NodeTypes } from '@/node-types';

const PUBLIC_CANVAS_SHARES_KEY = 'publicCanvas.shares';
const STICKY_NOTE_TYPE = 'n8n-nodes-base.stickyNote';

interface StoredPublicShare {
	enabled: boolean;
	shareToken: string;
	updatedAt: string;
}

type StoredPublicSharesMap = Record<string, StoredPublicShare>;

@Service()
export class PublicCanvasShareService {
	private sharesByWorkflowId = new Map<string, StoredPublicShare>();

	private workflowIdByToken = new Map<string, string>();

	private writeQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly settingsRepository: SettingsRepository,
		private readonly workflowRepository: WorkflowRepository,
		private readonly sharedWorkflowRepository: SharedWorkflowRepository,
		private readonly txRunner: TransactionRunner,
		private readonly nodeTypes: NodeTypes,
		private readonly eventService: EventService,
		private readonly publisher: Publisher,
		private readonly logger: Logger,
	) {}

	async init(): Promise<void> {
		await this.reloadShares();

		this.eventService.on('workflow-deleted', async ({ workflowId }) => {
			if (!this.sharesByWorkflowId.has(workflowId)) return;
			try {
				await this.removeWorkflowShare(workflowId);
			} catch (error) {
				this.logger.warn('Failed to clean up public canvas share for deleted workflow', {
					workflowId,
					error,
				});
			}
		});
	}

	@OnPubSubEvent('reload-public-canvas-shares')
	@OnPubSubEvent('pubsub-reconnected')
	async reloadShares(ctx: OperationContext = {}): Promise<void> {
		const row = await this.settingsRepository.findByKeyInContext(PUBLIC_CANVAS_SHARES_KEY, ctx);
		const parsed = row?.value
			? jsonParse<StoredPublicSharesMap>(row.value, { fallbackValue: {} })
			: {};

		const nextByWorkflow = new Map<string, StoredPublicShare>();
		const nextByToken = new Map<string, string>();

		for (const [workflowId, entry] of Object.entries(parsed)) {
			if (
				entry &&
				typeof entry.enabled === 'boolean' &&
				typeof entry.shareToken === 'string' &&
				entry.shareToken.length > 0
			) {
				nextByWorkflow.set(workflowId, entry);
				if (entry.enabled) {
					nextByToken.set(entry.shareToken, workflowId);
				}
			}
		}

		this.sharesByWorkflowId = nextByWorkflow;
		this.workflowIdByToken = nextByToken;
	}

	getShareStatus(workflowId: string): PublicCanvasShareStatusDto {
		const entry = this.sharesByWorkflowId.get(workflowId);
		if (!entry) {
			return { enabled: false, shareToken: null };
		}
		return {
			enabled: entry.enabled,
			shareToken: entry.enabled ? entry.shareToken : null,
		};
	}

	isWorkflowPubliclyShared(workflowId: string): boolean {
		return this.sharesByWorkflowId.get(workflowId)?.enabled === true;
	}

	resolveWorkflowIdByToken(shareToken: string): string | null {
		return this.workflowIdByToken.get(shareToken) ?? null;
	}

	async isWorkflowInProject(workflowId: string, projectId: string): Promise<boolean> {
		const owningProject = await this.sharedWorkflowRepository.getWorkflowOwningProject(workflowId);
		return owningProject?.id === projectId;
	}

	async updateShare(
		workflowId: string,
		options: { enabled: boolean; rotateToken?: boolean },
	): Promise<{ status: PublicCanvasShareStatusDto; previousToken: string | null }> {
		let previousToken: string | null = null;
		let status: PublicCanvasShareStatusDto = { enabled: false, shareToken: null };

		await this.serializeWrite(async () => {
			await this.txRunner.run({}, async (ctx) => {
				await this.reloadShares(ctx);
				const existing = this.sharesByWorkflowId.get(workflowId);
				previousToken = existing?.shareToken ?? null;

				const shouldGenerateNewToken =
					!existing?.shareToken ||
					options.rotateToken === true ||
					(!existing.enabled && options.enabled);

				const shareToken = shouldGenerateNewToken
					? this.generateUniqueToken()
					: existing.shareToken;

				const updated: StoredPublicShare = {
					enabled: options.enabled,
					shareToken,
					updatedAt: new Date().toISOString(),
				};

				this.sharesByWorkflowId.set(workflowId, updated);
				await this.persistCurrentMap(ctx);
				this.rebuildTokenIndex();

				status = {
					enabled: updated.enabled,
					shareToken: updated.enabled ? updated.shareToken : null,
				};
			});
		});

		await this.notifyPeers();
		return { status, previousToken };
	}

	async removeWorkflowShare(workflowId: string): Promise<void> {
		await this.serializeWrite(async () => {
			await this.txRunner.run({}, async (ctx) => {
				await this.reloadShares(ctx);
				if (!this.sharesByWorkflowId.delete(workflowId)) return;
				await this.persistCurrentMap(ctx);
				this.rebuildTokenIndex();
			});
		});

		await this.notifyPeers();
	}

	async loadSanitizedPublicWorkflow(shareToken: string): Promise<{
		workflow: PublicCanvasWorkflowPayload;
		nodeTypes: INodeTypeDescription[];
	} | null> {
		const workflowId = this.resolveWorkflowIdByToken(shareToken);
		if (!workflowId) return null;

		const entity = await this.workflowRepository.findById(workflowId);
		if (!entity || entity.isArchived) return null;

		const workflow = this.sanitizeWorkflowEntity(entity);
		const nodeTypes = this.collectNodeTypesForNodes(workflow.nodes);

		return { workflow, nodeTypes };
	}

	sanitizeWorkflowEntity(entity: WorkflowEntity): PublicCanvasWorkflowPayload {
		const visibleNodes = (entity.nodes ?? []).filter((node) => node.type !== STICKY_NOTE_TYPE);
		const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
		const visibleNodeNames = new Set(visibleNodes.map((node) => node.name));

		// Strict allowlist: never include node parameters, credentials, webhookIds, or notes.
		const nodes: PublicCanvasWorkflowNode[] = visibleNodes.map((node) => ({
			id: node.id,
			name: node.name,
			type: node.type,
			typeVersion: node.typeVersion,
			position: [node.position[0], node.position[1]],
			...(node.disabled ? { disabled: true } : {}),
			...(node.parameters?.emptyGroupAnchor === true ? { emptyGroupAnchor: true } : {}),
		}));

		const connections: PublicCanvasWorkflowPayload['connections'] = {};
		for (const [sourceName, byType] of Object.entries(entity.connections ?? {})) {
			if (!visibleNodeNames.has(sourceName) || !byType) continue;
			const filteredByType: typeof byType = {};
			for (const [connType, outputs] of Object.entries(byType)) {
				if (!Array.isArray(outputs)) continue;
				filteredByType[connType] = outputs.map((targets) =>
					Array.isArray(targets)
						? targets
								.filter((target) => target && visibleNodeNames.has(target.node))
								.map((target) => ({
									node: target.node,
									type: target.type,
									index: target.index,
								}))
						: [],
				);
			}
			connections[sourceName] = filteredByType;
		}

		const rawGroups = entity.nodeGroups;
		const nodeGroups: PublicCanvasWorkflowGroup[] = Array.isArray(rawGroups)
			? rawGroups.map((group) => ({
					id: group.id,
					name: group.name,
					nodeIds: (group.nodeIds ?? []).filter((id) => visibleNodeIds.has(id)),
				}))
			: [];

		return {
			id: entity.id,
			name: entity.name,
			active: Boolean(entity.activeVersionId),
			nodes,
			connections,
			nodeGroups,
		};
	}

	private collectNodeTypesForNodes(nodes: PublicCanvasWorkflowNode[]): INodeTypeDescription[] {
		const seen = new Set<string>();
		const descriptions: INodeTypeDescription[] = [];

		for (const node of nodes) {
			const key = `${node.type}@${node.typeVersion}`;
			if (seen.has(key)) continue;
			seen.add(key);

			try {
				const nodeType = this.nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
				if (nodeType?.description) {
					descriptions.push({
						...nodeType.description,
						// Strip property schemas so the public payload stays compact and minimal.
						properties: [],
					});
				}
			} catch {
				// Uninstalled community nodes render with n8n's unknown-node fallback on the canvas.
			}
		}

		return descriptions;
	}

	private generateUniqueToken(): string {
		for (let attempt = 0; attempt < 5; attempt++) {
			const candidate = randomBytes(24).toString('base64url');
			if (!this.workflowIdByToken.has(candidate)) {
				return candidate;
			}
		}
		return randomBytes(32).toString('base64url');
	}

	private rebuildTokenIndex(): void {
		const nextByToken = new Map<string, string>();
		for (const [workflowId, entry] of this.sharesByWorkflowId.entries()) {
			if (entry.enabled && entry.shareToken) {
				nextByToken.set(entry.shareToken, workflowId);
			}
		}
		this.workflowIdByToken = nextByToken;
	}

	private async serializeWrite<T>(work: () => Promise<T>): Promise<T> {
		const next = this.writeQueue.then(work, work);
		this.writeQueue = next.then(
			() => undefined,
			() => undefined,
		);
		return await next;
	}

	private async persistCurrentMap(ctx: OperationContext = {}): Promise<void> {
		const plain: StoredPublicSharesMap = Object.fromEntries(this.sharesByWorkflowId.entries());
		await this.settingsRepository.upsertByKey(
			PUBLIC_CANVAS_SHARES_KEY,
			JSON.stringify(plain),
			false,
			ctx,
		);
	}

	private async notifyPeers(): Promise<void> {
		try {
			await this.publisher.publishCommand({ command: 'reload-public-canvas-shares' });
		} catch (error) {
			this.logger.debug('Skipped pubsub notification for public canvas shares', { error });
		}
	}
}
