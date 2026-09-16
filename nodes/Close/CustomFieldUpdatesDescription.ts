import type { INodeProperties } from "n8n-workflow";
const show = {
  resource: ["lead", "contact", "opportunity", "customActivity"],
  operation: ["update"],
};
export const customFieldUpdateProperties: INodeProperties[] = [
  {
    displayName: "Custom Field Values (JSON)",
    name: "customFieldValuesJson",
    type: "json",
    default: "{}",
    displayOptions: { show },
    description:
      "Optional field-value object using cf_ IDs or custom.cf_ keys. Explicit null clears a field. Do not also map or clear the same field elsewhere.",
  },
  {
    displayName: "Multi-Value Field Changes",
    name: "multiValueFieldEdits",
    type: "fixedCollection",
    default: {},
    placeholder: "Add Field Change",
    displayOptions: { show },
    typeOptions: { multipleValues: true },
    options: [
      {
        displayName: "Changes",
        name: "edits",
        values: [
							{
								displayName: 'Action',
								name: 'action',
								type: 'options',
								default: 'add',
								options: [
											{
												name: 'Add',
												value: 'add',
											},
											{
												name: 'Remove',
												value: 'remove',
											},
											{
												name: 'Replace',
												value: 'set',
											},
										]
							},
							{
								displayName: 'Field Name or ID',
								name: 'field',
								type: 'options',
								default: '',
									required:	true,
								description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
							},
							{
								displayName: 'Value Input',
								name: 'valueInput',
								type: 'options',
								default: 'list',
								options: [
											{
												name: 'From List',
												value: 'list',
											},
											{
												name: 'JSON Array',
												value: 'json',
											},
									],
								description: 'Use the list for choice and user fields, or JSON for any multi-value field',
							},
							{
								displayName: 'Value Names or IDs',
								name: 'choiceValues',
								type: 'multiOptions',
								default: [],
								description: 'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
							},
							{
								displayName: 'Values (JSON)',
								name: 'values',
								type: 'json',
								default: '[]',
								description: 'An array of values to add, remove or replace',
							},
					],
      },
    ],
  },
];
