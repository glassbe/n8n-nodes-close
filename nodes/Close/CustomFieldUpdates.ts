import type { IDataObject, IExecuteFunctions } from "n8n-workflow";
import { closeApiRequest } from "./GenericFunctions";
import { validateFieldValue, type FieldDefinition } from "./RecordUpsert";

export function parseObject(value: unknown): IDataObject {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Custom field values must be a JSON object");
  return parsed as IDataObject;
}
export interface MultiFieldEdit {
  field: string;
  action: "set" | "add" | "remove";
  valueInput?: "list" | "json";
  values?: unknown;
  choiceValues?: unknown;
}
const keyFor = (field: string) => {
  const id = field.replace(/^custom\./, "");
  if (!/^cf_[A-Za-z0-9]+$/.test(id))
    throw new Error(`Invalid custom field ID: ${field}`);
  return `custom.${id}`;
};

/** Builds only a field patch; callers retain control of when to write it. */
export function buildCustomFieldPatch(
  body: IDataObject,
  dynamic: IDataObject,
  edits: MultiFieldEdit[],
  definitions: FieldDefinition[],
  current: IDataObject,
): IDataObject {
  const patch: IDataObject = {};
  const claimed = new Set(
    Object.keys(body).filter((k) => k.startsWith("custom.")),
  );
  const claim = (field: string) => {
    const key = keyFor(field);
    if (claimed.has(key))
      throw new Error(
        `Custom field ${field} is supplied more than once; use one input per field`,
      );
    claimed.add(key);
    const definition = definitions.find((f) => `custom.${f.id}` === key);
    if (!definition) throw new Error(`Unknown custom field: ${field}`);
    return { key, definition };
  };
  for (const [field, value] of Object.entries(dynamic)) {
    const { key, definition } = claim(field);
    if (value === undefined) continue;
    if (value !== null) validateFieldValue(definition, value);
    patch[key] = value; // Explicit null clears; zero, false, empty strings and arrays retain their meaning.
  }
  for (const edit of edits) {
    const { key, definition } = claim(edit.field);
    if (!definition.accepts_multiple_values)
      throw new Error(`${definition.name} is not a multi-value field`);
    const raw =
      edit.valueInput === "json"
        ? edit.values
        : (edit.choiceValues ?? edit.values);
    const values = typeof raw === "string" ? JSON.parse(raw) : raw;
    validateFieldValue(definition, values);
    if (!["set", "add", "remove"].includes(edit.action))
      throw new Error("Unknown multi-value action");
    const existing = current[key] ?? [];
    if (!Array.isArray(existing))
      throw new Error(`Expected an array in ${definition.name}`);
    const equal = (a: unknown, b: unknown) =>
      JSON.stringify(a) === JSON.stringify(b);
    const unique = (items: unknown[]) =>
      items.filter((v, i) => items.findIndex((x) => equal(v, x)) === i);
    patch[key] = (
      edit.action === "set"
        ? unique(values)
        : edit.action === "add"
          ? unique([...existing, ...values])
          : existing.filter((v) => !values.some((x: unknown) => equal(v, x)))
    ) as IDataObject[string];
  }
  return patch;
}

export async function applyCustomFieldUpdates(
  this: IExecuteFunctions,
  body: IDataObject,
  index: number,
  endpoint: string,
): Promise<void> {
  const dynamic = parseObject(
    this.getNodeParameter("customFieldValuesJson", index, {}),
  );
  const collection = this.getNodeParameter(
    "multiValueFieldEdits",
    index,
    {},
  ) as { edits?: MultiFieldEdit[] };
  const edits = collection.edits || [];
  if (!Object.keys(dynamic).length && !edits.length) return;
  const resource = this.getNodeParameter("resource", index) as string;
  let current: IDataObject = {};
  if (resource === "customActivity" || edits.some((e) => e.action !== "set"))
    current = await closeApiRequest.call(this, "GET", endpoint);
  const schemaType =
    resource === "customActivity"
      ? `activity/${encodeURIComponent(String(current.custom_activity_type_id || this.getNodeParameter("activityTypeId", index, "")))}`
      : resource;
  const schema = await closeApiRequest.call(
    this,
    "GET",
    `/custom_field_schema/${schemaType}/`,
  );
  if (!Array.isArray(schema.fields))
    throw new Error("Invalid Close custom field schema");
  const patch = buildCustomFieldPatch(
    body,
    dynamic,
    edits,
    schema.fields,
    current,
  );
  Object.assign(body, patch);
}
