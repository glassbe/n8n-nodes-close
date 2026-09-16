const { test } = require("node:test");
const assert = require("node:assert/strict");
const { upsertRecord } = require("../dist/nodes/Close/RecordUpsert");
function harness(
  pages = [],
  record = { id: "lead_1", name: "Old" },
  fields = [],
) {
  const calls = [];
  return {
    calls,
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (path.startsWith("/custom_field_schema/")) return { fields };
      if (path === "/data/search/" || path.includes("?_" ) || path.includes("?lead_id=")) {
        const page = pages.shift();
        if (page instanceof Error) throw page;
        return page || { data: [] };
      }
      if (method === "GET") return record;
      return { id: record.id, ...body };
    },
  };
}
const input = (overrides = {}) => ({
  resource: "lead",
  matchKeys: [{ field: "name", value: "Old" }],
  values: { name: "New" },
  updateMode: "replace",
  preview: true,
  ...overrides,
});
const writes = (h) =>
  h.calls.filter(
    (c) => ["POST", "PUT"].includes(c.method) && c.path !== "/data/search/",
  );
test("ordered fallback skips empty values and stops at the first exact match", async () => {
  const h = harness([
    { data: [] },
    {
      data: [
        { id: "lead_1", name: "Old" },
        { id: "lead_2", name: "Old company" },
      ],
    },
  ]);
  const r = await upsertRecord(
    h.request,
    input({
      matchKeys: [
        { field: "name", value: "" },
        { field: "description", value: "missing" },
        { field: "name", value: "Old" },
        { field: "id", value: "never" },
      ],
    }),
  );
  assert.equal(r.id, "lead_1");
  assert.equal(r.matchedBy, "name");
  assert.deepEqual(
    r.matchTrace.map((x) => x.result),
    ["empty", "not_found", "matched"],
  );
  assert.equal(writes(h).length, 0);
});
test("ambiguous matches stop without falling back or writing", async () => {
  const h = harness([
    {
      data: [
        { id: "lead_1", name: "Old" },
        { id: "lead_2", name: "Old" },
      ],
    },
  ]);
  await assert.rejects(
    upsertRecord(
      h.request,
      input({
        preview: false,
        matchKeys: [
          { field: "name", value: "Old" },
          { field: "id", value: "lead_1" },
        ],
      }),
    ),
    /Multiple records/,
  );
  assert.equal(h.calls.length, 1);
  assert.equal(writes(h).length, 0);
});
test("custom numeric key converts strings, preserves zero and uses the Close number condition", async () => {
  const h = harness(
    [{ data: [{ id: "lead_1", "custom.cf_num": 0 }] }],
    undefined,
    [{ id: "cf_num", name: "Number", type: "number" }],
  );
  const r = await upsertRecord(
    h.request,
    input({ matchKeys: [{ field: "custom.cf_num", value: "0" }] }),
  );
  assert.equal(r.id, "lead_1");
  assert.deepEqual(
    h.calls.find((c) => c.path === "/data/search/").body.query.queries[1]
      .condition,
    { type: "number", value: 0 },
  );
});
test("creates with a custom identity and rejects conflicting supplied values", async () => {
  const fields = [{ id: "cf_key", name: "External ID", type: "text" }];
  const h = harness([], undefined, fields);
  const args = input({
    matchKeys: [{ field: "custom.cf_key", value: "external-1" }],
    preview: false,
  });
  const r = await upsertRecord(h.request, args);
  assert.equal(r.action, "created");
  assert.equal(writes(h)[0].body["custom.cf_key"], "external-1");
  const h2 = harness([], undefined, fields);
  await assert.rejects(
    upsertRecord(h2.request, {
      ...args,
      values: { name: "New", "custom.cf_key": "other" },
    }),
    /conflicts/,
  );
  assert.equal(writes(h2).length, 0);
});
test("related contact matches resolve to a unique lead, including multiple contacts on that lead", async () => {
  const h = harness([
    {
      data: [
        {
          id: "cont_1",
          lead_id: "lead_1",
          emails: [{ email: "A@EXAMPLE.INVALID" }],
        },
        {
          id: "cont_2",
          lead_id: "lead_1",
          emails: [{ email: "a@example.invalid" }],
        },
      ],
    },
  ]);
  const r = await upsertRecord(
    h.request,
    input({
      matchKeys: [{ field: "contact.email", value: " a@example.invalid " }],
    }),
  );
  assert.equal(r.id, "lead_1");
});
test("pagination includes later matches and rejects repeated cursors", async () => {
  const h = harness([
    { data: [], cursor: "page2" },
    { data: [{ id: "lead_1", name: "Old" }] },
  ]);
  assert.equal((await upsertRecord(h.request, input())).id, "lead_1");
  assert.equal(h.calls[1].body.cursor, "page2");
  const h2 = harness([
    { data: [], cursor: "same" },
    { data: [], cursor: "same" },
  ]);
  await assert.rejects(upsertRecord(h2.request, input()), /Repeated/);
});
test("empty identity and API failures never create records", async () => {
  const h = harness();
  await assert.rejects(
    upsertRecord(
      h.request,
      input({ matchKeys: [{ field: "name", value: "" }], preview: false }),
    ),
    /All match keys/,
  );
  assert.equal(writes(h).length, 0);
  const h2 = harness([new Error("Rate limit")]);
  await assert.rejects(
    upsertRecord(h2.request, input({ preview: false })),
    /Rate limit/,
  );
  assert.equal(writes(h2).length, 0);
});
test("fill-empty preserves zero; replace updates only supplied values", async () => {
  const fields = [{ id: "cf_num", name: "Number", type: "number" }];
  const h = harness(
    [{ data: [{ id: "lead_1", name: "Old" }] }],
    { id: "lead_1", name: "Old", "custom.cf_num": 0 },
    fields,
  );
  const r = await upsertRecord(
    h.request,
    input({
      values: { "custom.cf_num": 9 },
      updateMode: "fillEmpty",
      preview: false,
    }),
  );
  assert.equal(r.action, "unchanged");
  assert.equal(writes(h).length, 0);
  const h2 = harness([{ data: [{ id: "lead_1", name: "Old" }] }]);
  await upsertRecord(h2.request, input({ preview: false }));
  assert.deepEqual(writes(h2)[0], {
    method: "PUT",
    path: "/lead/lead_1/",
    body: { name: "New" },
  });
});
test("contact and opportunity matches are scoped and scope is rechecked after load", async () => {
  const args = input({
    resource: "opportunity",
    leadId: "lead_1",
    pipelineId: "pipe_1",
    matchKeys: [{ field: "value", value: "0" }],
    values: { note: "Updated" },
  });
  const h = harness([{ data: [{ id: "oppo_1", value: 0, lead_id: "lead_1", pipeline_id: "pipe_1" }] }], {
    id: "oppo_1",
    lead_id: "lead_1",
    pipeline_id: "pipe_1",
  });
  assert.equal((await upsertRecord(h.request, args)).id, "oppo_1");
  assert.equal(h.calls[0].path, "/opportunity/?lead_id=lead_1&_limit=100&_skip=0");
  const h2 = harness([{ data: [{ id: "oppo_1", value: 0, lead_id: "lead_1", pipeline_id: "pipe_1" }] }], {
    id: "oppo_1",
    lead_id: "lead_2",
    pipeline_id: "pipe_1",
  });
  await assert.rejects(upsertRecord(h2.request, args), /outside/);
  await assert.rejects(
    upsertRecord(h.request, input({ resource: "contact" })),
    /Lead ID required/,
  );
});
test("node execution wires fields, defaults to preview and preserves item pairing", async () => {
  const generic = require("../dist/nodes/Close/GenericFunctions");
  const original = generic.closeApiRequest;
  const h = harness([{ data: [{ id: "lead_1", name: "Old" }] }]);
  generic.closeApiRequest = h.request;
  try {
    const { Close } = require("../dist/nodes/Close/Close.node");
    const node = new Close();
    const params = {
      resource: "lead",
      operation: "upsertByFields",
      upsertMatchKeys: { keys: [{ field: "name", value: "Old" }] },
      upsertValues: { value: { name: "New" } },
    };
    const result = await node.execute.call({
      getInputData: () => [{ json: {} }],
      getNodeParameter: (name, i, fallback) => params[name] ?? fallback,
      continueOnFail: () => false,
      getNode: () => ({ name: "Close" }),
    });
    assert.equal(result[0][0].json.preview, true);
    assert.deepEqual(result[0][0].pairedItem, { item: 0 });
    assert.equal(writes(h).length, 0);
    const oppOperations = node.description.properties.find(
      (p) =>
        p.name === "operation" &&
        p.displayOptions?.show?.resource?.includes("opportunity"),
    );
    assert.ok(oppOperations.options.some((o) => o.value === "upsert"));
    assert.ok(oppOperations.options.some((o) => o.value === "upsertByFields"));
  } finally {
    generic.closeApiRequest = original;
  }
});
test("first-match policy updates only the first exact match", async () => {
  const h = harness([
    {
      data: [
        { id: "lead_1", name: "Old" },
        { id: "lead_2", name: "Old" },
      ],
    },
  ]);
  const r = await upsertRecord(
    h.request,
    input({ preview: false, multipleMatches: "first" }),
  );
  assert.equal(r.id, "lead_1");
  assert.equal(writes(h).length, 1);
  assert.equal(writes(h)[0].path, "/lead/lead_1/");
});
test("return-all policy emits full records without writes and retains input pairing", async () => {
  const generic = require("../dist/nodes/Close/GenericFunctions");
  const original = generic.closeApiRequest;
  const calls = [];
  generic.closeApiRequest = async (method, path) => {
    calls.push({ method, path });
    return path === "/data/search/"
      ? {
          data: [
            { id: "lead_1", name: "Old" },
            { id: "lead_2", name: "Old" },
          ],
        }
      : { id: path.split("/")[2], name: "Old", description: "Full record" };
  };
  try {
    const { Close } = require("../dist/nodes/Close/Close.node");
    const params = {
      resource: "lead",
      operation: "upsertByFields",
      upsertMatchKeys: { keys: [{ field: "name", value: "Old" }] },
      upsertMultipleMatches: "returnAll",
      upsertPreview: false,
    };
    const [results] = await new Close().execute.call({
      getInputData: () => [{ json: {} }],
      getNodeParameter: (key, i, fallback) => params[key] ?? fallback,
      continueOnFail: () => false,
      getNode: () => ({ name: "Close" }),
    });
    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map((r) => r.json.id),
      ["lead_1", "lead_2"],
    );
    assert.ok(
      results.every(
        (r) =>
          r.json.action === "multiple_matches" &&
          r.json.record.description === "Full record" &&
          r.pairedItem.item === 0,
      ),
    );
    assert.equal(
      calls.filter((c) => c.method !== "GET" && c.path !== "/data/search/")
        .length,
      0,
    );
  } finally {
    generic.closeApiRequest = original;
  }
});

 test("IDs use Close ID queries and lead names use display_name candidates", async () => {
 const h = harness([{data:[{id:"lead_1"}]}]);
 await upsertRecord(h.request,input({matchKeys:[{field:"id",value:"lead_1"}]}));
 assert.deepEqual(h.calls[0].body.query.queries[1],{type:"id",value:"lead_1"});
 const names = harness([{data:[{id:"lead_1",name:"Old"}]}]); await upsertRecord(names.request,input());
 assert.equal(names.calls[0].body.query.queries[1].field.field_name,"display_name");
 });
