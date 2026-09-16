import type { IDataObject } from "n8n-workflow";

export type UpsertResource = "lead" | "contact" | "opportunity";
export type Request = (
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: IDataObject,
) => Promise<IDataObject>;
export interface MatchKey {
  field: string;
  value: unknown;
}
export interface UpsertInput {
  resource: UpsertResource;
  matchKeys: MatchKey[];
  values: IDataObject;
  leadId?: string;
  pipelineId?: string;
  updateMode: "replace" | "fillEmpty";
  preview: boolean;
  multipleMatches?: "error" | "first" | "returnAll";
}
export interface FieldDefinition extends IDataObject {
  id: string;
  name: string;
  type: string;
  accepts_multiple_values?: boolean;
}
const empty = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);
const normalizedEmail = (value: unknown) => String(value).trim().toLowerCase();
function normalizedPhone(value: unknown): string {
  const number = String(value)
    .trim()
    .replace(/[\s().-]/g, "")
    .replace(/^00/, "+");
  if (!/^\+[1-9]\d{6,14}$/.test(number))
    throw new Error(
      "Phone match keys require an international number (e.g. +491701234567)",
    );
  return number;
}
export const standardFields: Record<UpsertResource, string[]> = {
  lead: ["name", "description", "url", "status_id"],
  contact: ["name", "title", "emails", "phones", "urls"],
  opportunity: [
    "status_id",
    "user_id",
    "value",
    "value_currency",
    "value_period",
    "confidence",
    "date_won",
    "note",
  ],
};

async function searchAll(
  request: Request,
  query: IDataObject,
  fields: IDataObject,
): Promise<IDataObject[]> {
  const result: IDataObject[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const response = await request("POST", "/data/search/", {
      query,
      _fields: fields,
      _limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(response.data))
      throw new Error("Invalid Close search response");
    result.push(...(response.data as IDataObject[]));
    if (!response.cursor) {
      if (response.has_more)
        throw new Error("Incomplete Close search response");
      return result;
    }
    cursor = String(response.cursor);
    if (cursors.has(cursor)) throw new Error("Repeated Close search cursor");
    cursors.add(cursor);
  }
  throw new Error(
    "Close search exceeded pagination limit; refusing an incomplete match",
  );
}

/** Contacts/opportunities are bounded to one lead; the search API does not return opportunities. */
async function scopedRecords(request: Request, resource: string, leadId: string): Promise<IDataObject[]> {
  const records: IDataObject[] = [];
  for (let page = 0; page < 1000; page++) {
    const response = await request("GET", `/${resource}/?lead_id=${encodeURIComponent(leadId)}&_limit=100&_skip=${page * 100}`);
    if (!Array.isArray(response.data)) throw new Error("Invalid Close list response");
    records.push(...response.data as IDataObject[]);
    if (!response.has_more) return records;
    if (!response.data.length) throw new Error("Incomplete Close list response");
  }
  throw new Error("Close list exceeded pagination limit");
}

function conditionFor(type: string, value: unknown): IDataObject {
  if (type === "number") return { type: "number", value: value as number };
  if (type === "text")
    return { type: "text", mode: "phrase", value: String(value) };
  return { type: "exists" }; // Other scalar/array types are compared exactly after fetching candidates.
}
export function validateFieldValue(field: FieldDefinition, value: unknown): void {
  if (field.accepts_multiple_values) {
    if (!Array.isArray(value))
      throw new Error(`${field.name} requires an array`);
    for (const entry of value)
      validateFieldValue({ ...field, accepts_multiple_values: false }, entry);
    return;
  }
  if (value === undefined || value === null || Array.isArray(value))
    throw new Error(`Invalid value for ${field.name}`);
  if (
    field.type === "number" &&
    (typeof value !== "number" || !Number.isFinite(value))
  )
    throw new Error(`${field.name} requires a finite number`);
  if (
    [
      "text",
      "textarea",
      "choices",
      "date",
      "datetime",
      "user",
      "contact",
    ].includes(field.type) &&
    typeof value !== "string"
  )
    throw new Error(`${field.name} requires a string`);
  if (
    field.type === "choices" &&
    !((field.choices as unknown[]) || []).includes(value)
  )
    throw new Error(`Invalid choice for ${field.name}`);
  if (field.type === "user" && !/^user_[A-Za-z0-9]+$/.test(String(value)))
    throw new Error(`Invalid user ID for ${field.name}`);
  if (
    field.type === "date" &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ||
      !Number.isFinite(Date.parse(String(value))) ||
      new Date(String(value)).toISOString().slice(0, 10) !== value)
  )
    throw new Error(`Invalid date for ${field.name}`);
  if (
    field.type === "datetime" &&
    (!/(Z|[+-]\d{2}:\d{2})$/.test(String(value)) ||
      !Number.isFinite(Date.parse(String(value))))
  )
    throw new Error(`Datetime requires a timezone: ${field.name}`);
}

/** Ordered exact matching, with no customer-specific fields or identity heuristics. */
export async function upsertRecord(
  request: Request,
  input: UpsertInput,
): Promise<IDataObject> {
  if (!["lead", "contact", "opportunity"].includes(input.resource))
    throw new Error("Unsupported upsert resource");
  if (
    input.resource !== "lead" &&
    !/^lead_[A-Za-z0-9]+$/.test(input.leadId || "")
  )
    throw new Error("Lead ID required for contact/opportunity scope");
  if (
    input.resource === "opportunity" &&
    !/^pipe_[A-Za-z0-9]+$/.test(input.pipelineId || "")
  )
    throw new Error("Pipeline ID required for opportunity scope");
  const schemas = new Map<string, FieldDefinition[]>();
  async function schema(resource: string) {
    if (!schemas.has(resource)) {
      const response = await request(
        "GET",
        `/custom_field_schema/${resource}/`,
      );
      if (!Array.isArray(response.fields))
        throw new Error("Invalid Close field schema");
      schemas.set(resource, response.fields as FieldDefinition[]);
    }
    return schemas.get(resource)!;
  }
  const trace: IDataObject[] = [];
  const effectiveKeys: MatchKey[] = [];
  let existing: IDataObject | undefined;
  let matchedKey: MatchKey | undefined;
  for (const key of input.matchKeys) {
    if (empty(key.value)) {
      trace.push({ field: key.field, result: "empty" });
      continue;
    }
    const related = key.field.startsWith("contact.");
    if (related && input.resource !== "lead")
      throw new Error(
        "Related contact match keys are only available for leads",
      );
    const target = related ? "contact" : input.resource;
    const fieldName = related ? key.field.slice("contact.".length) : key.field;
    let value = key.value;
    let predicate: IDataObject;
    let readField = fieldName;
    if (["email", "phone"].includes(fieldName)) {
      if (target !== "contact")
        throw new Error("Use contact.email/contact.phone when matching leads");
      value =
        fieldName === "email" ? normalizedEmail(value) : normalizedPhone(value);
      if (empty(value)) {
        trace.push({ field: key.field, result: "empty" });
        continue;
      }
      readField = fieldName === "email" ? "emails" : "phones";
      predicate = {
        type: "has_related",
        this_object_type: "contact",
        related_object_type: `contact_${fieldName}`,
        related_query: {
          type: "field_condition",
          field: {
            type: "regular_field",
            object_type: `contact_${fieldName}`,
            field_name: fieldName,
          },
          condition: { type: "text", mode: "phrase", value: String(value) },
        },
      };
    } else if (fieldName.startsWith("custom.")) {
      const field = (await schema(target)).find(
        (f) => `custom.${f.id}` === fieldName,
      );
      if (!field) throw new Error(`Unknown match field: ${key.field}`);
      if (
        field.type === "number" &&
        typeof value === "string" &&
        value.trim() !== ""
      )
        value = Number(value);
      validateFieldValue({ ...field, accepts_multiple_values: false }, value);
      predicate = {
        type: "field_condition",
        field: { type: "custom_field", custom_field_id: field.id },
        condition: conditionFor(field.type, value),
      };
    } else {
      if (!/^[a-z][a-z0-9_]*$/.test(fieldName))
        throw new Error("Invalid standard match field");
      if (
        ["value", "confidence"].includes(fieldName) &&
        typeof value === "string" &&
        value.trim() !== ""
      ) {
        value = Number(value);
        if (!Number.isFinite(value))
          throw new Error(`${fieldName} requires a finite number`);
      }
      // Only use documented indexed fields. Other fields are compared exactly
      // after fetching candidates rather than inventing unsupported API filters.
      const indexedName = target === "lead" && fieldName === "name" ? "display_name" : fieldName;
      if (fieldName === "id") {
        predicate = { type: "id", value: String(value) };
      } else if (target === "lead" && fieldName === "status_id") {
        predicate = { type: "field_condition", field: { type: "regular_field", object_type: target, field_name: fieldName }, condition: { type: "reference", reference_type: "lead_status", object_ids: [value] } };
      } else if (["description", "display_name", "title"].includes(indexedName)) {
        predicate = { type: "field_condition", field: { type: "regular_field", object_type: target, field_name: indexedName }, condition: conditionFor(typeof value === "number" ? "number" : "text", value) };
      } else {
        predicate = { type: "object_type", object_type: target };
      }
    }
    effectiveKeys.push({ field: key.field, value });
    const queries: IDataObject[] = [
      { type: "object_type", object_type: target },
      predicate,
    ];
    const fields = [
      ...new Set([
        "id",
        readField,
        ...(target === "contact" ? ["lead_id"] : []),
      ]),
    ];
    const candidates = input.resource === "lead"
      ? await searchAll(request, { type: "and", queries }, { [target]: fields })
      : (await scopedRecords(request, input.resource, input.leadId!)).filter(record =>
          record.lead_id === input.leadId && (input.resource !== "opportunity" || record.pipeline_id === input.pipelineId));
    const matches = candidates.filter((record) => {
      const candidate = record[readField];
      if (fieldName === "email")
        return ((candidate || []) as IDataObject[]).some(
          (e) => normalizedEmail(e.email) === value,
        );
      if (fieldName === "phone")
        return ((candidate || []) as IDataObject[]).some(
          (p) =>
            String(p.phone).replace(/\D/g, "") ===
            String(value).replace(/\D/g, ""),
        );
      return Array.isArray(candidate)
        ? candidate.some((v) => JSON.stringify(v) === JSON.stringify(value))
        : JSON.stringify(candidate) === JSON.stringify(value);
    });
    const ids = [
      ...new Set(matches.map((r) => String(related ? r.lead_id : r.id))),
    ];
    if (ids.length > 1 && (input.multipleMatches || "error") === "error") {
      throw new Error(
        `Multiple records match ${key.field}; choose how to handle multiple matches`,
      );
    }
    if (ids.length > 1 && input.multipleMatches === "returnAll") {
      trace.push({ field: key.field, result: "multiple_matches" });
      const records: IDataObject[] = [];
      for (const id of ids) {
        const record = await request(
          "GET",
          `/${input.resource}/${encodeURIComponent(id)}/`,
        );
        if (record.id !== id)
          throw new Error("Matched record could not be loaded");
        if (input.resource !== "lead" && record.lead_id !== input.leadId)
          throw new Error("Matched record moved outside the requested lead");
        if (
          input.resource === "opportunity" &&
          record.pipeline_id !== input.pipelineId
        )
          throw new Error(
            "Matched record moved outside the requested pipeline",
          );
        records.push(record);
      }
      return {
        action: "multiple_matches",
        matchedBy: key.field,
        matchTrace: trace,
        preview: input.preview,
        matchCount: records.length,
        records,
      };
    }
    trace.push({
      field: key.field,
      result: ids.length ? "matched" : "not_found",
    });
    if (ids.length) {
      existing = await request(
        "GET",
        `/${input.resource}/${encodeURIComponent(ids[0])}/`,
      );
      if (existing.id !== ids[0])
        throw new Error("Matched record could not be loaded");
      if (input.resource !== "lead" && existing.lead_id !== input.leadId)
        throw new Error("Matched record moved outside the requested lead");
      if (
        input.resource === "opportunity" &&
        existing.pipeline_id !== input.pipelineId
      )
        throw new Error("Matched record moved outside the requested pipeline");
      matchedKey = key;
      break;
    }
  }
  if (!effectiveKeys.length)
    throw new Error(
      "All match keys are empty; refusing to create a record without an identity",
    );
  const patch: IDataObject = {};
  for (const [field, value] of Object.entries(input.values)) {
    if (value === undefined || value === null || value === "") continue; // Same omission semantics as the existing node.
    if (field.startsWith("custom.")) {
      const definition = (await schema(input.resource)).find(
        (f) => `custom.${f.id}` === field,
      );
      if (!definition) throw new Error(`Unknown custom field: ${field}`);
      validateFieldValue(definition, value);
    } else if (!standardFields[input.resource].includes(field))
      throw new Error(`Unsupported write field: ${field}`);
    if (existing && input.updateMode === "fillEmpty" && !empty(existing[field]))
      continue;
    if (JSON.stringify(existing?.[field]) !== JSON.stringify(value))
      patch[field] = value;
  }
  if (!existing) {
    const contact: IDataObject = {};
    for (const key of effectiveKeys) {
      const related = key.field.startsWith("contact.");
      const fieldName = related
        ? key.field.slice("contact.".length)
        : key.field;
      const target = related ? contact : patch;
      const resource = related ? "contact" : input.resource;
      let value = key.value;
      if (fieldName === "email" || fieldName === "phone") {
        const collection = fieldName === "email" ? "emails" : "phones";
        const items = [...((target[collection] || []) as IDataObject[])];
        if (!items.some((item) => item[fieldName] === value))
          items.push({ [fieldName]: value as string, type: "office" });
        target[collection] = items;
        continue;
      }
      if (fieldName.startsWith("custom.")) {
        const definition = (await schema(resource)).find(
          (f) => `custom.${f.id}` === fieldName,
        )!;
        if (definition.accepts_multiple_values) value = [value];
      } else if (!standardFields[resource].includes(fieldName))
        throw new Error(
          `Cannot create using read-only match field ${key.field}; provide another identity`,
        );
      if (
        fieldName in target &&
        JSON.stringify(target[fieldName]) !== JSON.stringify(value)
      )
        throw new Error(`Create value conflicts with match key ${key.field}`);
      target[fieldName] = value as IDataObject[string];
    }
    if (input.resource === "lead") {
      if (!patch.name) throw new Error("Name is required when creating a lead");
      if (Object.keys(contact).length) patch.contacts = [contact];
    } else {
      patch.lead_id = input.leadId;
      if (input.resource === "opportunity") {
        patch.pipeline_id = input.pipelineId;
        if (!patch.status_id)
          throw new Error("Status is required when creating an opportunity");
      }
    }
  }
  const action = existing
    ? Object.keys(patch).length
      ? "updated"
      : "unchanged"
    : "created";
  const meta = {
    action,
    matchedBy: matchedKey?.field || null,
    matchTrace: trace,
  };
  if (input.preview)
    return { ...meta, id: existing?.id || null, preview: true, patch };
  const record =
    action === "unchanged"
      ? existing!
      : await request(
          existing ? "PUT" : "POST",
          existing
            ? `/${input.resource}/${existing.id}/`
            : `/${input.resource}/`,
          patch,
        );
  return { ...meta, id: record.id, preview: false, record };
}
