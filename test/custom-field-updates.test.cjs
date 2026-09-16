const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCustomFieldPatch,
  parseObject,
} = require("../dist/nodes/Close/CustomFieldUpdates");
const api = require("../dist/nodes/Close/GenericFunctions");
const { Close } = require("../dist/nodes/Close/Close.node");
const fields = [
  { id: "cf_count", name: "Count", type: "number" },
  { id: "cf_date", name: "Date", type: "date" },
  { id: "cf_text", name: "Text", type: "text" },
  {
    id: "cf_tags",
    name: "Tags",
    type: "choices",
    choices: ["A", "B", "C"],
    accepts_multiple_values: true,
  },
  { id: "cf_user", name: "Owner", type: "user" },
];
test("dynamic field patches retain zero, explicit null and empty text, accepting both ID forms", () => {
  assert.deepEqual(
    buildCustomFieldPatch(
      {},
      parseObject('{"cf_count":0,"custom.cf_date":null,"cf_text":""}'),
      [],
      fields,
      {},
    ),
    { "custom.cf_count": 0, "custom.cf_date": null, "custom.cf_text": "" },
  );
  for (const bad of ["[]", "null", '"foo"'])
    assert.throws(() => parseObject(bad));
  assert.throws(
    () => buildCustomFieldPatch({}, { cf_missing: 1 }, [], fields, {}),
    /Unknown/,
  );
  assert.throws(
    () =>
      buildCustomFieldPatch({}, { cf_count: "not a number" }, [], fields, {}),
    /finite number/,
  );
});
test("conflicting mapper, clear, JSON and repeated edit sources are rejected", () => {
  assert.throws(
    () =>
      buildCustomFieldPatch(
        { "custom.cf_count": 0 },
        { cf_count: 1 },
        [],
        fields,
        {},
      ),
    /more than once/,
  );
  assert.throws(
    () =>
      buildCustomFieldPatch(
        { "custom.cf_date": null },
        { cf_date: null },
        [],
        fields,
        {},
      ),
    /more than once/,
  );
  assert.throws(
    () =>
      buildCustomFieldPatch(
        {},
        { cf_count: 1, "custom.cf_count": 2 },
        [],
        fields,
        {},
      ),
    /more than once/,
  );
  assert.throws(
    () =>
      buildCustomFieldPatch(
        {},
        { cf_tags: ["A"] },
        [{ field: "cf_tags", action: "add", values: ["B"] }],
        fields,
        {},
      ),
    /more than once/,
  );
});
test("multi-value add preserves members, remove preserves others, replace supports empty arrays", () => {
  const current = { "custom.cf_tags": ["A", "B"] };
  const run = (action, values) =>
    buildCustomFieldPatch(
      {},
      {},
      [{ field: "cf_tags", action, values }],
      fields,
      current,
    )["custom.cf_tags"];
  assert.deepEqual(run("add", ["B", "C"]), ["A", "B", "C"]);
  assert.deepEqual(run("remove", ["A", "C"]), ["B"]);
  assert.deepEqual(run("set", []), []);
  assert.deepEqual(current["custom.cf_tags"], ["A", "B"]);
  assert.throws(() => run("add", ["unknown"]), /Invalid choice/);
  assert.throws(
    () =>
      buildCustomFieldPatch(
        {},
        {},
        [{ field: "cf_count", action: "add", values: [1] }],
        fields,
        {},
      ),
    /not a multi/,
  );
});
test("hidden list input cannot override selected JSON mode", () => {
  assert.deepEqual(
    buildCustomFieldPatch(
      {},
      {},
      [
        {
          field: "cf_tags",
          action: "set",
          valueInput: "json",
          choiceValues: ["A"],
          values: '["B"]',
        },
      ],
      fields,
      {},
    )["custom.cf_tags"],
    ["B"],
  );
});
test("all four update resources use the same dynamic patch, multi-value logic and item pairing", async () => {
  const original = api.closeApiRequest;
  const calls = [];
  api.closeApiRequest = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith("/custom_field_schema/")) return { fields };
    if (method === "GET")
      return { "custom.cf_tags": ["A"], custom_activity_type_id: "cat_actual" };
    return { id: "result" };
  };
  try {
    for (const resource of [
      "lead",
      "contact",
      "opportunity",
      "customActivity",
    ]) {
      calls.length = 0;
      const params = {
        resource,
        operation: "update",
        leadId: "lead_1",
        contactId: "cont_1",
        opportunityId: "oppo_1",
        customActivityId: "acti_1",
        additionalFields: {},
        customFieldValuesJson: { cf_count: 0, cf_date: null },
        multiValueFieldEdits: {
          edits: [{ field: "cf_tags", action: "add", choiceValues: ["B"] }],
        },
      };
      const [items] = await new Close().execute.call({
        getInputData: () => [{ json: {} }],
        getNodeParameter: (k, i, d) => params[k] ?? d,
        continueOnFail: () => false,
        getNode: () => ({ name: "Test" }),
      });
      assert.deepEqual(calls.at(-1).body, {
        "custom.cf_count": 0,
        "custom.cf_date": null,
        "custom.cf_tags": ["A", "B"],
      });
      assert.equal(calls.filter((c) => c.method === "PUT").length, 1);
      assert.equal(items[0].pairedItem.item, 0);
      if (resource === "customActivity")
        assert.ok(
          calls.some(
            (c) => c.path === "/custom_field_schema/activity/cat_actual/",
          ),
        );
    }
  } finally {
    api.closeApiRequest = original;
  }
});
test("invalid dynamic field prevents any update request", async () => {
  const original = api.closeApiRequest;
  const calls = [];
  api.closeApiRequest = async (method, path) => {
    calls.push(method);
    return { fields };
  };
  try {
    const params = {
      resource: "lead",
      operation: "update",
      leadId: "lead_1",
      additionalFields: {},
      customFieldValuesJson: { cf_missing: 7 },
    };
    await assert.rejects(
      new Close().execute.call({
        getInputData: () => [{ json: {} }],
        getNodeParameter: (k, i, d) => params[k] ?? d,
        continueOnFail: () => false,
        getNode: () => ({ name: "Test" }),
      }),
      /Unknown custom field/,
    );
    assert.ok(!calls.includes("PUT"));
  } finally {
    api.closeApiRequest = original;
  }
});
test("normal mapper exposes user options and correct array/date types", async () => {
  const original = api.closeApiRequest,
    all = api.closeApiRequestAllItems;
  api.closeApiRequest = async (method, path) => ({
    data: path.includes("shared") ? [] : fields,
  });
  api.closeApiRequestAllItems = async () => [
    { id: "user_1", first_name: "Test", last_name: "User" },
  ];
  try {
    const { fields: mapped } =
      await new Close().methods.resourceMapping.getLeadCustomFieldsForMapper.call(
        {},
      );
    assert.equal(mapped.find((f) => f.id === "cf_tags").type, "array");
    assert.equal(mapped.find((f) => f.id === "cf_date").type, "string");
    assert.deepEqual(mapped.find((f) => f.id === "cf_user").options, [
      { name: "Test User", value: "user_1" },
    ]);
  } finally {
    api.closeApiRequest = original;
    api.closeApiRequestAllItems = all;
  }
});
test("multi-choice loader uses relative field selection of the current row", async () => {
  const original = api.closeApiRequest;
  api.closeApiRequest = async () => ({ fields });
  try {
    const options =
      await new Close().methods.loadOptions.getMultiValueCustomFieldOptions.call(
        {
          getCurrentNodeParameter: (k) =>
            k === "resource" ? "lead" : k === "&field" ? "cf_tags" : undefined,
        },
      );
    assert.deepEqual(options, [
      { name: "A", value: "A" },
      { name: "B", value: "B" },
      { name: "C", value: "C" },
    ]);
  } finally {
    api.closeApiRequest = original;
  }
});
