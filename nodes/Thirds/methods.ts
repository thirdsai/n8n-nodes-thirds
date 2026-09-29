import type {
	FieldType,
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	ResourceMapperField,
	ResourceMapperFields,
} from 'n8n-workflow';
import { apiGet } from './transport';

type TemplateSummary = { id: string; name: string; latest_version: number };

/** Lists the account's active templates, newest first, with the server's name search. */
export async function searchTemplates(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const qs: IDataObject = { status: 'active', limit: 100 };
	if (filter) qs.q = filter.slice(0, 120);
	if (paginationToken) qs.cursor = paginationToken;
	const page = await apiGet.call(this, '/v1/templates', qs);
	const items = (page.items ?? []) as TemplateSummary[];
	return {
		results: items.map((template) => ({
			name: template.name,
			value: template.id,
			url: `https://thirds.ai/studio/editor?template=${encodeURIComponent(template.id)}`,
		})),
		paginationToken: (page.next_cursor as string | null) ?? undefined,
	};
}

type JsonSchema = {
	type?: string | string[];
	enum?: unknown[];
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
};

function fieldType(schema: JsonSchema): FieldType {
	if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === 'string')) {
		return 'options';
	}
	const types = Array.isArray(schema.type) ? schema.type : [schema.type];
	if (types.includes('array')) return 'array';
	if (types.includes('object')) return 'object';
	if (types.includes('boolean')) return 'boolean';
	if (types.includes('number') || types.includes('integer')) return 'number';
	return 'string';
}

/** Builds one form field for each top-level property in the template's saved data schema. */
export async function getTemplateFields(
	this: ILoadOptionsFunctions,
): Promise<ResourceMapperFields> {
	const templateId = this.getNodeParameter('template', undefined, {
		extractValue: true,
	}) as string;
	if (!templateId) return { fields: [] };
	const version = this.getNodeParameter('options.version', 0) as number;
	const qs: IDataObject = { template_id: [templateId], form: 'saved' };
	if (version) qs.version = version;
	const set = await apiGet.call(this, '/v1/templates/schemas', qs);
	const item = ((set.items ?? []) as Array<{ schema: JsonSchema | null }>)[0];
	const schema = item?.schema;
	if (!schema || typeof schema !== 'object' || !schema.properties) return { fields: [] };
	const required = new Set(schema.required ?? []);
	const fields: ResourceMapperField[] = Object.entries(schema.properties).map(([id, property]) => {
		const type = fieldType(property);
		return {
			id,
			displayName: id,
			required: required.has(id),
			defaultMatch: false,
			display: true,
			type,
			options:
				type === 'options'
					? (property.enum as string[]).map((value) => ({ name: value, value }))
					: undefined,
		};
	});
	return { fields };
}
