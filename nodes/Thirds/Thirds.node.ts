import type {
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { makeFile, type FileKind, type TemplateCache } from './make';
import { getTemplateFields, searchTemplates } from './methods';

/** Keeps an n8n error as it is, with its item, and wraps any other error. */
function asNodeError(node: INode, error: unknown, itemIndex: number) {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	return new NodeOperationError(node, error as Error, { itemIndex });
}

export class Thirds implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'thirds.ai',
		name: 'thirds',
		icon: { light: 'file:../../icons/thirds.svg', dark: 'file:../../icons/thirds.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] === "makeImage" ? "Make an image" : "Make a PDF"}}',
		description: 'Make branded PDFs and images from your saved thirds.ai templates',
		defaults: {
			name: 'thirds.ai',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'thirdsApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Make a PDF',
						value: 'makePdf',
						action: 'Make a PDF',
						description: 'Fill a saved template with your data and get a PDF',
					},
					{
						name: 'Make an Image',
						value: 'makeImage',
						action: 'Make an image',
						description: 'Fill a saved template with your data and get a PNG, JPEG, or WebP',
					},
				],
				default: 'makePdf',
			},
			{
				displayName: 'Template',
				name: 'template',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				description: 'The saved design to fill in',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						placeholder: 'Choose a template...',
						typeOptions: {
							searchListMethod: 'searchTemplates',
							searchable: true,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. tpl_0123456789abcdef0123456789abcdef',
						validation: [
							{
								type: 'regex',
								properties: {
									regex: '^tpl_[0-9a-f]{32}$',
									errorMessage: 'A template ID starts with tpl_ and has 32 letters and numbers',
								},
							},
						],
					},
				],
			},
			{
				displayName: 'Data',
				name: 'dataMode',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Fill In Each Field',
						value: 'fields',
						description: 'Type or drag a value into each field the template has',
					},
					{
						name: 'Use JSON',
						value: 'json',
						description: 'Send all the values as one JSON object',
					},
				],
				default: 'fields',
			},
			{
				displayName: 'Fields',
				name: 'fields',
				type: 'resourceMapper',
				noDataExpression: true,
				default: {
					mappingMode: 'defineBelow',
					value: null,
				},
				required: true,
				typeOptions: {
					loadOptionsDependsOn: ['template.value', 'options.version'],
					resourceMapper: {
						resourceMapperMethod: 'getTemplateFields',
						mode: 'add',
						fieldWords: { singular: 'field', plural: 'fields' },
						addAllFields: true,
						multiKeyMatch: false,
						supportAutoMap: false,
						noFieldsError:
							"This template doesn't list its fields. Choose Use JSON under Data instead.",
					},
				},
				displayOptions: { show: { dataMode: ['fields'] } },
			},
			{
				displayName: 'JSON',
				name: 'dataJson',
				type: 'json',
				default: '{\n  "client_name": "Harbor Street Bakery",\n  "total": 480\n}',
				description: 'The values for this file, such as the client name and the total',
				displayOptions: { show: { dataMode: ['json'] } },
			},
			{
				displayName: 'Image Format',
				name: 'imageFormat',
				type: 'options',
				options: [
					{ name: 'PNG', value: 'png' },
					{ name: 'JPEG', value: 'jpeg' },
					{ name: 'WebP', value: 'webp' },
				],
				default: 'png',
				displayOptions: { show: { operation: ['makeImage'] } },
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Brand Kit ID',
						name: 'brandKitId',
						type: 'string',
						default: '',
						placeholder: 'e.g. kit_0123456789abcdef0123456789abcdef',
						description:
							"Use the logo, colours, and fonts from this brand kit instead of the template's own",
					},
					{
						displayName: 'File Name',
						name: 'fileName',
						type: 'string',
						default: '',
						placeholder: 'e.g. invoice-1042',
						description: 'The name of the file you download. We add the right ending.',
					},
					{
						displayName: 'Height (Pixels)',
						name: 'height',
						type: 'number',
						typeOptions: { minValue: 200, maxValue: 4320 },
						default: 720,
						description: 'Leave this out to use the height of the template',
						displayOptions: { show: { '/operation': ['makeImage'] } },
					},
					{
						displayName: 'Output Field',
						name: 'binaryPropertyName',
						type: 'string',
						default: 'data',
						description: 'The name of the binary field that holds your file',
					},
					{
						displayName: 'Quality',
						name: 'quality',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 100 },
						default: 80,
						description: 'For JPEG and WebP. A higher number gives a sharper, bigger file.',
						displayOptions: { show: { '/operation': ['makeImage'] } },
					},
					{
						displayName: 'Reference',
						name: 'reference',
						type: 'string',
						default: '',
						placeholder: 'e.g. INV-1042',
						description: 'Your own note, such as an order number. You see it in your history.',
					},
					{
						displayName: 'Retry Key',
						name: 'retryKey',
						type: 'string',
						default: '',
						placeholder: 'e.g. invoice-INV-1042-v1',
						description:
							'Leave this empty and we make one for you. If you set it, use a new key for each file you want. The same key never pays twice.',
					},
					{
						displayName: 'See-Through Background',
						name: 'transparent',
						type: 'boolean',
						default: false,
						description: 'Whether to keep the background clear. Works with PNG and WebP.',
						displayOptions: { show: { '/operation': ['makeImage'] } },
					},
					{
						displayName: 'Template Version',
						name: 'version',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 1,
						description: 'Leave this out to use the newest saved version',
					},
					{
						displayName: 'Wait Up To (Seconds)',
						name: 'waitSeconds',
						type: 'number',
						typeOptions: { minValue: 10, maxValue: 900 },
						default: 120,
						description: 'How long to wait for your file before this step stops',
					},
					{
						displayName: 'Width (Pixels)',
						name: 'width',
						type: 'number',
						typeOptions: { minValue: 320, maxValue: 7680 },
						default: 1280,
						description: 'Leave this out to use the width of the template',
						displayOptions: { show: { '/operation': ['makeImage'] } },
					},
				],
			},
		],
	};

	methods = {
		listSearch: { searchTemplates },
		resourceMapping: { getTemplateFields },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const results: INodeExecutionData[] = [];
		const templates: TemplateCache = new Map();

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const kind: FileKind = operation === 'makeImage' ? 'image' : 'pdf';
				results.push(await makeFile.call(this, kind, itemIndex, templates));
			} catch (error) {
				if (this.continueOnFail()) {
					results.push({
						json: {
							error: error.message,
							code: error.context?.code ?? null,
							description: error.description ?? null,
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw asNodeError(this.getNode(), error, itemIndex);
			}
		}

		return [results];
	}
}
