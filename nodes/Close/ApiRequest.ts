import type {
  IDataObject,
  IExecuteFunctions,
  IHttpRequestMethods,
  INodeProperties,
} from "n8n-workflow";
import { closeApiRequest } from "./GenericFunctions";
import { parseObject } from "./CustomFieldUpdates";
const show = { resource: ["apiRequest"] };
export const apiRequestProperties: INodeProperties[] = [
  {
    displayName: "Operation",
    name: "operation",
    type: "options",
    noDataExpression: true,
    default: "request",
    options: [
      { name: "Request", value: "request", action: 'Send a close api request' },
    ],
    displayOptions: { show },
  },
  {
    displayName: "Method",
    name: "requestMethod",
    type: "options",
    default: "GET",
    options: ["DELETE", "GET", "POST", "PUT"].map((value) => ({
      name: value,
      value,
    })),
    displayOptions: { show },
  },
  {
    displayName: "Endpoint",
    name: "requestEndpoint",
    type: "string",
    default: "/lead/",
    required: true,
    displayOptions: { show },
    description:
      "Close API path or full https://api.close.com/api/v1/ URL. Other hosts are rejected.",
  },
  {
    displayName: "Query Parameters (JSON)",
    name: "requestQuery",
    type: "json",
    default: "{}",
    displayOptions: { show },
  },
  {
    displayName: "Body (JSON)",
    name: "requestBody",
    type: "json",
    default: "{}",
    displayOptions: {
      show: { resource: ["apiRequest"], requestMethod: ["POST", "PUT"] },
    },
  },
  {
    displayName: "Timeout",
    name: "requestTimeout",
    type: "number",
    default: 300000,
    noDataExpression: true,
    typeOptions: { minValue: 1 },
    description: "Time in milliseconds to wait for the response",
  },
];
export function closeEndpoint(value: string): string {
  if (!value || value.startsWith("//") || /[\\\r\n]/.test(value))
    throw new Error("Invalid Close API endpoint");
  const url = new URL(
    value.startsWith("/") ? "https://api.close.com/api/v1" + value : value,
  );
  if (
    url.origin !== "https://api.close.com" ||
    !url.pathname.startsWith("/api/v1/") ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Endpoint must stay within the Close API");
  return url.pathname.slice("/api/v1".length) + url.search;
}
export async function executeApiRequest(
  this: IExecuteFunctions,
  index: number,
): Promise<IDataObject> {
  const method = this.getNodeParameter(
    "requestMethod",
    index,
    "GET",
  ) as IHttpRequestMethods;
  if (!["GET", "POST", "PUT", "DELETE"].includes(method))
    throw new Error("Unsupported Close request method");
  const endpoint = closeEndpoint(
    this.getNodeParameter("requestEndpoint", index) as string,
  );
  const body = ["POST", "PUT"].includes(method)
    ? parseObject(this.getNodeParameter("requestBody", index, {}))
    : {};
  const query = parseObject(this.getNodeParameter("requestQuery", index, {}));
  return (
    (await closeApiRequest.call(this, method, endpoint, body, query, {
      timeout: this.getNodeParameter("requestTimeout", index, 300000) as number,
    })) || {}
  );
}
