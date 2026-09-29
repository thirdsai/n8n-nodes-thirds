import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class ThirdsApi implements ICredentialType {
	name = 'thirdsApi';

	displayName = 'thirds.ai API';

	icon: Icon = { light: 'file:../icons/thirds.svg', dark: 'file:../icons/thirds.dark.svg' };

	documentationUrl = 'https://thirds.ai/docs/api#authentication';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'Make a key on the API keys page of your thirds.ai account',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// A cheap read: one template summary. It spends no credits.
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://thirds.ai',
			url: '/v1/templates',
			qs: { limit: 1 },
		},
	};
}
