import {
	IExecuteFunctions,
	IHookFunctions,
	ILoadOptionsFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	IDataObject,
	NodeApiError,
	JsonObject,
	sleep,
} from 'n8n-workflow';

// ─── Helper: extract retry-after seconds from a NodeApiError ─────────────────
function getRetryAfterSeconds(error: unknown): number {
	// NodeApiError wraps the HTTP response; check httpCode and headers
	const err = error as NodeApiError & { cause?: { response?: { headers?: Record<string, string>; statusCode?: number } }; httpCode?: string };
	const statusCode =
		err?.cause?.response?.statusCode ?? (err?.httpCode ? parseInt(err.httpCode, 10) : 0);
	if (statusCode !== 429) return 0;
	const retryAfter = err?.cause?.response?.headers?.['retry-after'];
	if (retryAfter) {
		const secs = parseFloat(retryAfter);
		if (!isNaN(secs)) return Math.ceil(secs) + 1; // add 1s buffer
	}
	return 5; // default: wait 5 seconds if header missing
}

export async function closeApiRequest(
	this: IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body: IDataObject = {},
	qs: IDataObject = {},
 requestOptions: {timeout?: number} = {},
): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
	const nodeTimeout = 'getInputData' in this ? this.getNodeParameter('requestTimeout', 0, 300000) as number : undefined;
	const options: IHttpRequestOptions = {
		method,
		url: `https://api.close.com/api/v1${endpoint}`,
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		json: true,
		...(nodeTimeout ? { timeout: nodeTimeout } : {}),
		...requestOptions,
	};

	if (Object.keys(body).length > 0) {
		options.body = body;
	}

	if (Object.keys(qs).length > 0) {
		options.qs = qs;
	}

	const maxRetries = 5;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await this.helpers.httpRequestWithAuthentication.call(this, 'closeApi', options);
		} catch (error) {
			const waitSecs = getRetryAfterSeconds(error);
			if (waitSecs > 0 && attempt < maxRetries) {
				await sleep(waitSecs * 1000);
				continue;
			}
			throw new NodeApiError(this.getNode(), error as JsonObject);
		}
	}
}

export async function closeApiRequestAllItems(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body: IDataObject = {},
	qs: IDataObject = {},
): Promise<any[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
	const returnData: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
	let skip = 0;
	const pageSize = 100;

	while (true) {
		const response = await closeApiRequest.call(this, method, endpoint, body, {
			...qs,
			_skip: skip,
			_limit: pageSize,
		});

		const items = response.data || [];
		returnData.push(...items);

		if (!response.has_more) break;
		skip += pageSize;
	}

	return returnData;
}
