import type { IConnections, INodeTypeDescription, IWorkflowGroup } from 'n8n-workflow';
import { z } from 'zod';
import { Z } from './zod-class';

export const updatePublicCanvasShareSchema = z.object({
	enabled: z.boolean(),
	rotateToken: z.boolean().optional(),
});

export class UpdatePublicCanvasShareDto extends Z.class(updatePublicCanvasShareSchema.shape) {}

export interface PublicCanvasShareStatusDto {
	enabled: boolean;
	shareToken: string | null;
}

export interface PublicCanvasWorkflowNode {
	id: string;
	name: string;
	type: string;
	typeVersion: number;
	position: [number, number];
	disabled?: boolean;
	emptyGroupAnchor?: boolean;
}

export type PublicCanvasWorkflowGroup = Pick<IWorkflowGroup, 'id' | 'name' | 'nodeIds'>;

export interface PublicCanvasWorkflowPayload {
	id: string;
	name: string;
	active: boolean;
	nodes: PublicCanvasWorkflowNode[];
	connections: IConnections;
	nodeGroups: PublicCanvasWorkflowGroup[];
}

export interface PublicCanvasCompletedNodeState {
	executionIndex: number;
	status: 'success' | 'error' | 'waiting';
	executionTime: number;
	itemCountByConnectionType?: Record<string, number[]>;
}

export interface PublicCanvasActiveRunSnapshot {
	executionId: string;
	startedAt: string;
	executingNodes: Array<{ nodeName: string; executionIndex: number }>;
	completedNodes: Record<string, PublicCanvasCompletedNodeState[]>;
}

export interface PublicCanvasWorkflowResponse {
	workflow: PublicCanvasWorkflowPayload;
	nodeTypes: INodeTypeDescription[];
	activeRun: PublicCanvasActiveRunSnapshot | null;
}

export type PublicCanvasPushEvent =
	| {
			type: 'workflowExecuteBefore';
			executionId: string;
			startedAt: string;
	  }
	| {
			type: 'nodeExecuteBefore';
			executionId: string;
			nodeName: string;
			executionIndex: number;
	  }
	| {
			type: 'nodeExecuteAfter';
			executionId: string;
			nodeName: string;
			executionIndex: number;
			status: 'success' | 'error' | 'waiting';
			executionTime: number;
			itemCountByConnectionType?: Record<string, number[]>;
	  }
	| {
			type: 'workflowExecuteAfter';
			executionId: string;
			status: 'success' | 'error' | 'canceled';
	  };
