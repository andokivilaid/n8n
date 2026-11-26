import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class E2bApi implements ICredentialType {
	name = 'e2bApi';

	displayName = 'E2B';

	documentationUrl = 'e2b';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
		},
		{
			displayName: 'Template',
			name: 'template',
			type: 'string',
			required: false,
			default: '',
		},
		{
			displayName: 'Domain',
			name: 'domain',
			type: 'string',
			required: false,
			default: '',
		},
	];
}
