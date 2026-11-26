import type { PublicCanvasShareStatusDto, PublicCanvasWorkflowResponse } from '@n8n/api-types';
import { makeRestApiRequest, type IRestApiContext } from '@n8n/rest-api-client';

export async function getPublicCanvasShareStatus(
	context: IRestApiContext,
	projectId: string,
	workflowId: string,
): Promise<PublicCanvasShareStatusDto> {
	return await makeRestApiRequest<PublicCanvasShareStatusDto>(
		context,
		'GET',
		`/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/public-canvas`,
	);
}

export async function updatePublicCanvasShareStatus(
	context: IRestApiContext,
	projectId: string,
	workflowId: string,
	payload: { enabled: boolean; rotateToken?: boolean },
): Promise<PublicCanvasShareStatusDto> {
	return await makeRestApiRequest<PublicCanvasShareStatusDto>(
		context,
		'PUT',
		`/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/public-canvas`,
		payload,
	);
}

export async function fetchPublicCanvasWorkflow(
	restUrl: string,
	shareToken: string,
): Promise<PublicCanvasWorkflowResponse> {
	const base = restUrl.replace(/\/$/, '');
	const response = await fetch(`${base}/public-canvas/${encodeURIComponent(shareToken)}`, {
		method: 'GET',
		headers: {
			Accept: 'application/json',
		},
		credentials: 'omit',
	});

	if (!response.ok) {
		throw new Error(`HTTP_${response.status}`);
	}

	const json = (await response.json()) as {
		data?: PublicCanvasWorkflowResponse;
	} & Partial<PublicCanvasWorkflowResponse>;
	if (json.data && 'workflow' in json.data) {
		return json.data;
	}
	if (json.workflow && json.nodeTypes) {
		return {
			workflow: json.workflow,
			nodeTypes: json.nodeTypes,
			activeRun: json.activeRun ?? null,
		};
	}

	throw new Error('INVALID_PUBLIC_WORKFLOW_RESPONSE');
}
