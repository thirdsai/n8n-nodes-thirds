import { createHash } from 'crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	ResourceMapperValue,
} from 'n8n-workflow';
import { NodeOperationError, sleep } from 'n8n-workflow';
import {
	BASE_URL,
	RETRYABLE_CODES,
	apiGet,
	apiRequest,
	errorCode,
	retryAfterSeconds,
	toApiError,
	type ApiResponse,
} from './transport';

export type FileKind = 'pdf' | 'image';

type Job = {
	id: string;
	status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
	template: { id: string; version: number } | null;
	artifact: { media_type: string; byte_size: number; sha256: string } | null;
	error: { category: string; code: string } | null;
	download: { url: string; expires_at: string } | null;
	[key: string]: unknown;
};

type TemplateFacts = { version: number; canvas?: { width: number; height: number } };

/** Facts about a template version, read once for each execution. */
export type TemplateCache = Map<string, Promise<TemplateFacts>>;

const TEMPLATE_ID = /^tpl_[0-9a-f]{32}$/;

const FAILURE_MESSAGES: Record<string, string> = {
	invalid_input: "The file couldn't be made from this template and data. Check the design.",
	unsafe_asset: 'The design uses a picture or font from an address we block.',
	resource_limit: 'The file is too big to make. Make the design or data smaller.',
	timeout: 'The file took too long to make. Make the design simpler.',
	renderer_failure: 'Something went wrong while making the file. Try again.',
	internal_failure: 'Something went wrong on our side. Try again.',
};

/** Reads the pixel size that the design's marked canvas declares, when it declares one. */
function canvasSize(source: string): TemplateFacts['canvas'] {
	const tag = /<div\b[^>]*\bdata-thirds\s*=\s*["']canvas["'][^>]*>/i.exec(source)?.[0];
	const style = tag && /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
	if (!style) return undefined;
	const css = style[1] ?? style[2];
	const read = (name: string) => {
		const match = new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*(\\d{3,4})px`, 'i').exec(css);
		return match ? Number(match[1]) : undefined;
	};
	const width = read('width');
	const height = read('height');
	if (!width || !height || width < 320 || width > 7680 || height < 200 || height > 4320) {
		return undefined;
	}
	return { width, height };
}

async function readTemplate(
	this: IExecuteFunctions,
	templateId: string,
	version: number,
	itemIndex: number,
): Promise<TemplateFacts> {
	const path = version
		? `/v1/templates/${templateId}/versions/${version}`
		: `/v1/templates/${templateId}`;
	const detail = await apiGet.call(this, path, undefined, itemIndex);
	return {
		version: (version || detail.latest_version) as number,
		canvas: canvasSize(String(detail.source ?? '')),
	};
}

function readData(this: IExecuteFunctions, itemIndex: number): IDataObject {
	const mode = this.getNodeParameter('dataMode', itemIndex) as string;
	if (mode === 'json') {
		let data = this.getNodeParameter('dataJson', itemIndex) as unknown;
		if (typeof data === 'string') {
			try {
				data = JSON.parse(data);
			} catch {
				throw new NodeOperationError(this.getNode(), "Your data isn't valid JSON.", {
					itemIndex,
				});
			}
		}
		if (typeof data !== 'object' || data === null || Array.isArray(data)) {
			throw new NodeOperationError(this.getNode(), 'Your data must be one JSON object.', {
				itemIndex,
				description: 'Wrap your values in { }, like {"client_name": "Harbor Street Bakery"}.',
			});
		}
		return data as IDataObject;
	}
	const mapped = this.getNodeParameter('fields', itemIndex) as ResourceMapperValue;
	const data: IDataObject = {};
	const types = new Map((mapped.schema ?? []).map((field) => [field.id, field.type]));
	for (const [key, value] of Object.entries(mapped.value ?? {})) {
		if (value === null || value === undefined) continue;
		const type = types.get(key);
		if ((type === 'array' || type === 'object') && typeof value === 'string') {
			try {
				data[key] = JSON.parse(value);
			} catch {
				throw new NodeOperationError(this.getNode(), `The "${key}" field needs valid JSON.`, {
					itemIndex,
				});
			}
		} else {
			data[key] = value;
		}
	}
	return data;
}

function retryKey(this: IExecuteFunctions, itemIndex: number, body: IDataObject): string {
	// n8n sends the same execution ID when it retries a step, so a retry of the same
	// item with the same inputs sends the same key and gets the same job back.
	const parts = [this.getExecutionId(), this.getNode().id, itemIndex, body];
	return `n8n-${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 48)}`;
}

async function createJob(
	this: IExecuteFunctions,
	kind: FileKind,
	body: IDataObject,
	key: string,
	deadline: number,
	itemIndex: number,
): Promise<{ job: Job; replayed: boolean }> {
	for (;;) {
		const response: ApiResponse = await apiRequest.call(this, 'POST', `/v1/${kind}`, {
			body,
			headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
		});
		if (response.statusCode === 200 || response.statusCode === 202) {
			return {
				job: response.body as unknown as Job,
				replayed: response.headers['idempotency-replayed'] === 'true',
			};
		}
		const waitMs = (retryAfterSeconds(response) ?? 2) * 1000;
		if (!RETRYABLE_CODES.has(errorCode(response)) || Date.now() + waitMs > deadline) {
			throw toApiError.call(this, response, itemIndex);
		}
		await sleep(waitMs);
	}
}

async function waitForJob(
	this: IExecuteFunctions,
	kind: FileKind,
	first: Job,
	deadline: number,
	itemIndex: number,
): Promise<Job> {
	let job = first;
	while (job.status === 'queued' || job.status === 'running') {
		if (Date.now() >= deadline) {
			throw new NodeOperationError(this.getNode(), "Your file isn't ready yet.", {
				itemIndex,
				description: `Job ${job.id} is still ${job.status}. Retry this step to pick up the same file without paying twice, or raise "Wait Up To (Seconds)".`,
			});
		}
		await sleep(1000);
		job = (await apiGet.call(this, `/v1/${kind}/${job.id}`, undefined, itemIndex)) as Job;
	}
	if (job.status !== 'succeeded') {
		const category = job.error?.category ?? 'cancelled';
		const failure = new NodeOperationError(
			this.getNode(),
			FAILURE_MESSAGES[category] ?? 'This file was cancelled before it was made.',
			{
				itemIndex,
				description: `Code: ${job.error?.code ?? job.status}\nCategory: ${category}\nJob ID: ${job.id}\nA failed file costs nothing.`,
			},
		);
		failure.context.code = job.error?.code ?? job.status;
		throw failure;
	}
	return job;
}

async function download(
	this: IExecuteFunctions,
	job: Job,
	itemIndex: number,
): Promise<{ bytes: Buffer; fileName?: string }> {
	if (!job.download || !job.artifact) {
		throw new NodeOperationError(this.getNode(), 'This file is no longer available.', {
			itemIndex,
			description: `Job ${job.id} has no file to download. Make a new one.`,
		});
	}
	const url = new URL(job.download.url, BASE_URL);
	if (url.origin !== BASE_URL) {
		throw new NodeOperationError(this.getNode(), 'The download link points somewhere else.', {
			itemIndex,
		});
	}
	// The signed link carries its own access, so this request sends no API key.
	const response = (await this.helpers.httpRequest({
		url: url.toString(),
		encoding: 'arraybuffer',
		returnFullResponse: true,
	})) as { body: ArrayBuffer | Buffer; headers: Record<string, string | undefined> };
	const bytes = Buffer.from(response.body as ArrayBuffer);
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	if (bytes.length !== job.artifact.byte_size || sha256 !== job.artifact.sha256) {
		throw new NodeOperationError(this.getNode(), "The file didn't download in full. Try again.", {
			itemIndex,
		});
	}
	const disposition = response.headers['content-disposition'] ?? '';
	const fileName = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
	return { bytes, fileName };
}

export async function makeFile(
	this: IExecuteFunctions,
	kind: FileKind,
	itemIndex: number,
	templates: TemplateCache,
): Promise<INodeExecutionData> {
	const templateId = this.getNodeParameter('template', itemIndex, '', {
		extractValue: true,
	}) as string;
	if (!TEMPLATE_ID.test(templateId)) {
		throw new NodeOperationError(this.getNode(), 'Choose a template.', {
			itemIndex,
			description: 'A template ID looks like tpl_ and 32 letters and numbers.',
		});
	}
	const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
	const started = Date.now();
	const deadline = started + ((options.waitSeconds as number) || 120) * 1000;

	// Send an exact version, so a retry still matches after someone saves a new one.
	const cacheKey = `${templateId}@${(options.version as number) || 'latest'}`;
	if (!templates.has(cacheKey)) {
		templates.set(
			cacheKey,
			readTemplate.call(this, templateId, (options.version as number) || 0, itemIndex),
		);
	}
	const facts = await templates.get(cacheKey)!;

	const body: IDataObject = {
		template_id: templateId,
		version: facts.version,
		data: readData.call(this, itemIndex),
	};
	if (options.fileName) body.filename = options.fileName;
	if (options.reference) body.reference = options.reference;
	if (options.brandKitId) body.brand_kit_id = options.brandKitId;
	if (kind === 'image') {
		const format = this.getNodeParameter('imageFormat', itemIndex) as string;
		const image: IDataObject = {
			format,
			width: (options.width as number) || facts.canvas?.width || 1280,
			height: (options.height as number) || facts.canvas?.height || 720,
		};
		if (format !== 'png' && options.quality) image.quality = options.quality;
		if (format !== 'jpeg' && options.transparent) image.transparent = true;
		body.image = image;
	}
	const key = (options.retryKey as string) || retryKey.call(this, itemIndex, body);

	const created = await createJob.call(
		this,
		kind,
		{ ...body, wait: true },
		key,
		deadline,
		itemIndex,
	);
	const job = await waitForJob.call(this, kind, created.job, deadline, itemIndex);
	const file = await download.call(this, job, itemIndex);
	const extension = job.artifact!.media_type.split('/')[1].replace('jpeg', 'jpg');
	const binary = await this.helpers.prepareBinaryData(
		file.bytes,
		file.fileName ?? `${job.id}.${extension}`,
		job.artifact!.media_type,
	);

	// The signed download link is a secret for 15 minutes, so it stays out of the output.
	const json: IDataObject = { ...job, replayed: created.replayed, idempotencyKey: key };
	delete json.download;
	return {
		json,
		binary: { [(options.binaryPropertyName as string) || 'data']: binary },
		pairedItem: { item: itemIndex },
	};
}
