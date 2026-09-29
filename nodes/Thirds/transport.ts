import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export const BASE_URL = 'https://thirds.ai';

export type ApiResponse = {
	statusCode: number;
	headers: Record<string, string | string[] | undefined>;
	body: IDataObject;
};

type ApiError = {
	code?: string;
	message?: string;
	request_id?: string;
	details?: Array<{ field?: string; reason?: string }>;
	retry?: { retry_after_seconds?: number };
};

// Short, plain messages for the codes a template call can meet. The API code
// stays in the error description, so a workflow can still branch on it.
const MESSAGES: Record<string, string> = {
	unauthorized: "Your thirds.ai API key doesn't work. Check it, or make a new one.",
	account_suspended: 'Your thirds.ai account is paused. Contact support@thirds.ai.',
	not_found: "We couldn't find that in your thirds.ai account.",
	template_not_found: "We couldn't find that template in your thirds.ai account.",
	template_version_changed: 'The template changed while you were making this file. Try again.',
	template_data_invalid: "Your data doesn't fit this template. Check the fields listed below.",
	template_missing_data: 'The template needs a value that your data is missing.',
	template_data_limit: 'Your data is too big. Send less data.',
	template_data_depth_limit: 'Your data has too many levels inside each other.',
	template_data_collection_limit: 'Your data has too many items. Split it into smaller files.',
	template_invalid_filter_input: "A value in your data isn't in the format the template expects.",
	template_evaluation_error: "The template couldn't use your data. Check the values.",
	brand_data_conflict: 'Remove the "brand" field from your data. Your brand kit fills it in.',
	invalid_request: "We couldn't read this request. Check the fields listed below.",
	idempotency_conflict:
		'This retry key was already used for different data. Use a new key for a new file.',
	insufficient_credits: "You're out of credits. Add credits on the thirds.ai pricing page.",
	overage_limit_reached: "You've reached this month's overage limit. Buy a credit pack.",
	spend_cap_reached: 'This API key reached its monthly spending cap.',
	overage_unavailable: 'Overage is paused right now. Buy a credit pack or try again later.',
	rate_limited: 'Too many requests at once. Wait a moment and try again.',
	account_concurrency_limited: 'Your account is making too many files at once. Try again soon.',
	key_concurrency_limited: 'This API key is making too many files at once. Try again soon.',
	abuse_limited: 'Too many files failed today. Fix the cause, then try again tomorrow.',
	overloaded: "We're busy right now. Try again in a moment.",
	request_too_large: 'This request is too big. Send less data.',
	internal_error: 'Something went wrong on our side. Try again.',
};

// These codes clear on their own, so the same request with the same key is safe to send again.
export const RETRYABLE_CODES = new Set([
	'rate_limited',
	'account_concurrency_limited',
	'key_concurrency_limited',
	'overloaded',
]);

export function errorCode(response: ApiResponse): string {
	const error = response.body?.error as ApiError | undefined;
	return error?.code ?? `http_${response.statusCode}`;
}

export function retryAfterSeconds(response: ApiResponse): number | undefined {
	const error = response.body?.error as ApiError | undefined;
	const fromBody = error?.retry?.retry_after_seconds;
	if (typeof fromBody === 'number') return fromBody;
	const header = Number(response.headers['retry-after']);
	return Number.isFinite(header) && header > 0 ? header : undefined;
}

export function toApiError(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	response: ApiResponse,
	itemIndex?: number,
): NodeApiError {
	const error = (response.body?.error ?? {}) as ApiError;
	const code = errorCode(response);
	const lines = [`Code: ${code}`];
	for (const detail of error.details ?? []) {
		lines.push(`${detail.field || 'request'}: ${detail.reason ?? ''}`.trim());
	}
	if (error.request_id) lines.push(`Request ID: ${error.request_id}`);
	const apiError = new NodeApiError(this.getNode(), response.body as JsonObject, {
		message:
			MESSAGES[code] ?? error.message ?? `The request failed with HTTP ${response.statusCode}.`,
		description: lines.join('\n'),
		httpCode: String(response.statusCode),
		itemIndex,
	});
	apiError.context.code = code;
	return apiError;
}

export async function apiRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	method: IHttpRequestMethods,
	path: string,
	options: { body?: IDataObject; qs?: IDataObject; headers?: IDataObject } = {},
): Promise<ApiResponse> {
	const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'thirdsApi', {
		method,
		url: `${BASE_URL}${path}`,
		qs: options.qs,
		body: options.body,
		headers: { Accept: 'application/json', ...options.headers },
		json: true,
		arrayFormat: 'repeat',
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as ApiResponse;
	if (typeof response.body !== 'object' || response.body === null) {
		response.body = {};
	}
	return response;
}

/** Sends a read and throws a clear error when it fails. */
export async function apiGet(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	path: string,
	qs?: IDataObject,
	itemIndex?: number,
): Promise<IDataObject> {
	const response = await apiRequest.call(this, 'GET', path, { qs });
	if (response.statusCode >= 400) throw toApiError.call(this, response, itemIndex);
	return response.body;
}
