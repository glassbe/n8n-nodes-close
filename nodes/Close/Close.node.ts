import {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IDataObject,
	NodeOperationError,
		IHttpRequestOptions,
		NodeConnectionTypes,
		NodeApiError,
		JsonObject,
		ResourceMapperFields,
		ResourceMapperField,
	} from 'n8n-workflow';
import { apiRequestProperties, executeApiRequest } from './ApiRequest';
import { closeApiRequest, closeApiRequestAllItems } from './GenericFunctions';
import { upsertRecord, standardFields, type MatchKey, type UpsertResource } from './RecordUpsert';
import { upsertProperties } from './RecordUpsertDescription';
import { applyCustomFieldUpdates } from './CustomFieldUpdates';
import { customFieldUpdateProperties } from './CustomFieldUpdatesDescription';
import { applyCustomFieldClears } from './CustomFieldClearing';


// ─── Helper: build ResourceMapperFields from Close CRM custom field list ─────
// Close CRM API returns choices as a plain string array: ["Option A", "Option B"]
function buildResourceMapperFields(fields: IDataObject[]): ResourceMapperFields {
	const mapperFields: ResourceMapperField[] = fields.map((f: IDataObject) => {
		const fieldType = f.type as string;
		let type: ResourceMapperField['type'] = 'string';
		let options: ResourceMapperField['options'] | undefined;

		if (fieldType === 'number') {
			type = 'number';
		} else if (fieldType === 'date' || fieldType === 'datetime') {
			type = 'dateTime';
		} else if (
			fieldType === 'choices' ||
			fieldType === 'choice' ||
			fieldType === 'multiple_choice' ||
			fieldType === 'multiselect'
		) {
			type = 'options';
			// Only Close choice types are dropdowns. Text and other field types can expose
			// a `choices` property with an empty/null value, but must remain text inputs.
			// Choices is a plain string array: ["Option A", "Option B"]
			const rawChoices = f.choices as (string | IDataObject)[] | null;
			if (rawChoices && rawChoices.length > 0) {
				options = rawChoices.map((c) => {
					if (typeof c === 'string') {
						return { name: c, value: c };
					}
					// fallback for object-shaped choices
					const label = (c.display as string) || (c.name as string) || (c.value as string) || String(c);
					const val = (c.id as string) || (c.value as string) || label;
					return { name: label, value: val };
				});
			}
		}

		const field: ResourceMapperField = {
			id: f.id as string,
			displayName: f.name as string,
			defaultMatch: false,
			required: false,
			display: true,
			type,
		};
		if (options !== undefined) {
			field.options = options;
		}
		return field;
	});
	return { fields: mapperFields };
}

async function enrichCustomFieldMapper(context: ILoadOptionsFunctions, definitions: IDataObject[]): Promise<ResourceMapperFields> {
 const mapped=buildResourceMapperFields(definitions);
 const users=definitions.some(f=>f.type==='user') ? await closeApiRequestAllItems.call(context,'GET','/user/') : [];
 for (let i=0;i<mapped.fields.length;i++) {
  const field=mapped.fields[i], definition=definitions[i];
  if (definition.accepts_multiple_values) { field.type='array'; delete field.options; }
  else if (definition.type==='user') { field.type='options'; field.options=users.map((u: IDataObject)=>({name: String(u.first_name || '')+' '+String(u.last_name || ''),value:String(u.id)})); }
  else if (definition.type==='date') field.type='string';
 }
 return mapped;
}

// ─── Helper: merge shared custom fields for a given object type ───────────────
function filterSharedFields(sharedFields: IDataObject[], objectType: string, activityTypeId?: string): IDataObject[] {
	return sharedFields.filter((f: IDataObject) => {
		const associations = (f.associations as IDataObject[]) || [];
		return associations.some((a: IDataObject) => {
			if (a.object_type !== objectType) return false;
			if (objectType === 'custom_activity_type' && activityTypeId) {
				return a.custom_activity_type_id === activityTypeId;
			}
			return true;
		});
	});
}

function parseSmartViewQuery(value: unknown, context: IExecuteFunctions, itemIndex: number): IDataObject {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		return value as IDataObject;
	}

	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				return parsed as IDataObject;
			}
		} catch {
			// Throw the same validation error below for malformed JSON.
		}
	}

	throw new NodeOperationError(context.getNode(), 'Query (JSON) must be a valid JSON object', { itemIndex });
}

export class Close implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Close',
		name: 'close',
		icon: 'file:close.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Interact with Close CRM — manage leads, contacts, opportunities, tasks, notes, calls, emails, custom activities, pipelines, and more (80+ operations across 19 resources)',
		codex: {
			categories: ['Sales', 'CRM'],
			alias: ['close', 'close crm', 'closecrm', 'close.com', 'crm', 'leads', 'contacts', 'opportunities', 'sales'],
			resources: {
				primaryDocumentation: [{ url: 'https://developer.close.com/' }],
			},
		},
		defaults: {
			name: 'Close',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'closeApi',
				required: true,
			},
		],
		properties: [
			// ─── RESOURCE SELECTOR ───────────────────────────────────────────────────
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'API Request', value: 'apiRequest' },
					{ name: 'Call', value: 'call' },
					{ name: 'Comment', value: 'comment' },
					{ name: 'Contact', value: 'contact' },
					{ name: 'Custom Activity', value: 'customActivity' },
					{ name: 'Custom Activity Type', value: 'customActivityType' },
					{ name: 'Custom Field', value: 'customField' },
					{ name: 'Email', value: 'email' },
					{ name: 'Email Template', value: 'emailTemplate' },
					{ name: 'Integration Link', value: 'integrationLink' },
					{ name: 'Lead', value: 'lead' },
					{ name: 'Lead Status', value: 'leadStatus' },
					{ name: 'Note', value: 'note' },
					{ name: 'Opportunity', value: 'opportunity' },
					{ name: 'Opportunity Status', value: 'opportunityStatus' },
					{ name: 'Pipeline', value: 'pipeline' },
					{ name: 'SMS', value: 'sms' },
					{ name: 'Smart View', value: 'smartView' },
					{ name: 'Task', value: 'task' },
					{ name: 'User', value: 'user' },
				],
				default: 'lead',
			},

			// ─── LEAD ────────────────────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['lead'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a lead' },
					{ name: 'Create or Update by Fields', value: 'upsertByFields', action: 'Create or update lead by fields' },
					{ name: 'Delete', value: 'delete', action: 'Delete a lead' },
					{ name: 'Get', value: 'get', action: 'Get a lead' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many leads' },
					{ name: 'Merge', value: 'merge', action: 'Merge leads' },
					{ name: 'Search', value: 'search', action: 'Search leads' },
					{ name: 'Update', value: 'update', action: 'Update a lead' },
				],
				default: 'get',
			},
			{
				displayName: 'Lead ID',
				name: 'leadId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['lead'], operation: ['get', 'update', 'delete', 'merge'] } },
			},
			{
				displayName: 'Source Lead ID',
				name: 'sourceLeadId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['lead'], operation: ['merge'] } },
				description: 'ID of the lead to merge into the destination lead — it will be deleted after merging',
			},
			{
				displayName: 'Company Name',
				name: 'companyName',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['lead'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['lead'], operation: ['create', 'update'] } },
				options: [
					{ displayName: 'Contact Email', name: 'contact_email', type: 'string', default: '', description: 'Email address of the primary contact (creates a contact on the lead)' },
					{ displayName: 'Contact Name', name: 'contact_name', type: 'string', default: '', description: 'Full name of the primary contact (creates a contact on the lead)' },
					{ displayName: 'Contact Phone', name: 'contact_phone', type: 'string', default: '', description: 'Phone number of the primary contact (creates a contact on the lead)' },
					{ displayName: 'Description', name: 'description', type: 'string', default: '' },
					{ displayName: 'Status Name or ID', name: 'status_id', type: 'options',
																																		description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>', typeOptions: { loadOptionsMethod: 'getLeadStatuses' }, default: '' },
					{ displayName: 'URL', name: 'url', type: 'string', default: '' },
				],
			},
			{
				displayName: 'Custom Fields',
				name: 'customFields',
				type: 'resourceMapper',
				noDataExpression: true,
				default: { mappingMode: 'defineBelow', value: null },
				required: false,
				displayOptions: { show: { resource: ['lead'], operation: ['create', 'update'] } },
				typeOptions: {
					resourceMapper: {
						resourceMapperMethod: 'getLeadCustomFieldsForMapper',
						mode: 'add',
						fieldWords: { singular: 'Custom Field', plural: 'Custom Fields' },
						addAllFields: false,
						supportAutoMap: false,
						valuesLabel: '',
						noFieldsError: 'No custom fields found. Check your Close CRM credentials.',
					},
				},
			},
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				default: '',
				required: false,
				displayOptions: { show: { resource: ['lead'], operation: ['search'] } },
				description: 'Simple text search query. Leave empty if using Advanced Query (JSON) below.',
			},
			{
				displayName: 'Advanced Query (JSON)',
				name: 'advancedQuery',
				type: 'json',
				default: '',
				required: false,
				displayOptions: { show: { resource: ['lead'], operation: ['search'] } },
				description: 'Structured query JSON for advanced filtering using the Close CRM Search API (POST /leads/search/). When provided, overrides the simple Query field. Paste the full s_query object from Close\'s advanced filter.',
				typeOptions: { rows: 10 },
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				description: 'Whether to return all results or only up to a given limit',
				default: false,
				displayOptions: { show: { resource: ['lead'], operation: ['getAll', 'search'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				description: 'Max number of results to return',
				default: 50,
				typeOptions: { minValue: 1, maxValue: 200 },
				displayOptions: { show: { resource: ['lead'], operation: ['getAll', 'search'], returnAll: [false] } },
			},

			// ─── LEAD STATUS ─────────────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['leadStatus'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a lead status' },
					{ name: 'Delete', value: 'delete', action: 'Delete a lead status' },
					{ name: 'Get', value: 'get', action: 'Get a lead status' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many lead statuses' },
					{ name: 'Update', value: 'update', action: 'Update a lead status' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Lead Status ID',
				name: 'leadStatusId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['leadStatus'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Label',
				name: 'label',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['leadStatus'], operation: ['create', 'update'] } },
			},

			// ─── CONTACT ─────────────────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['contact'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a contact' },
					{ name: 'Create or Update by Fields', value: 'upsertByFields', action: 'Create or update contact by fields' },
					{ name: 'Delete', value: 'delete', action: 'Delete a contact' },
					{ name: 'Get', value: 'get', action: 'Get a contact' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many contacts' },
					{ name: 'Update', value: 'update', action: 'Update a contact' },
				],
				default: 'get',
			},
			{
				displayName: 'Contact ID',
				name: 'contactId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['contact'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Lead ID',
				name: 'leadId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['contact'], operation: ['create'] } },
				description: 'ID of the lead to create the contact under',
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['contact'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['contact'], operation: ['create', 'update'] } },
				options: [
					{
						displayName: 'Email Addresses',
						name: 'emails',
						type: 'fixedCollection',
						placeholder: 'Add Email',
						default: {},
						typeOptions: { multipleValues: true },
						options: [
							{
								name: 'emailValues',
								displayName: 'Email',
								values: [
									{ displayName: 'Email', name: 'email', type: 'string', placeholder: 'name@email.com', default: '' },
									{ displayName: 'Type', name: 'type', type: 'options', default: 'office', options: [
										{ name: 'Direct', value: 'direct' },
										{ name: 'Home', value: 'home' },
										{ name: 'Office', value: 'office' },
										{ name: 'Other', value: 'other' },
									]},
								],
							},
							{
								name: 'updateMode',
								displayName: 'Update Mode',
								values: [
									{
										displayName: 'Email Update Mode',
										name: 'emailUpdateMode',
										type: 'options',
										default: 'add',
										description: 'Whether to add the new email(s) to the existing list (highest priority) or replace all existing emails',
										options: [
											{ name: 'Add (Keep Existing)', value: 'add', description: 'Prepend new email(s) to the existing list — new email gets highest priority' },
											{ name: 'Replace (Overwrite)', value: 'replace', description: 'Replace all existing emails with the new email(s)' },
										],
									},
								],
							},
						],
					},
					{
						displayName: 'Phone Numbers',
						name: 'phones',
						type: 'fixedCollection',
						placeholder: 'Add Phone',
						default: {},
						typeOptions: { multipleValues: true },
							options: [
								{
									name: 'phoneValues',
									displayName: 'Phone',
									values: [
										{ displayName: 'Phone', name: 'phone', type: 'string', default: '' },
										{ displayName: 'Type', name: 'type', type: 'options', default: 'office', options: [
											{ name: 'Direct', value: 'direct' },
											{ name: 'Home', value: 'home' },
											{ name: 'Mobile', value: 'mobile' },
											{ name: 'Office', value: 'office' },
											{ name: 'Other', value: 'other' },
										]},
									],
								},
								{
									name: 'updateMode',
									displayName: 'Update Mode',
									values: [
										{
											displayName: 'Phone Update Mode',
											name: 'phoneUpdateMode',
											type: 'options',
											default: 'add',
											description: 'Whether to add the new phone number(s) to the existing list or replace all existing phone numbers',
											options: [
												{ name: 'Add (Keep Existing)', value: 'add', description: 'Prepend new phone number(s) to the existing list and skip duplicates' },
												{ name: 'Replace (Overwrite)', value: 'replace', description: 'Replace all existing phone numbers with the new phone number(s)' },
											],
										},
									],
								},
							],
					},
					{ displayName: 'Name', name: 'name', type: 'string', default: '', description: 'Full name of the contact' },
					{ displayName: 'Title', name: 'title', type: 'string', default: '' },
				],
			},
			{
				displayName: 'Custom Fields',
				name: 'customFields',
				type: 'resourceMapper',
				noDataExpression: true,
				default: { mappingMode: 'defineBelow', value: null },
				required: false,
				displayOptions: { show: { resource: ['contact'], operation: ['create', 'update'] } },
				typeOptions: {
					resourceMapper: {
						resourceMapperMethod: 'getContactCustomFieldsForMapper',
						mode: 'add',
						fieldWords: { singular: 'Custom Field', plural: 'Custom Fields' },
						addAllFields: false,
						supportAutoMap: false,
						valuesLabel: '',
						noFieldsError: 'No custom fields found. Check your Close CRM credentials.',
					},
				},
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				description: 'Whether to return all results or only up to a given limit',
				default: false,
				displayOptions: { show: { resource: ['contact'], operation: ['getAll'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				description: 'Max number of results to return',
				default: 50,
				typeOptions: { minValue: 1, maxValue: 200 },
				displayOptions: { show: { resource: ['contact'], operation: ['getAll'], returnAll: [false] } },
			},

			// ─── OPPORTUNITY ──────────────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['opportunity'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create an opportunity' },
					{ name: 'Create or Update', value: 'upsert', action: 'Create or update an opportunity' },
					{ name: 'Create or Update by Fields', value: 'upsertByFields', action: 'Create or update opportunity by fields' },
					{ name: 'Delete', value: 'delete', action: 'Delete an opportunity' },
					{ name: 'Get', value: 'get', action: 'Get an opportunity' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many opportunities' },
					{ name: 'Update', value: 'update', action: 'Update an opportunity' },
				],
				default: 'get',
			},
			{
				displayName: 'Opportunity ID',
				name: 'opportunityId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['opportunity'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Lead ID',
				name: 'leadId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['opportunity'], operation: ['create', 'upsert'] } },
			},
			// ─── UPSERT-SPECIFIC FIELDS ─────────────────────────────────────────────
			{
				displayName: 'Pipeline Name or ID',
				name: 'pipelineId',
				type: 'options',
				required: true,
				description: 'Pipeline to search for existing opportunities. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				typeOptions: { loadOptionsMethod: 'getPipelinesForUpsert' },
				default: '',
				displayOptions: { show: { resource: ['opportunity'], operation: ['upsert'] } },
			},
			{
				displayName: 'Status Type Filter',
				name: 'statusTypeFilter',
				type: 'multiOptions',
				description: 'Only consider opportunities with these status types when searching. Leave empty to consider all status types.',
				options: [
					{ name: 'Active', value: 'active' },
					{ name: 'Lost', value: 'lost' },
					{ name: 'Won', value: 'won' },
				],
				default: [],
				displayOptions: { show: { resource: ['opportunity'], operation: ['upsert'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['opportunity'], operation: ['create', 'update', 'upsert'] } },
				options: [
					{ displayName: 'Note', name: 'note', type: 'string', default: '' },
					{ displayName: 'Status Name or ID', name: 'status_id', type: 'options',
																																									description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>', typeOptions: { loadOptionsMethod: 'getOpportunityStatuses' }, default: '' },
					{
						displayName: 'User Name or ID',
						name: 'user_id',
						type: 'options',
						default: '',
						description: 'Assign the opportunity to this user. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
						typeOptions: { loadOptionsMethod: 'getUsers' },
					},
					{ displayName: 'Value (in Cents)', name: 'value', type: 'number', default: 0 },
					{ displayName: 'Value Currency', name: 'value_currency', type: 'string', default: 'USD' },
					{
						displayName: 'Value Period',
						name: 'value_period',
						type: 'options',
						options: [
							{ name: 'One Time', value: 'one_time' },
							{ name: 'Monthly', value: 'monthly' },
							{ name: 'Annual', value: 'annual' },
						],
						default: 'one_time',
					},
					{ displayName: 'Close Date', name: 'date_won', type: 'string', default: '' },
				],
				},
			{
				displayName: 'Custom Fields',
				name: 'customFields',
				type: 'resourceMapper',
				noDataExpression: true,
				default: { mappingMode: 'defineBelow', value: null },
				required: false,
				displayOptions: { show: { resource: ['opportunity'], operation: ['create', 'update', 'upsert'] } },
				typeOptions: {
					resourceMapper: {
						resourceMapperMethod: 'getOpportunityCustomFieldsForMapper',
						mode: 'add',
						fieldWords: { singular: 'Custom Field', plural: 'Custom Fields' },
						addAllFields: false,
						supportAutoMap: false,
						valuesLabel: '',
						noFieldsError: 'No custom fields found. Check your Close CRM credentials.',
					},
				},
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				description: 'Whether to return all results or only up to a given limit',
				default: false,
				displayOptions: { show: { resource: ['opportunity'], operation: ['getAll'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				description: 'Max number of results to return',
				default: 50,
				typeOptions: { minValue: 1, maxValue: 200 },
				displayOptions: { show: { resource: ['opportunity'], operation: ['getAll'], returnAll: [false] } },
			},
			// ─── OPPORTUNITY GET MANY FILTERS ────────────────────────────────────────
			{
				displayName: 'Filters',
				name: 'opportunityFilters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['opportunity'], operation: ['getAll'] } },
				options: [
					{
						displayName: 'Lead ID',
						name: 'lead_id',
						type: 'string',
						default: '',
						description: 'Return only opportunities belonging to this lead',
					},
					{
						displayName: 'Status Type',
						name: 'status_type',
						type: 'multiOptions',
						default: [],
						description: 'Filter by opportunity status type (applied client-side)',
						options: [
							{ name: 'Active', value: 'active' },
							{ name: 'Won', value: 'won' },
							{ name: 'Lost', value: 'lost' },
						],
					},
					{
						displayName: 'User Name or ID',
						name: 'user_id',
						type: 'options',
						default: '',
						description: 'Return only opportunities assigned to this user. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
						typeOptions: { loadOptionsMethod: 'getUsers' },
					},
				],
			},

			// ─── OPPORTUNITY STATUS ───────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['opportunityStatus'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create an opportunity status' },
					{ name: 'Delete', value: 'delete', action: 'Delete an opportunity status' },
					{ name: 'Get', value: 'get', action: 'Get an opportunity status' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many opportunity statuses' },
					{ name: 'Update', value: 'update', action: 'Update an opportunity status' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Opportunity Status ID',
				name: 'opportunityStatusId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['opportunityStatus'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Label',
				name: 'label',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['opportunityStatus'], operation: ['create'] } },
			},
			{
				displayName: 'Type',
				name: 'type',
				type: 'options',
				options: [
					{ name: 'Active', value: 'active' },
					{ name: 'Won', value: 'won' },
					{ name: 'Lost', value: 'lost' },
				],
				default: 'active',
				required: true,
				displayOptions: { show: { resource: ['opportunityStatus'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['opportunityStatus'], operation: ['update'] } },
				options: [
					{ displayName: 'Label', name: 'label', type: 'string', default: '' },
					{
						displayName: 'Type',
						name: 'type',
						type: 'options',
						options: [
							{ name: 'Active', value: 'active' },
							{ name: 'Won', value: 'won' },
							{ name: 'Lost', value: 'lost' },
						],
												default: 'active',
					},
				],
				},
				{
					displayName: 'Return All',
					name: 'returnAll',
					type: 'boolean',
					description: 'Whether to return all results or only up to a given limit',
					default: false,
					displayOptions: { show: { resource: ['opportunityStatus'], operation: ['getAll'] } },
				},
				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					description: 'Max number of results to return',
					default: 50,
					typeOptions: { minValue: 1, maxValue: 1000 },
					displayOptions: { show: { resource: ['opportunityStatus'], operation: ['getAll'], returnAll: [false] } },
				},

				// ─── PIPELINE ─────────────────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['pipeline'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a pipeline' },
					{ name: 'Delete', value: 'delete', action: 'Delete a pipeline' },
					{ name: 'Get', value: 'get', action: 'Get a pipeline' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many pipelines' },
					{ name: 'Update', value: 'update', action: 'Update a pipeline' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Pipeline ID',
				name: 'pipelineId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['pipeline'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
									required: true,
					displayOptions: { show: { resource: ['pipeline'], operation: ['create', 'update'] } },
				},
				{
					displayName: 'Return All',
					name: 'returnAll',
					type: 'boolean',
					description: 'Whether to return all results or only up to a given limit',
					default: false,
					displayOptions: { show: { resource: ['pipeline'], operation: ['getAll'] } },
				},
				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					description: 'Max number of results to return',
					default: 50,
					typeOptions: { minValue: 1, maxValue: 1000 },
					displayOptions: { show: { resource: ['pipeline'], operation: ['getAll'], returnAll: [false] } },
				},

				// ─── TASK ─────────────────────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['task'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a task' },
					{ name: 'Delete', value: 'delete', action: 'Delete a task' },
					{ name: 'Get', value: 'get', action: 'Get a task' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many tasks' },
					{ name: 'Update', value: 'update', action: 'Update a task' },
				],
				default: 'get',
			},
			{
				displayName: 'Task ID',
				name: 'taskId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['task'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['task'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['task'], operation: ['create', 'update'] } },
				options: [
					{ displayName: 'Lead ID', name: 'lead_id', type: 'string', default: '' },
					{ displayName: 'Assigned To (User ID)', name: 'assigned_to', type: 'string', default: '' },
					{ displayName: 'Due Date', name: 'due_date', type: 'string', default: '', description: 'ISO 8601 date string' },
					{ displayName: 'Is Complete', name: 'is_complete', type: 'boolean', default: false },
				],
			},
			{
				displayName: 'Filters',
				name: 'taskFilters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['task'], operation: ['getAll'] } },
				options: [
					{
						displayName: 'Lead ID',
						name: 'lead_id',
						type: 'string',
						default: '',
						description: 'Return only tasks belonging to this lead',
						placeholder: 'lead_abc123...',
					},
					{
						displayName: 'Task Status',
						name: 'taskStatus',
						type: 'options',
						default: 'all',
						description: 'Filter by completion status',
						options: [
							{ name: 'All', value: 'all', description: 'Return both open and completed tasks' },
							{ name: 'Open', value: 'open', description: 'Return only incomplete (open) tasks' },
							{ name: 'Completed', value: 'completed', description: 'Return only completed tasks' },
						],
					},
					{
						displayName: 'Assigned To',
						name: 'assigned_to',
						type: 'options',
						default: '',
						description: 'Return only tasks assigned to this user',
						typeOptions: { loadOptionsMethod: 'getUsers' },
					},
					{
						displayName: 'Due Date After',
						name: 'due_date__gte',
						type: 'dateTime',
						default: '',
						description: 'Return tasks with a due date on or after this date',
					},
					{
						displayName: 'Due Date Before',
						name: 'due_date__lte',
						type: 'dateTime',
						default: '',
						description: 'Return tasks with a due date on or before this date',
					},
					{
						displayName: 'Date Created After',
						name: 'date_created__gte',
						type: 'dateTime',
						default: '',
						description: 'Return tasks created on or after this date',
					},
					{
						displayName: 'Date Created Before',
						name: 'date_created__lte',
						type: 'dateTime',
						default: '',
						description: 'Return tasks created on or before this date',
					},
				],
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				description: 'Whether to return all results or only up to a given limit',
				default: false,
				displayOptions: { show: { resource: ['task'], operation: ['getAll'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				description: 'Max number of results to return',
				default: 50,
				typeOptions: { minValue: 1, maxValue: 200 },
				displayOptions: { show: { resource: ['task'], operation: ['getAll'], returnAll: [false] } },
			},

			// ─── NOTE ─────────────────────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['note'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a note' },
					{ name: 'Delete', value: 'delete', action: 'Delete a note' },
					{ name: 'Get', value: 'get', action: 'Get a note' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many notes for a lead' },
					{ name: 'Update', value: 'update', action: 'Update a note' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Note ID',
				name: 'noteId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['note'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Lead ID',
				name: 'leadId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['note'], operation: ['create', 'getAll'] } },
			},
			{
				displayName: 'Note Type',
				name: 'noteType',
				type: 'options',
				options: [
					{ name: 'Plain Text', value: 'plain' },
					{ name: 'Rich Text (HTML)', value: 'html' },
				],
				default: 'plain',
				displayOptions: { show: { resource: ['note'], operation: ['create', 'update'] } },
			},
			{
				displayName: 'Note',
				name: 'note',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
				description: 'Plain text content of the note',
				displayOptions: { show: { resource: ['note'], operation: ['create', 'update'], noteType: ['plain'] } },
			},
			{
				displayName: 'Note HTML',
				name: 'noteHtml',
				type: 'string',
				typeOptions: { rows: 6 },
				default: '<body><p></p></body>',
				required: true,
				description: 'Rich text HTML content. Must be wrapped in &lt;body&gt;&lt;/body&gt; tags.',
				displayOptions: { show: { resource: ['note'], operation: ['create', 'update'], noteType: ['html'] } },
			},
			{
				displayName: 'Attach File',
				name: 'attachFile',
				type: 'boolean',
				default: false,
				description: 'Whether to attach a file to this note',
				displayOptions: { show: { resource: ['note'], operation: ['create'] } },
			},
			{
				displayName: 'Attachment Source',
				name: 'attachmentSource',
				type: 'options',
				options: [
					{ name: 'URL', value: 'url' },
					{ name: 'Binary Data', value: 'binary' },
				],
				default: 'url',
				displayOptions: { show: { resource: ['note'], operation: ['create'], attachFile: [true] } },
			},
			{
				displayName: 'File URL',
				name: 'fileUrl',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://example.com/document.pdf',
				description: 'URL of the file to download and attach to the note',
				displayOptions: { show: { resource: ['note'], operation: ['create'], attachFile: [true], attachmentSource: ['url'] } },
			},
			{
				displayName: 'Binary Property',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				description: 'Name of the binary property containing the file to attach',
				displayOptions: { show: { resource: ['note'], operation: ['create'], attachFile: [true], attachmentSource: ['binary'] } },
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['note'], operation: ['getAll'] } },
				options: [
					{
						displayName: 'Date Created After',
						name: 'date_created__gt',
						type: 'dateTime',
						default: '',
						description: 'Return activities created after this date/time (exclusive)',
					},
					{
						displayName: 'Date Created Before',
						name: 'date_created__lt',
						type: 'dateTime',
						default: '',
						description: 'Return activities created before this date/time (exclusive)',
					},
				],
				},
				{
					displayName: 'Return All',
					name: 'returnAll',
					type: 'boolean',
					description: 'Whether to return all results or only up to a given limit',
					default: false,
					displayOptions: { show: { resource: ['note'], operation: ['getAll'] } },
				},
				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					description: 'Max number of results to return',
					default: 50,
					typeOptions: { minValue: 1, maxValue: 1000 },
					displayOptions: { show: { resource: ['note'], operation: ['getAll'], returnAll: [false] } },
				},
				// ─── CALL ─────────────────────────────────────────────────────────────────
				{
					displayName: 'Operation',
					name: 'operation',
					type: 'options',
					noDataExpression: true,
					displayOptions: { show: { resource: ['call'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a call' },
					{ name: 'Delete', value: 'delete', action: 'Delete a call' },
					{ name: 'Get', value: 'get', action: 'Get a call' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many calls for a lead' },
					{ name: 'Update', value: 'update', action: 'Update a call' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Call ID',
				name: 'callId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['call'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Lead ID',
				name: 'callLeadId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['call'], operation: ['create', 'getAll'] } },
			},
			{
				displayName: 'Direction',
				name: 'direction',
				type: 'options',
				options: [
					{ name: 'Outbound', value: 'outbound' },
					{ name: 'Inbound', value: 'inbound' },
				],
				default: 'outbound',
				required: true,
				displayOptions: { show: { resource: ['call'], operation: ['create'] } },
			},
			{
				displayName: 'Status',
				name: 'callStatus',
				type: 'options',
				options: [
					{ name: 'Answered', value: 'answered' },
					{ name: 'No Answer', value: 'no-answer' },
					{ name: 'Voicemail Left', value: 'vm-left' },
					{ name: 'Busy', value: 'busy' },
					{ name: 'Error', value: 'error' },
				],
				default: 'answered',
				required: true,
				displayOptions: { show: { resource: ['call'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['call'], operation: ['create', 'update'] } },
				options: [
					{ displayName: 'Note', name: 'note', type: 'string', default: '', typeOptions: { rows: 3 } },
					{ displayName: 'Duration (Seconds)', name: 'duration', type: 'number', default: 0 },
					{ displayName: 'Phone', name: 'phone', type: 'string', default: '' },
					{ displayName: 'Contact ID', name: 'contact_id', type: 'string', default: '' },
				],
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['call'], operation: ['getAll'] } },
				options: [
					{
						displayName: 'Date Created After',
						name: 'date_created__gt',
						type: 'dateTime',
						default: '',
						description: 'Return activities created after this date/time (exclusive)',
					},
					{
						displayName: 'Date Created Before',
						name: 'date_created__lt',
						type: 'dateTime',
						default: '',
						description: 'Return activities created before this date/time (exclusive)',
					},
				],
				},
				{
					displayName: 'Return All',
					name: 'returnAll',
					type: 'boolean',
					description: 'Whether to return all results or only up to a given limit',
					default: false,
					displayOptions: { show: { resource: ['call'], operation: ['getAll'] } },
				},
				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					description: 'Max number of results to return',
					default: 50,
					typeOptions: { minValue: 1, maxValue: 1000 },
					displayOptions: { show: { resource: ['call'], operation: ['getAll'], returnAll: [false] } },
				},
				// ─── EMAIL ─────────────────────────────────────────────────────────────────
				{
					displayName: 'Operation',
					name: 'operation',
					type: 'options',
					noDataExpression: true,
					displayOptions: { show: { resource: ['email'] } },
				options: [
					{ name: 'Create (Send)', value: 'create', action: 'Send an email' },
					{ name: 'Delete', value: 'delete', action: 'Delete an email' },
					{ name: 'Get', value: 'get', action: 'Get an email' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many emails for a lead' },
					{ name: 'Update', value: 'update', action: 'Update an email' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Email ID',
				name: 'emailId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['email'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Lead ID',
				name: 'emailLeadId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['email'], operation: ['create', 'getAll'] } },
			},
			{
				displayName: 'Contact ID',
				name: 'emailContactId',
				type: 'string',
				default: '',
				required: true,
				description: 'The Close contact that will receive and be associated with this email. Required when rendering an email template.',
				displayOptions: { show: { resource: ['email'], operation: ['create'] } },
			},
			{
				displayName: 'Sender User Name or ID',
				name: 'emailUserId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getUsers' },
				default: '',
				required: true,
				description: 'The Close user who sends the email. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: { show: { resource: ['email'], operation: ['create'] } },
			},
			{
				displayName: 'Sender Email',
				name: 'emailSender',
				type: 'string',
				default: '',
				required: true,
				description: 'The connected sender address to use. The selected user must be authorized to send from this email address in Close.',
				displayOptions: { show: { resource: ['email'], operation: ['create'] } },
			},
			{
				displayName: 'To',
				name: 'emailTo',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'contact@example.com',
				displayOptions: { show: { resource: ['email'], operation: ['create'] } },
			},
			{
				displayName: 'Use Email Template',
				name: 'useTemplate',
				type: 'boolean',
				default: false,
				description: 'Whether to use a saved email template instead of writing subject and body manually',
				displayOptions: { show: { resource: ['email'], operation: ['create'] } },
			},
			{
				displayName: 'Template Name or ID',
				name: 'emailTemplateId',
				type: 'options',
				default: '',
				required: true,
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: { loadOptionsMethod: 'getEmailTemplates' },
				displayOptions: { show: { resource: ['email'], operation: ['create'], useTemplate: [true] } },
			},
			{
				displayName: 'Subject',
				name: 'emailSubject',
				type: 'string',
				default: '',
				required: false,
				description: 'Email subject line. Not required when using a template.',
				displayOptions: { show: { resource: ['email'], operation: ['create'], useTemplate: [false] } },
			},
			{
				displayName: 'Body Type',
				name: 'bodyType',
				type: 'options',
				options: [
					{ name: 'HTML', value: 'html' },
					{ name: 'Plain Text', value: 'text' },
				],
				default: 'html',
				description: 'Whether to send the body as HTML or plain text',
				displayOptions: { show: { resource: ['email'], operation: ['create'], useTemplate: [false] } },
			},
			{
				displayName: 'Body',
				name: 'emailBody',
				type: 'string',
				typeOptions: { rows: 6 },
				default: '',
				required: false,
				description: 'Email body content. Use Body Type to switch between HTML and plain text.',
				displayOptions: { show: { resource: ['email'], operation: ['create'], useTemplate: [false] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['email'], operation: ['create', 'update'] } },
				options: [
					{ displayName: 'BCC', name: 'bcc', type: 'string', default: '' },
					{ displayName: 'CC', name: 'cc', type: 'string', default: '' },
				],
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['email'], operation: ['getAll'] } },
				options: [
					{
						displayName: 'Date Created After',
						name: 'date_created__gt',
						type: 'dateTime',
						default: '',
						description: 'Return activities created after this date/time (exclusive)',
					},
					{
						displayName: 'Date Created Before',
						name: 'date_created__lt',
						type: 'dateTime',
						default: '',
						description: 'Return activities created before this date/time (exclusive)',
					},
				],
				},
				{
					displayName: 'Return All',
					name: 'returnAll',
					type: 'boolean',
					description: 'Whether to return all results or only up to a given limit',
					default: false,
					displayOptions: { show: { resource: ['email'], operation: ['getAll'] } },
				},
				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					description: 'Max number of results to return',
					default: 50,
					typeOptions: { minValue: 1, maxValue: 1000 },
					displayOptions: { show: { resource: ['email'], operation: ['getAll'], returnAll: [false] } },
				},
				// ─── SMS ─────────────────────────────────────────────────────────────────
				{
					displayName: 'Operation',
					name: 'operation',
					type: 'options',
					noDataExpression: true,
					displayOptions: { show: { resource: ['sms'] } },
				options: [
					{ name: 'Create (Send)', value: 'create', action: 'Send an SMS' },
					{ name: 'Delete', value: 'delete', action: 'Delete an SMS' },
					{ name: 'Get', value: 'get', action: 'Get an SMS' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many SMS messages for a lead' },
					{ name: 'Update', value: 'update', action: 'Update an SMS' },
				],
				default: 'getAll',
			},
			{
				displayName: 'SMS ID',
				name: 'smsId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['sms'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Lead ID',
				name: 'smsLeadId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['sms'], operation: ['create', 'getAll'] } },
			},
			{
				displayName: 'Text',
				name: 'smsText',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				displayOptions: { show: { resource: ['sms'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['sms'], operation: ['create', 'update'] } },
				options: [
					{ displayName: 'Contact ID', name: 'contact_id', type: 'string', default: '' },
					{ displayName: 'Phone', name: 'remote_phone', type: 'string', default: '' },
					{ displayName: 'Local Phone', name: 'local_phone', type: 'string', default: '' },
				],
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['sms'], operation: ['getAll'] } },
				options: [
					{
						displayName: 'Date Created After',
						name: 'date_created__gt',
						type: 'dateTime',
						default: '',
						description: 'Return activities created after this date/time (exclusive)',
					},
					{
						displayName: 'Date Created Before',
						name: 'date_created__lt',
						type: 'dateTime',
						default: '',
						description: 'Return activities created before this date/time (exclusive)',
					},
				],
				},
				{
					displayName: 'Return All',
					name: 'returnAll',
					type: 'boolean',
					description: 'Whether to return all results or only up to a given limit',
					default: false,
					displayOptions: { show: { resource: ['sms'], operation: ['getAll'] } },
				},
				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					description: 'Max number of results to return',
					default: 50,
					typeOptions: { minValue: 1, maxValue: 1000 },
					displayOptions: { show: { resource: ['sms'], operation: ['getAll'], returnAll: [false] } },
				},
				// ─── CUSTOM ACTIVITY ─────────────────────────────────────────────────────────────────
				{
					displayName: 'Operation',
					name: 'operation',
					type: 'options',
					noDataExpression: true,
					displayOptions: { show: { resource: ['customActivity'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a custom activity instance' },
					{ name: 'Delete', value: 'delete', action: 'Delete a custom activity instance' },
					{ name: 'Get', value: 'get', action: 'Get a custom activity instance' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many custom activity instances for a lead' },
					{ name: 'Update', value: 'update', action: 'Update a custom activity instance' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Custom Activity ID',
				name: 'customActivityId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['customActivity'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Lead ID',
				name: 'customActivityLeadId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['customActivity'], operation: ['create', 'getAll'] } },
			},
			{
				displayName: 'Activity Type Name or ID',
				name: 'activityTypeId',
				type: 'options',
				description: 'Required to load the correct custom fields. For update, set this to the activity type of the instance you are updating (e.g. from <code>$json.custom_activity_type_id</code>). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: { loadOptionsMethod: 'getCustomActivityTypes' },
				default: '',
				required: true,
				displayOptions: { show: { resource: ['customActivity'], operation: ['create', 'update'] } },
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['customActivity'], operation: ['getAll'] } },
				options: [
				{
					displayName: 'Custom Activity Type',
					name: 'custom_activity_type_id',
					type: 'options',
					default: '',
					description: 'Filter by a specific custom activity type',
					typeOptions: { loadOptionsMethod: 'getCustomActivityTypes' },
				},
					{
						displayName: 'Date Created After',
						name: 'date_created__gt',
						type: 'dateTime',
						default: '',
						description: 'Return instances created after this date/time (exclusive)',
					},
					{
						displayName: 'Date Created Before',
						name: 'date_created__lt',
						type: 'dateTime',
						default: '',
						description: 'Return instances created before this date/time (exclusive)',
					},
					],
				},
				// ─── Custom Field Filters (top-level fixedCollection) ─────────────────
				{
					displayName: 'Custom Field Filters',
					name: 'customFieldFilters',
					type: 'fixedCollection',
					typeOptions: { multipleValues: true },
					placeholder: 'Add Custom Field Filter',
					default: {},
					description: 'Filter results by custom field values (applied client-side). Select a Custom Activity Type in Filters first to populate the field dropdown.',
					displayOptions: { show: { resource: ['customActivity'], operation: ['getAll'] } },
					options: [
						{
							name: 'conditions',
							displayName: 'Condition',
							values: [
								{
									displayName: 'Field Name or ID',
									name: 'fieldId',
									type: 'options',
									typeOptions: {
										loadOptionsMethod: 'getCustomActivityFieldsForFilter',
										loadOptionsDependsOn: ['filters.custom_activity_type_id'],
									},
									description: 'The custom field to filter by. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
									default: '',
								},
								{
									displayName: 'Value',
									name: 'value',
									type: 'string',
									default: '',
									description: 'The value the custom field must equal (case-sensitive). For choice fields use the exact option label.',
								},
						],
					},
					],
				},
				{
					displayName: 'Return All',
					name: 'returnAll',
					type: 'boolean',
					description: 'Whether to return all results or only up to a given limit',
					default: false,
					displayOptions: { show: { resource: ['customActivity'], operation: ['getAll'] } },
				},
				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					description: 'Max number of results to return',
					default: 50,
					typeOptions: { minValue: 1, maxValue: 1000 },
					displayOptions: { show: { resource: ['customActivity'], operation: ['getAll'], returnAll: [false] } },
				},
				{
					displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['customActivity'], operation: ['create', 'update'] } },
				options: [
					{
						displayName: 'Activity At',
						name: 'activity_at',
						type: 'dateTime',
						default: '',
						description: 'When the activity occurred (defaults to now)',
					},
				],
			},
				{
					displayName: 'Custom Fields',
					name: 'customFields',
					type: 'resourceMapper',
					noDataExpression: true,
					default: { mappingMode: 'defineBelow', value: null },
					required: false,
					displayOptions: { show: { resource: ['customActivity'], operation: ['create', 'update'] } },
					typeOptions: {
						loadOptionsDependsOn: ['activityTypeId'],
						resourceMapper: {
							resourceMapperMethod: 'getCustomActivityCustomFieldsForMapper',
							mode: 'add',
							fieldWords: { singular: 'Custom Field', plural: 'Custom Fields' },
							addAllFields: true,
							supportAutoMap: false,
							valuesLabel: '',
							noFieldsError: 'No custom fields found. Select an Activity Type first.',
						},
					},
				},
			{
				displayName: 'Custom Fields to Clear',
				name: 'customFieldsToClear',
				type: 'multiOptions',
				default: [],
				displayOptions: { show: { resource: ['lead', 'contact', 'opportunity', 'customActivity'], operation: ['update'] } },
				typeOptions: {
					loadOptionsMethod: 'getCustomFieldsToClear',
					loadOptionsDependsOn: ['resource', 'activityTypeId'],
				},
				description: 'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},

			// ─── CUSTOM ACTIVITY TYPE ─────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['customActivityType'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a custom activity type' },
					{ name: 'Delete', value: 'delete', action: 'Delete a custom activity type' },
					{ name: 'Get', value: 'get', action: 'Get a custom activity type' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many custom activity types' },
					{ name: 'Update', value: 'update', action: 'Update a custom activity type' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Custom Activity Type ID',
				name: 'customActivityTypeId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['customActivityType'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Name',
				name: 'customActivityTypeName',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['customActivityType'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['customActivityType'], operation: ['create', 'update'] } },
				options: [
					{
						displayName: 'Description',
						name: 'description',
						type: 'string',
						default: '',
					},
					{
						displayName: 'API Create URL',
						name: 'api_create_url',
						type: 'string',
						default: '',
												description: 'Optional webhook URL called when an instance is created',
					},
				],
				},
				{
					displayName: 'Return All',
					name: 'returnAll',
					type: 'boolean',
					description: 'Whether to return all results or only up to a given limit',
					default: false,
					displayOptions: { show: { resource: ['customActivityType'], operation: ['getAll'] } },
				},
				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					description: 'Max number of results to return',
					default: 50,
					typeOptions: { minValue: 1, maxValue: 1000 },
					displayOptions: { show: { resource: ['customActivityType'], operation: ['getAll'], returnAll: [false] } },
				},
				// ─── COMMENT ──────────────────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['comment'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a comment' },
					{ name: 'Delete', value: 'delete', action: 'Delete a comment' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many comments for a lead' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Lead ID',
				name: 'leadId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['comment'], operation: ['create', 'getAll'] } },
			},
			{
				displayName: 'Comment ID',
				name: 'commentId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['comment'], operation: ['delete'] } },
			},
			{
				displayName: 'Note',
				name: 'note',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['comment'], operation: ['create'] } },
				},
				{
					displayName: 'Return All',
					name: 'returnAll',
					type: 'boolean',
					description: 'Whether to return all results or only up to a given limit',
					default: false,
					displayOptions: { show: { resource: ['comment'], operation: ['getAll'] } },
				},
				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					description: 'Max number of results to return',
					default: 50,
					typeOptions: { minValue: 1, maxValue: 1000 },
					displayOptions: { show: { resource: ['comment'], operation: ['getAll'], returnAll: [false] } },
				},

				// ─── EMAIL TEMPLATE ─────────────────────────────────────────────────────────────────
				{
					displayName: 'Operation',
					name: 'operation',
					type: 'options',
					noDataExpression: true,
					displayOptions: { show: { resource: ['emailTemplate'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create an email template' },
					{ name: 'Delete', value: 'delete', action: 'Delete an email template' },
					{ name: 'Get', value: 'get', action: 'Get an email template' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many email templates' },
					{ name: 'Update', value: 'update', action: 'Update an email template' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Template ID',
				name: 'templateId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['emailTemplate'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['emailTemplate'], operation: ['create'] } },
			},
			{
				displayName: 'Subject',
				name: 'subject',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['emailTemplate'], operation: ['create'] } },
			},
			{
				displayName: 'Body HTML',
				name: 'body_html',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['emailTemplate'], operation: ['create'] } },
				description: 'HTML body of the email template',
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['emailTemplate'], operation: ['update'] } },
				options: [
					{ displayName: 'Name', name: 'name', type: 'string', default: '' },
					{ displayName: 'Subject', name: 'subject', type: 'string', default: '' },
										{ displayName: 'Body HTML', name: 'body_html', type: 'string', default: '' },
				],
				},
				{
					displayName: 'Return All',
					name: 'returnAll',
					type: 'boolean',
					description: 'Whether to return all results or only up to a given limit',
					default: false,
					displayOptions: { show: { resource: ['emailTemplate'], operation: ['getAll'] } },
				},
				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					description: 'Max number of results to return',
					default: 50,
					typeOptions: { minValue: 1, maxValue: 1000 },
					displayOptions: { show: { resource: ['emailTemplate'], operation: ['getAll'], returnAll: [false] } },
				},

				// ─── SMART VIEW ───────────────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['smartView'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a smart view' },
					{ name: 'Delete', value: 'delete', action: 'Delete a smart view' },
					{ name: 'Get', value: 'get', action: 'Get a smart view' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many smart views' },
					{ name: 'Get Leads', value: 'getLeads', action: 'Get leads from a smart view' },
					{ name: 'Update', value: 'update', action: 'Update a smart view' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Smart View ID',
				name: 'smartViewId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['smartView'], operation: ['get', 'update', 'delete', 'getLeads'] } },
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['smartView'], operation: ['create'] } },
			},
			{
				displayName: 'Owner Name or ID',
				name: 'smartViewOwnerId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getUsers' },
				default: '',
				description: 'The Close user who owns this Smart View. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: { show: { resource: ['smartView'], operation: ['create', 'update'] } },
			},
			{
				displayName: 'Query (JSON)',
				name: 's_query',
				type: 'json',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['smartView'], operation: ['create'] } },
				description: 'Structured Smart View query. You can enter JSON directly or use an expression that returns a JSON object.',
			},
			{
				displayName: 'Sharing Settings',
				name: 'sharingSettings',
				type: 'collection',
				placeholder: 'Add Sharing Setting',
				default: {},
				displayOptions: { show: { resource: ['smartView'], operation: ['create', 'update'] } },
				options: [
					{
						displayName: 'Share with Entire Organization',
						name: 'whole_org',
						type: 'boolean',
						default: false,
						description: 'Whether every user in the Close organization can access this Smart View',
					},
					{
						displayName: 'Share with Groups',
						name: 'group_ids',
						type: 'multiOptions',
						typeOptions: { loadOptionsMethod: 'getGroups' },
						default: [],
						description: 'The Close groups that can access this Smart View. Updating sharing replaces the previous group and user recipients.',
					},
					{
						displayName: 'Share with Users',
						name: 'user_ids',
						type: 'multiOptions',
						typeOptions: { loadOptionsMethod: 'getUsers' },
						default: [],
						description: 'The individual Close users who can access this Smart View. Updating sharing replaces the previous group and user recipients.',
					},
				],
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['smartView'], operation: ['update'] } },
				options: [
						{ displayName: 'Name', name: 'name', type: 'string', default: '' },
						{ displayName: 'Query (JSON)', name: 's_query', type: 'json', default: '' },
				],
				},
				{
					displayName: 'Return All',
					name: 'returnAll',
					type: 'boolean',
					description: 'Whether to return all results or only up to a given limit',
					default: false,
					displayOptions: { show: { resource: ['smartView'], operation: ['getAll'] } },
				},
				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					description: 'Max number of results to return',
					default: 50,
					typeOptions: { minValue: 1, maxValue: 1000 },
					displayOptions: { show: { resource: ['smartView'], operation: ['getAll'], returnAll: [false] } },
				},

				// ─── USER ─────────────────────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['user'] } },
				options: [
					{ name: 'Get', value: 'get', action: 'Get a user by ID' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many users' },
					{ name: 'Get Me', value: 'getMe', action: 'Get current user' },
			],
				default: 'getAll',
			},
			{
				displayName: 'User ID',
				name: 'userId',
				type: 'string',
				default: '',
				required: true,
				description: 'The ID of the user to retrieve (e.g. user_abc123)',
				displayOptions: { show: { resource: ['user'], operation: ['get'] } },
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['user'], operation: ['getAll'] } },
				options: [
					{
						displayName: 'Status',
						name: 'is_active',
						type: 'options',
						default: '',
						options: [
							{ name: 'All', value: '' },
							{ name: 'Active', value: 'true' },
							{ name: 'Inactive', value: 'false' },
						],
													description: 'Close has no server-side status filter. Active returns users with organization membership; Inactive returns inactive organization memberships.',
					},
				],
				},
				{
					displayName: 'Return All',
					name: 'returnAll',
					type: 'boolean',
					description: 'Whether to return all results or only up to a given limit',
					default: false,
					displayOptions: { show: { resource: ['user'], operation: ['getAll'] } },
				},
				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					description: 'Max number of results to return',
					default: 50,
					typeOptions: { minValue: 1, maxValue: 1000 },
					displayOptions: { show: { resource: ['user'], operation: ['getAll'], returnAll: [false] } },
				},

				// ─── CUSTOM FIELD ─────────────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['customField'] } },
				options: [
					{ name: 'Add Dropdown Option', value: 'addChoice', action: 'Add an option to a dropdown custom field' },
					{ name: 'Associate Shared Field', value: 'associateShared', action: 'Associate a shared custom field with an object type' },
					{ name: 'Create', value: 'create', action: 'Create a custom field' },
					{ name: 'Delete', value: 'delete', action: 'Delete a custom field' },
					{ name: 'Get', value: 'get', action: 'Get a custom field' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many custom fields' },
					{ name: 'Update', value: 'update', action: 'Update a custom field' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Object Type',
				name: 'objectType',
				type: 'options',
				options: [
					{ name: 'Contact', value: 'contact' },
					{ name: 'Lead', value: 'lead' },
					{ name: 'Opportunity', value: 'opportunity' },
					{ name: 'Shared Field', value: 'shared' },
				],
				default: 'lead',
				required: true,
				displayOptions: { show: { resource: ['customField'] } },
			},
			{
				displayName: 'Custom Field ID',
				name: 'customFieldId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['customField'], operation: ['get', 'update', 'delete', 'addChoice', 'associateShared'] } },
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['customField'], operation: ['create'] } },
			},
			{
				displayName: 'Field Type',
				name: 'fieldType',
				type: 'options',
				options: [
					{ name: 'Text', value: 'text' },
					{ name: 'Number', value: 'number' },
					{ name: 'Date', value: 'date' },
					{ name: 'Datetime', value: 'datetime' },
					{ name: 'Choices', value: 'choices' },
					{ name: 'User', value: 'user' },
					{ name: 'Contact', value: 'contact' },
				],
				default: 'text',
				required: true,
				displayOptions: { show: { resource: ['customField'], operation: ['create'] } },
			},
			{
				displayName: 'Dropdown Options',
				name: 'choiceValues',
				type: 'fixedCollection',
				placeholder: 'Add Option',
				default: {},
				typeOptions: { multipleValues: true },
				displayOptions: { show: { resource: ['customField'], operation: ['create'], fieldType: ['choices'] } },
				options: [
					{
						name: 'values',
						displayName: 'Option',
						values: [
							{ displayName: 'Option', name: 'value', type: 'string', default: '', required: true },
						],
					},
				],
			},
			{
				displayName: 'Object Types to Associate',
				name: 'sharedFieldAssociations',
				type: 'multiOptions',
				default: [],
				description: 'The object types that can use the Shared Custom Field. You can add further associations in Close later.',
				options: [
					{ name: 'Contact', value: 'contact' },
					{ name: 'Lead', value: 'lead' },
					{ name: 'Opportunity', value: 'opportunity' },
				],
				displayOptions: { show: { resource: ['customField'], operation: ['create'], objectType: ['shared'] } },
			},
			{
				displayName: 'Object Type to Associate',
				name: 'sharedFieldAssociationType',
				type: 'options',
				default: 'lead',
				options: [
					{ name: 'Contact', value: 'contact' },
					{ name: 'Lead', value: 'lead' },
					{ name: 'Opportunity', value: 'opportunity' },
				],
				displayOptions: { show: { resource: ['customField'], operation: ['associateShared'], objectType: ['shared'] } },
			},
			{
				displayName: 'Dropdown Option',
				name: 'choiceValue',
				type: 'string',
				default: '',
				required: true,
				description: 'The new allowed value to add to the dropdown custom field. Existing options are preserved.',
				displayOptions: { show: { resource: ['customField'], operation: ['addChoice'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['customField'], operation: ['update'] } },
				options: [
					{ displayName: 'Name', name: 'name', type: 'string', default: '' },
											{ displayName: 'Description', name: 'description', type: 'string', default: '' },
				],
				},
				{
					displayName: 'Return All',
					name: 'returnAll',
					type: 'boolean',
					description: 'Whether to return all results or only up to a given limit',
					default: false,
					displayOptions: { show: { resource: ['customField'], operation: ['getAll'] } },
				},
				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					description: 'Max number of results to return',
					default: 50,
					typeOptions: { minValue: 1, maxValue: 1000 },
					displayOptions: { show: { resource: ['customField'], operation: ['getAll'], returnAll: [false] } },
				},

				// ─── INTEGRATION LINK ─────────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['integrationLink'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create an integration link' },
					{ name: 'Delete', value: 'delete', action: 'Delete an integration link' },
					{ name: 'Get', value: 'get', action: 'Get an integration link' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many integration links' },
					{ name: 'Update', value: 'update', action: 'Update an integration link' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Integration Link ID',
				name: 'integrationLinkId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['integrationLink'], operation: ['get', 'update', 'delete'] } },
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['integrationLink'], operation: ['create'] } },
			},
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['integrationLink'], operation: ['create'] } },
				description: 'URL template for the integration link. Use {{lead.ID}} etc. as placeholders.',
			},
			{
				displayName: 'Link Type',
				name: 'linkType',
				type: 'options',
				options: [
					{ name: 'Lead', value: 'lead' },
					{ name: 'Contact', value: 'contact' },
					{ name: 'Opportunity', value: 'opportunity' },
				],
				default: 'lead',
				required: true,
				displayOptions: { show: { resource: ['integrationLink'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['integrationLink'], operation: ['update'] } },
				options: [
					{ displayName: 'Name', name: 'name', type: 'string', default: '' },
					{ displayName: 'URL', name: 'url', type: 'string', default: '' },
				],
				},
				{
					displayName: 'Return All',
					name: 'returnAll',
					type: 'boolean',
					description: 'Whether to return all results or only up to a given limit',
					default: false,
					displayOptions: { show: { resource: ['integrationLink'], operation: ['getAll'] } },
				},
				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					description: 'Max number of results to return',
					default: 50,
					typeOptions: { minValue: 1, maxValue: 1000 },
					displayOptions: { show: { resource: ['integrationLink'], operation: ['getAll'], returnAll: [false] } },
				},
			...apiRequestProperties,
			...upsertProperties,
			...customFieldUpdateProperties,
			],
			usableAsTool: true,
	};

	methods = {
		loadOptions: {
            async getMultiValueCustomFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
                const resource=this.getCurrentNodeParameter('resource') as string;
                const type=resource==='customActivity' ? `activity/${encodeURIComponent(String(this.getCurrentNodeParameter('activityTypeId') || ''))}` : resource;
                if (type==='activity/') return [];
                const schema=await closeApiRequest.call(this,'GET',`/custom_field_schema/${type}/`);
                if (!Array.isArray(schema.fields)) throw new NodeOperationError(this.getNode(), 'Invalid Close custom field schema');
                return schema.fields.filter((f: IDataObject)=>f.accepts_multiple_values).map((f: IDataObject)=>({name:String(f.name),value:String(f.id)}));
            },
            async getMultiValueCustomFieldOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
                const resource=this.getCurrentNodeParameter('resource') as string;
                const fieldId=this.getCurrentNodeParameter('&field') as string;
                if (!fieldId) return [];
                const type=resource==='customActivity' ? `activity/${encodeURIComponent(String(this.getCurrentNodeParameter('activityTypeId') || ''))}` : resource;
                const schema=await closeApiRequest.call(this,'GET',`/custom_field_schema/${type}/`);
                if (!Array.isArray(schema.fields)) throw new NodeOperationError(this.getNode(), 'Invalid Close custom field schema');
                const field=schema.fields.find((f: IDataObject)=>f.id===fieldId);
                if (!field) throw new NodeOperationError(this.getNode(), 'Select a valid custom field');
                if (field.type==='user') return (await closeApiRequestAllItems.call(this,'GET','/user/')).map((u: IDataObject)=>({name:String(u.first_name || '')+' '+String(u.last_name || ''),value:String(u.id)}));
                return (field.choices || []).map((value: string)=>({name:value,value}));
            },

			async getUpsertMatchFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const resource = this.getCurrentNodeParameter('resource') as UpsertResource;
				const schema = await closeApiRequest.call(this, 'GET', `/custom_field_schema/${resource}/`);
				const options: INodePropertyOptions[] = [
					{ name: 'ID', value: 'id' },
					...standardFields[resource].filter(f => !['emails', 'phones', 'urls'].includes(f)).map(f => ({ name: f, value: f })),
					...((schema.fields || []) as IDataObject[]).map(f => ({ name: `Custom: ${f.name}`, value: `custom.${f.id}` })),
				];
				if (resource === 'contact') options.push({ name: 'Email', value: 'email' }, { name: 'Phone', value: 'phone' });
				if (resource === 'lead') {
					const contactSchema = await closeApiRequest.call(this, 'GET', '/custom_field_schema/contact/');
					options.push({ name: 'Contact: Email', value: 'contact.email' }, { name: 'Contact: Phone', value: 'contact.phone' },
						...((contactSchema.fields || []) as IDataObject[]).map(f => ({ name: `Contact custom: ${f.name}`, value: `contact.custom.${f.id}` })));
				}
				return options;
			},

			async getCustomFieldsToClear(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const resource = this.getCurrentNodeParameter('resource') as string;
				let schemaType = resource;
				if (resource === 'customActivity') {
					const activityTypeId = this.getCurrentNodeParameter('activityTypeId') as string;
					if (!activityTypeId) return [];
					schemaType = `activity/${encodeURIComponent(activityTypeId)}`;
				}
				const schema = await closeApiRequest.call(this, 'GET', `/custom_field_schema/${schemaType}/`);
				return ((schema.fields || []) as IDataObject[]).map((field) => ({
					name: field.name as string,
					value: field.id as string,
				}));
			},

			async getLeadStatuses(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = await closeApiRequest.call(this, 'GET', '/status/lead/');
				return (response.data || []).map((s: IDataObject) => ({
					name: s.label as string,
					value: s.id as string,
				}));
			},
			async getOpportunityStatuses(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = await closeApiRequest.call(this, 'GET', '/status/opportunity/');
				return (response.data || []).map((s: IDataObject) => ({
					name: s.label as string,
					value: s.id as string,
				}));
			},
			async getPipelinesForUpsert(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = await closeApiRequest.call(this, 'GET', '/pipeline/');
				return (response.data || []).map((p: IDataObject) => ({
					name: p.name as string,
					value: p.id as string,
				}));
			},
			async getCustomActivityTypes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = await closeApiRequest.call(this, 'GET', '/custom_activity/');
				return (response.data || []).map((t: IDataObject) => ({
					name: t.name as string,
					value: t.id as string,
				}));
			},
							async getUsers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
					const response = await closeApiRequest.call(this, 'GET', '/user/');
					return (response.data || []).map((u: IDataObject) => ({
						name: `${u.first_name} ${u.last_name}`.trim() || (u.email as string),
						value: u.id as string,
					}));
				},
				async getGroups(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
					const response = await closeApiRequest.call(this, 'GET', '/group/', {}, { _fields: 'name' });
					return (response.data || []).map((group: IDataObject) => ({
						name: group.name as string,
						value: group.id as string,
					}));
				},
				async getEmailTemplates(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = await closeApiRequest.call(this, 'GET', '/email_template/');
				return (response.data || []).map((t: IDataObject) => ({
					name: t.name as string,
					value: t.id as string,
				}));
			},
			async getLeadCustomFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = await closeApiRequest.call(this, 'GET', '/custom_field/lead/');
				return (response.data || []).map((f: IDataObject) => ({
					name: f.name as string,
					value: f.id as string,
				}));
			},
			async getContactCustomFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = await closeApiRequest.call(this, 'GET', '/custom_field/contact/');
				return (response.data || []).map((f: IDataObject) => ({
					name: f.name as string,
					value: f.id as string,
				}));
			},
			async getOpportunityCustomFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = await closeApiRequest.call(this, 'GET', '/custom_field/opportunity/');
				return (response.data || []).map((f: IDataObject) => ({
					name: f.name as string,
					value: f.id as string,
				}));
			},
				async getCustomActivityCustomFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
					const activityTypeId = this.getCurrentNodeParameter('activityTypeId', { extractValue: true }) as string | undefined;
					if (!activityTypeId) return [];
					const [activityType, sharedResp] = await Promise.all([
						closeApiRequest.call(this, 'GET', `/custom_activity/${activityTypeId}/`),
						closeApiRequest.call(this, 'GET', '/custom_field/shared/'),
					]);
					const typeFields = (activityType.fields || []) as IDataObject[];
					const sharedFields = filterSharedFields(sharedResp.data || [], 'custom_activity_type', activityTypeId);
					const fields = [...typeFields, ...sharedFields].filter((field, index, allFields) =>
						allFields.findIndex((candidate) => candidate.id === field.id) === index,
					);
					return fields.map((field: IDataObject) => ({
						name: field.name as string,
						value: field.id as string,
					}));
				},
				async getCustomActivityFieldsForFilter(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
					// Read the selected activity type from the Filters collection.
					let activityTypeId: string | undefined;
					try {
						const filtersParam = this.getNodeParameter('filters') as IDataObject;
						activityTypeId = filtersParam?.custom_activity_type_id as string | undefined;
					} catch {
						activityTypeId = undefined;
					}
					if (!activityTypeId) return [];
					const [activityType, sharedResp] = await Promise.all([
						closeApiRequest.call(this, 'GET', `/custom_activity/${activityTypeId}/`),
						closeApiRequest.call(this, 'GET', '/custom_field/shared/'),
					]);
					const typeFields = (activityType.fields || []) as IDataObject[];
					const sharedFields = filterSharedFields(sharedResp.data || [], 'custom_activity_type', activityTypeId);
					const fields = [...typeFields, ...sharedFields].filter((field, index, allFields) =>
						allFields.findIndex((candidate) => candidate.id === field.id) === index,
					);
					return fields.map((field: IDataObject) => ({
						name: field.name as string,
						value: field.id as string,
					}));
				},
		},

			resourceMapping: {
				async getUpsertWriteFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
					const resource = this.getCurrentNodeParameter('resource') as UpsertResource;
					const schema = await closeApiRequest.call(this, 'GET', `/custom_field_schema/${resource}/`);
					const definitions = (schema.fields || []) as IDataObject[];
					const mapped = buildResourceMapperFields(definitions).fields;
					const needsUsers = resource === 'opportunity' || definitions.some(f => f.type === 'user' && !f.accepts_multiple_values);
					const users = needsUsers ? await closeApiRequestAllItems.call(this, 'GET', '/user/') : [];
					const userOptions = users.map((u: IDataObject) => ({ name: String(u.first_name || '') + ' ' + String(u.last_name || ''), value: String(u.id) }));
					const statusOptions = resource !== 'contact' ? ((await closeApiRequest.call(this, 'GET', `/status/${resource}/`)).data || []).map((s: IDataObject) => ({ name: String(s.label), value: String(s.id) })) : [];
					const fields: ResourceMapperField[] = standardFields[resource].map(f => ({
						id: f, displayName: f, required: false, defaultMatch: false, display: true,
						type: ['value', 'confidence'].includes(f) ? 'number' : ['emails', 'phones', 'urls'].includes(f) ? 'array' : ['status_id', 'user_id'].includes(f) ? 'options' : 'string',
						...(f === 'status_id' ? { options: statusOptions } : {}), ...(f === 'user_id' ? { options: userOptions } : {}),
					}));
					for (let index = 0; index < mapped.length; index++) {
						const field = mapped[index]; const def = definitions[index];
						fields.push({ ...field, id: `custom.${field.id}`,
							...(def.accepts_multiple_values ? { type: 'array' as const, options: undefined } : def.type === 'date' ? { type: 'string' as const } : def.type === 'user' ? { type: 'options' as const, options: userOptions } : {}),
						});
					}
					return { fields };
				},

				async getLeadCustomFieldsForMapper(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
					const [leadResp, sharedResp] = await Promise.all([
						closeApiRequest.call(this, 'GET', '/custom_field/lead/'),
						closeApiRequest.call(this, 'GET', '/custom_field/shared/'),
					]);
					const leadFields = leadResp.data || [];
					const sharedForLead = filterSharedFields(sharedResp.data || [], 'lead');
					return enrichCustomFieldMapper(this, [...leadFields, ...sharedForLead]);
				},
				async getContactCustomFieldsForMapper(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
					const [contactResp, sharedResp] = await Promise.all([
						closeApiRequest.call(this, 'GET', '/custom_field/contact/'),
						closeApiRequest.call(this, 'GET', '/custom_field/shared/'),
					]);
					const contactFields = contactResp.data || [];
					const sharedForContact = filterSharedFields(sharedResp.data || [], 'contact');
					return enrichCustomFieldMapper(this, [...contactFields, ...sharedForContact]);
				},
				async getOpportunityCustomFieldsForMapper(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
					const [oppResp, sharedResp] = await Promise.all([
						closeApiRequest.call(this, 'GET', '/custom_field/opportunity/'),
						closeApiRequest.call(this, 'GET', '/custom_field/shared/'),
					]);
					const oppFields = oppResp.data || [];
					const sharedForOpp = filterSharedFields(sharedResp.data || [], 'opportunity');
					return enrichCustomFieldMapper(this, [...oppFields, ...sharedForOpp]);
				},
				async getCustomActivityCustomFieldsForMapper(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
					const activityTypeId = this.getCurrentNodeParameter('activityTypeId', { extractValue: true }) as string | undefined;
					if (!activityTypeId) return { fields: [] };
					// The selected type endpoint is the authoritative source for all of its regular fields.
					const [activityType, sharedResp] = await Promise.all([
						closeApiRequest.call(this, 'GET', `/custom_activity/${activityTypeId}/`),
						closeApiRequest.call(this, 'GET', '/custom_field/shared/'),
					]);
					const typeFields = (activityType.fields || []) as IDataObject[];
					const sharedFields = filterSharedFields(sharedResp.data || [], 'custom_activity_type', activityTypeId);
					const fields = [...typeFields, ...sharedFields].filter((field, index, allFields) =>
						allFields.findIndex((candidate) => candidate.id === field.id) === index,
					);
					return enrichCustomFieldMapper(this, fields);
				},
			},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				let responseData: IDataObject | IDataObject[] = [];

				if (resource === 'apiRequest') {
					const result = await executeApiRequest.call(this, i);
					for (const row of Array.isArray(result) ? result : [result]) returnData.push({json: row, pairedItem: {item:i}});
					continue;
				}
				if (operation === 'upsertByFields') {
					const keys = this.getNodeParameter('upsertMatchKeys', i, {}) as { keys?: MatchKey[] };
					const mapper = this.getNodeParameter('upsertValues', i, {}) as IDataObject;
					responseData = await upsertRecord(
						(method, path, body) => closeApiRequest.call(this, method, path, body),
						{ resource: resource as UpsertResource, matchKeys: keys.keys || [], values: (mapper.value || {}) as IDataObject,
							leadId: this.getNodeParameter('upsertLeadId', i, '') as string,
							pipelineId: this.getNodeParameter('upsertPipelineId', i, '') as string,
							updateMode: this.getNodeParameter('upsertUpdateMode', i, 'replace') as 'replace' | 'fillEmpty',
							preview: this.getNodeParameter('upsertPreview', i, true) as boolean,
							multipleMatches: this.getNodeParameter('upsertMultipleMatches', i, 'error') as 'error' | 'first' | 'returnAll',
						},
					);
					if (responseData.action === 'multiple_matches') {
						const { records, ...metadata } = responseData;
						for (const record of records as IDataObject[]) returnData.push({ json: { ...metadata, id: record.id, record }, pairedItem: { item: i } });
					} else {
						returnData.push({ json: responseData, pairedItem: { item: i } });
					}
					continue;
				}

				// ── LEAD ──────────────────────────────────────────────────────────────
				if (resource === 'lead') {
					if (operation === 'get') {
						const leadId = this.getNodeParameter('leadId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/lead/${leadId}/`);
					} else if (operation === 'getAll') {
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						if (returnAll) {
							responseData = await closeApiRequestAllItems.call(this, 'GET', '/lead/');
						} else {
							const limit = this.getNodeParameter('limit', i) as number;
							const res = await closeApiRequest.call(this, 'GET', '/lead/', {}, { _limit: limit });
							responseData = res.data || [];
						}
				} else if (operation === 'search') {
					const query = this.getNodeParameter('query', i, '') as string;
					const advancedQueryRaw = this.getNodeParameter('advancedQuery', i, '') as string;
					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const limit = returnAll ? undefined : this.getNodeParameter('limit', i) as number;

					if (advancedQueryRaw && advancedQueryRaw.trim() !== '') {
						// Advanced structured query — use POST /data/search/
						let parsed: IDataObject;
						try {
							parsed = typeof advancedQueryRaw === 'string' ? JSON.parse(advancedQueryRaw) : advancedQueryRaw as IDataObject;
						} catch {
								throw new NodeOperationError(this.getNode(), 'Advanced Query (JSON) must be valid JSON', { itemIndex: i });
						}
						// Support both formats:
						// 1. Smart View s_query format: { query: {...}, results_limit, sort }
						// 2. Direct query format: { type: 'and', queries: [...] }
						let queryObj: IDataObject;
						if (parsed.query) {
							// Already wrapped — use as-is
							queryObj = parsed.query as IDataObject;
						} else {
							// Bare query object
							queryObj = parsed;
						}
						const searchBody: IDataObject = {
							query: queryObj,
							_limit: 100, // page size — fetch 100 per request for efficiency
							sort: (parsed.sort as IDataObject[]) || [],
							_fields: { lead: ['id', 'display_name', 'name', 'status_id', 'status_label', 'contacts', 'addresses', 'description', 'url', 'date_created', 'date_updated', 'created_by', 'updated_by', 'organization_id', 'opportunities', 'html_url', 'custom'] },
						};
						if (returnAll) {
							// Paginate through all results using cursor-based pagination (no results_limit cap)
							const allLeads: IDataObject[] = [];
							let cursor: string | undefined;
							do {
								if (cursor) searchBody.cursor = cursor;
								const res = await closeApiRequest.call(this, 'POST', '/data/search/', searchBody);
								const leads = (res.data || []) as IDataObject[];
								allLeads.push(...leads);
								cursor = res.cursor as string | undefined;
							} while (cursor);
							responseData = allLeads;
						} else {
							// results_limit caps the total returned; _limit controls page size
							searchBody.results_limit = limit!;
							const res = await closeApiRequest.call(this, 'POST', '/data/search/', searchBody);
							responseData = res.data || [];
						}
					} else {
						// Simple text search — use GET /lead/?query=...
						if (returnAll) {
							responseData = await closeApiRequestAllItems.call(this, 'GET', '/lead/', {}, { query });
						} else {
							const res = await closeApiRequest.call(this, 'GET', '/lead/', {}, { query, _limit: limit });
							responseData = res.data || [];
						}
					}
				} else if (operation === 'create') {
					const companyName = this.getNodeParameter('companyName', i) as string;
					const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
					const body: IDataObject = { name: companyName };
					if (additionalFields.description) body.description = additionalFields.description;
					if (additionalFields.status_id) body.status_id = additionalFields.status_id;
					if (additionalFields.url) body.url = additionalFields.url;
					const cfMapper = this.getNodeParameter('customFields', i, {}) as IDataObject;
					const cfValue = (cfMapper?.value ?? {}) as IDataObject;
					for (const [k, v] of Object.entries(cfValue)) {
						if (v !== null && v !== undefined && v !== '') {
							body[`custom.${k}`] = v;
						}
					}
					// Inline contact creation
					const contactName = additionalFields.contact_name as string | undefined;
					const contactEmail = additionalFields.contact_email as string | undefined;
					const contactPhone = additionalFields.contact_phone as string | undefined;
					if (contactName || contactEmail || contactPhone) {
						const contact: IDataObject = {};
						if (contactName) contact.name = contactName;
						if (contactEmail) contact.emails = [{ email: contactEmail, type: 'office' }];
						if (contactPhone) contact.phones = [{ phone: contactPhone, type: 'office' }];
						body.contacts = [contact];
					}
					responseData = await closeApiRequest.call(this, 'POST', '/lead/', body);
				} else if (operation === 'update') {
					const leadId = this.getNodeParameter('leadId', i) as string;
					const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
					const body: IDataObject = {};
					if (additionalFields.description) body.description = additionalFields.description;
					if (additionalFields.status_id) body.status_id = additionalFields.status_id;
					if (additionalFields.url) body.url = additionalFields.url;
					const cfMapper = this.getNodeParameter('customFields', i, {}) as IDataObject;
					const cfValue = (cfMapper?.value ?? {}) as IDataObject;
					for (const [k, v] of Object.entries(cfValue)) {
												if (v !== null && v !== undefined && v !== '') {
													body[`custom.${k}`] = v;
												}
											}
					applyCustomFieldClears(body, this.getNodeParameter('customFieldsToClear', i, []) as string[]);
					await applyCustomFieldUpdates.call(this, body, i, `/lead/${leadId}/`);
					responseData = await closeApiRequest.call(this, 'PUT', `/lead/${leadId}/`, body);
					} else if (operation === 'delete') {
						const leadId = this.getNodeParameter('leadId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/lead/${leadId}/`);
						responseData = { success: true };
					} else if (operation === 'merge') {
						const leadId = this.getNodeParameter('leadId', i) as string;
						const sourceLeadId = this.getNodeParameter('sourceLeadId', i) as string;
						responseData = await closeApiRequest.call(this, 'POST', '/lead/merge/', {
							destination: leadId,
							source: sourceLeadId,
						});
					}
				}

				// ── LEAD STATUS ───────────────────────────────────────────────────────
				else if (resource === 'leadStatus') {
					if (operation === 'getAll') {
						const res = await closeApiRequest.call(this, 'GET', '/status/lead/');
						responseData = res.data || [];
					} else if (operation === 'get') {
						const id = this.getNodeParameter('leadStatusId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/status/lead/${id}/`);
					} else if (operation === 'create') {
						const label = this.getNodeParameter('label', i) as string;
						responseData = await closeApiRequest.call(this, 'POST', '/status/lead/', { label });
					} else if (operation === 'update') {
						const id = this.getNodeParameter('leadStatusId', i) as string;
						const label = this.getNodeParameter('label', i) as string;
						responseData = await closeApiRequest.call(this, 'PUT', `/status/lead/${id}/`, { label });
					} else if (operation === 'delete') {
						const id = this.getNodeParameter('leadStatusId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/status/lead/${id}/`);
						responseData = { success: true };
					}
				}

				// ── CONTACT ───────────────────────────────────────────────────────────
				else if (resource === 'contact') {
					if (operation === 'get') {
						const contactId = this.getNodeParameter('contactId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/contact/${contactId}/`);
					} else if (operation === 'getAll') {
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						if (returnAll) {
							responseData = await closeApiRequestAllItems.call(this, 'GET', '/contact/');
						} else {
							const limit = this.getNodeParameter('limit', i) as number;
							const res = await closeApiRequest.call(this, 'GET', '/contact/', {}, { _limit: limit });
							responseData = res.data || [];
						}
				} else if (operation === 'create') {
					const leadId = this.getNodeParameter('leadId', i) as string;
					const name = this.getNodeParameter('name', i) as string;
					const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
					const body: IDataObject = { lead_id: leadId, name };
					if (additionalFields.title) body.title = additionalFields.title;
					if (additionalFields.phones) {
						const phoneItems = (additionalFields.phones as IDataObject).phoneValues as IDataObject[] || [];
						if (phoneItems.length) body.phones = phoneItems.map((p) => ({ phone: p.phone, type: p.type }));
					}
					if (additionalFields.emails) {
						const emailItems = (additionalFields.emails as IDataObject).emailValues as IDataObject[] || [];
						if (emailItems.length) body.emails = emailItems.map((e) => ({ email: e.email, type: e.type }));
					}
					const cfMapper = this.getNodeParameter('customFields', i, {}) as IDataObject;
					const cfValue = (cfMapper?.value ?? {}) as IDataObject;
					for (const [k, v] of Object.entries(cfValue)) {
												if (v !== null && v !== undefined && v !== '') {
													body[`custom.${k}`] = v;
												}
											}
					responseData = await closeApiRequest.call(this, 'POST', '/contact/', body);
				} else if (operation === 'update') {
					const contactId = this.getNodeParameter('contactId', i) as string;
					const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
					const body: IDataObject = {};
					if (additionalFields.name) body.name = additionalFields.name;
					if (additionalFields.title) body.title = additionalFields.title;
						let existingContact: IDataObject | undefined;
						const getExistingContact = async (): Promise<IDataObject> => {
							if (!existingContact) {
								existingContact = await closeApiRequest.call(this, 'GET', `/contact/${contactId}/`);
							}
							return existingContact as IDataObject;
						};
						if (additionalFields.phones) {
							const phoneItems = (additionalFields.phones as IDataObject).phoneValues as IDataObject[] || [];
							const updateModeArr = (additionalFields.phones as IDataObject).updateMode as IDataObject[] || [];
							const phoneUpdateMode = updateModeArr.length > 0 ? (updateModeArr[0].phoneUpdateMode as string) : 'add';
							if (phoneItems.length) {
								const newPhones = phoneItems.map((p) => ({ phone: p.phone, type: p.type }));
								if (phoneUpdateMode === 'replace') {
									body.phones = newPhones;
								} else {
									const existing = await getExistingContact();
									const existingPhones = (existing.phones || []) as IDataObject[];
									const existingNumbers = new Set(existingPhones.map((phone) => String(phone.phone || '').replace(/[^\d+]/g, '')));
									const deduped = newPhones.filter((phone) => {
										const number = String(phone.phone || '').replace(/[^\d+]/g, '');
										if (existingNumbers.has(number)) return false;
										existingNumbers.add(number);
										return true;
									});
									body.phones = [...deduped, ...existingPhones];
								}
							}
						}
						if (additionalFields.emails) {
							const emailItems = (additionalFields.emails as IDataObject).emailValues as IDataObject[] || [];
							const updateModeArr = (additionalFields.emails as IDataObject).updateMode as IDataObject[] || [];
							const emailUpdateMode = updateModeArr.length > 0 ? (updateModeArr[0].emailUpdateMode as string) : 'add';
							if (emailItems.length) {
								const newEmails = emailItems.map((e) => ({ email: e.email, type: e.type }));
								if (emailUpdateMode === 'replace') {
									body.emails = newEmails;
								} else {
									// Add mode: fetch existing contact, prepend new emails at the front (highest priority).
									const existing = await getExistingContact();
									const existingEmails = (existing.emails || []) as IDataObject[];
									const existingAddresses = new Set(existingEmails.map((email) => String(email.email || '').toLowerCase()));
									const deduped = newEmails.filter((email) => {
										const address = String(email.email || '').toLowerCase();
										if (existingAddresses.has(address)) return false;
										existingAddresses.add(address);
										return true;
									});
									body.emails = [...deduped, ...existingEmails];
								}
							}
						}
					const cfMapper = this.getNodeParameter('customFields', i, {}) as IDataObject;
					const cfValue = (cfMapper?.value ?? {}) as IDataObject;
					for (const [k, v] of Object.entries(cfValue)) {
												if (v !== null && v !== undefined && v !== '') {
													body[`custom.${k}`] = v;
												}
											}
					applyCustomFieldClears(body, this.getNodeParameter('customFieldsToClear', i, []) as string[]);
					await applyCustomFieldUpdates.call(this, body, i, `/contact/${contactId}/`);
					responseData = await closeApiRequest.call(this, 'PUT', `/contact/${contactId}/`, body);
					} else if (operation === 'delete') {
						const contactId = this.getNodeParameter('contactId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/contact/${contactId}/`);
						responseData = { success: true };
					}
				}

				// ── OPPORTUNITY ───────────────────────────────────────────────────────
				else if (resource === 'opportunity') {
					if (operation === 'get') {
						const opportunityId = this.getNodeParameter('opportunityId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/opportunity/${opportunityId}/`);
				} else if (operation === 'getAll') {
					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const oppFilters = this.getNodeParameter('opportunityFilters', i, {}) as IDataObject;
					const qs: IDataObject = {};
					// Lead ID can be passed server-side
					if (oppFilters.lead_id) qs.lead_id = oppFilters.lead_id;
					// User ID can be passed server-side
					if (oppFilters.user_id) qs.user_id = oppFilters.user_id;
					let opps: IDataObject[];
					if (returnAll) {
						opps = await closeApiRequestAllItems.call(this, 'GET', '/opportunity/', {}, qs);
					} else {
						const limit = this.getNodeParameter('limit', i) as number;
						const res = await closeApiRequest.call(this, 'GET', '/opportunity/', {}, { ...qs, _limit: limit });
						opps = (res.data || []) as IDataObject[];
					}
					// Status type filter — client-side (requires fetching statuses to resolve type)
					const statusTypes = (oppFilters.status_type as string[]) || [];
					if (statusTypes.length > 0) {
						// Fetch all opportunity statuses to map id -> type
						const statusRes = await closeApiRequest.call(this, 'GET', '/status/opportunity/');
						const statusMap: Record<string, string> = {};
						for (const s of (statusRes.data || []) as IDataObject[]) {
							statusMap[s.id as string] = s.type as string;
						}
						opps = opps.filter((opp) => {
							const type = statusMap[opp.status_id as string];
							return statusTypes.includes(type);
						});
					}
					responseData = opps;
				} else if (operation === 'create') {
					const leadId = this.getNodeParameter('leadId', i) as string;
					const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
					const body: IDataObject = { lead_id: leadId, ...additionalFields };
				const cfMapper = this.getNodeParameter('customFields', i, {}) as IDataObject;
				const cfValue = (cfMapper?.value ?? {}) as IDataObject;
				for (const [k, v] of Object.entries(cfValue)) {
										if (v !== null && v !== undefined && v !== '') {
											body[`custom.${k}`] = v;
										}
									}
				responseData = await closeApiRequest.call(this, 'POST', '/opportunity/', body);
				} else if (operation === 'update') {
					const opportunityId = this.getNodeParameter('opportunityId', i) as string;
					const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
					const updBody: IDataObject = { ...additionalFields };
					const cfMapperUpd = this.getNodeParameter('customFields', i, {}) as IDataObject;
					const cfValueUpd = (cfMapperUpd?.value ?? {}) as IDataObject;
					for (const [fieldId, value] of Object.entries(cfValueUpd)) {
						if (value !== null && value !== undefined && value !== '') {
							// Close accepts custom field updates only with a custom.{fieldId} request key.
							updBody[`custom.${fieldId}`] = value;
						}
					}
				applyCustomFieldClears(updBody, this.getNodeParameter('customFieldsToClear', i, []) as string[]);
					await applyCustomFieldUpdates.call(this, updBody, i, `/opportunity/${opportunityId}/`);
					responseData = await closeApiRequest.call(this, 'PUT', `/opportunity/${opportunityId}/`, updBody);
					} else if (operation === 'upsert') {
						const leadId = this.getNodeParameter('leadId', i) as string;
						const pipelineId = this.getNodeParameter('pipelineId', i) as string;
						const statusTypeFilter = this.getNodeParameter('statusTypeFilter', i, []) as string[];
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						const cfMapperUpsert = this.getNodeParameter('customFields', i, {}) as IDataObject;
						const cfValueUpsert = (cfMapperUpsert?.value ?? {}) as IDataObject;

						// Fetch all opportunities for the lead (up to 200)
						const oppRes = await closeApiRequest.call(this, 'GET', '/opportunity/', {}, { lead_id: leadId, _limit: 200 });
						let opportunities: IDataObject[] = (oppRes.data || []) as IDataObject[];

						// Filter by pipeline
						opportunities = opportunities.filter((o) => o.pipeline_id === pipelineId);

						// Optionally filter by status type — requires fetching statuses to map id -> type
						if (statusTypeFilter.length > 0) {
							const statusRes = await closeApiRequest.call(this, 'GET', '/status/opportunity/');
							const statusTypeMap: Record<string, string> = {};
							for (const s of (statusRes.data || []) as IDataObject[]) {
								statusTypeMap[s.id as string] = s.type as string;
							}
							opportunities = opportunities.filter((o) => {
								const sType = statusTypeMap[o.status_id as string];
								return statusTypeFilter.includes(sType);
							});
						}

						// Sort by date_created descending, pick the newest
						opportunities.sort((a, b) => {
							const aDate = new Date(a.date_created as string).getTime();
							const bDate = new Date(b.date_created as string).getTime();
							return bDate - aDate;
						});

						const upsertBody: IDataObject = { ...additionalFields };
						for (const [k, v] of Object.entries(cfValueUpsert)) {
							if (v !== null && v !== undefined && v !== '') {
								upsertBody[`custom.${k}`] = v;
							}
						}

						if (opportunities.length > 0) {
							// Update the newest existing opportunity
							const existingId = opportunities[0].id as string;
							responseData = await closeApiRequest.call(this, 'PUT', `/opportunity/${existingId}/`, upsertBody);
						} else {
							// Create a new opportunity
							upsertBody.lead_id = leadId;
							upsertBody.pipeline_id = pipelineId;
							responseData = await closeApiRequest.call(this, 'POST', '/opportunity/', upsertBody);
						}
					} else if (operation === 'delete') {
						const opportunityId = this.getNodeParameter('opportunityId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/opportunity/${opportunityId}/`);
						responseData = { success: true };
					}
				}

				// ── OPPORTUNITY STATUS ────────────────────────────────────────────────
				else if (resource === 'opportunityStatus') {
					if (operation === 'getAll') {
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						const res = await closeApiRequest.call(this, 'GET', '/status/opportunity/');
						const allItems = (res.data || []) as IDataObject[];
						responseData = returnAll ? allItems : allItems.slice(0, this.getNodeParameter('limit', i) as number);
					} else if (operation === 'get') {
						const id = this.getNodeParameter('opportunityStatusId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/status/opportunity/${id}/`);
					} else if (operation === 'create') {
						const label = this.getNodeParameter('label', i) as string;
						const type = this.getNodeParameter('type', i) as string;
						responseData = await closeApiRequest.call(this, 'POST', '/status/opportunity/', { label, type });
					} else if (operation === 'update') {
						const id = this.getNodeParameter('opportunityStatusId', i) as string;
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						responseData = await closeApiRequest.call(this, 'PUT', `/status/opportunity/${id}/`, additionalFields);
					} else if (operation === 'delete') {
						const id = this.getNodeParameter('opportunityStatusId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/status/opportunity/${id}/`);
						responseData = { success: true };
					}
				}

				// ── PIPELINE ──────────────────────────────────────────────────────────
				else if (resource === 'pipeline') {
					if (operation === 'getAll') {
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						const res = await closeApiRequest.call(this, 'GET', '/pipeline/');
						const allItems = (res.data || []) as IDataObject[];
						responseData = returnAll ? allItems : allItems.slice(0, this.getNodeParameter('limit', i) as number);
					} else if (operation === 'get') {
						const id = this.getNodeParameter('pipelineId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/pipeline/${id}/`);
					} else if (operation === 'create') {
						const name = this.getNodeParameter('name', i) as string;
						responseData = await closeApiRequest.call(this, 'POST', '/pipeline/', { name });
					} else if (operation === 'update') {
						const id = this.getNodeParameter('pipelineId', i) as string;
						const name = this.getNodeParameter('name', i) as string;
						responseData = await closeApiRequest.call(this, 'PUT', `/pipeline/${id}/`, { name });
					} else if (operation === 'delete') {
						const id = this.getNodeParameter('pipelineId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/pipeline/${id}/`);
						responseData = { success: true };
					}
				}

				// ── TASK ──────────────────────────────────────────────────────────────
				else if (resource === 'task') {
					if (operation === 'get') {
						const taskId = this.getNodeParameter('taskId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/task/${taskId}/`);
				} else if (operation === 'getAll') {
					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const taskFilters = this.getNodeParameter('taskFilters', i, {}) as IDataObject;
					const qs: IDataObject = {};
					if (taskFilters.lead_id) qs.lead_id = taskFilters.lead_id;
					if (taskFilters.assigned_to) qs.assigned_to = taskFilters.assigned_to;
					if (taskFilters.due_date__gte) qs.due_date__gte = taskFilters.due_date__gte;
					if (taskFilters.due_date__lte) qs.due_date__lte = taskFilters.due_date__lte;
					if (taskFilters.date_created__gte) qs.date_created__gte = taskFilters.date_created__gte;
					if (taskFilters.date_created__lte) qs.date_created__lte = taskFilters.date_created__lte;
					const taskStatus = (taskFilters.taskStatus as string) || 'all';
					if (taskStatus === 'open') qs.is_complete = 'false';
					else if (taskStatus === 'completed') qs.is_complete = 'true';
					if (returnAll) {
						responseData = await closeApiRequestAllItems.call(this, 'GET', '/task/', {}, qs);
					} else {
						const limit = this.getNodeParameter('limit', i) as number;
						const res = await closeApiRequest.call(this, 'GET', '/task/', {}, { ...qs, _limit: limit });
						responseData = res.data || [];
					}
				} else if (operation === 'create') {
						const text = this.getNodeParameter('text', i) as string;
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						const body: IDataObject = { text, ...additionalFields };
						responseData = await closeApiRequest.call(this, 'POST', '/task/', body);
					} else if (operation === 'update') {
						const taskId = this.getNodeParameter('taskId', i) as string;
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						responseData = await closeApiRequest.call(this, 'PUT', `/task/${taskId}/`, additionalFields);
					} else if (operation === 'delete') {
						const taskId = this.getNodeParameter('taskId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/task/${taskId}/`);
						responseData = { success: true };
					}
				}

				// ── NOTE ─────────────────────────────────────────────────────────────────────
				else if (resource === 'note') {
					if (operation === 'create') {
						const leadId = this.getNodeParameter('leadId', i) as string;
						const noteType = this.getNodeParameter('noteType', i) as string;
						const attachFile = this.getNodeParameter('attachFile', i) as boolean;
						const noteBody: IDataObject = { lead_id: leadId };
						if (noteType === 'html') {
							noteBody.note_html = this.getNodeParameter('noteHtml', i) as string;
						} else {
							noteBody.note = this.getNodeParameter('note', i) as string;
						}
						if (attachFile) {
							const attachmentSource = this.getNodeParameter('attachmentSource', i) as string;
							let fileBuffer: Buffer;
							let filename: string;
							let contentType: string;
							if (attachmentSource === 'url') {
								const fileUrl = this.getNodeParameter('fileUrl', i) as string;
								const urlResponse = await this.helpers.httpRequest({
									method: 'GET',
									url: fileUrl,
									encoding: 'arraybuffer',
									returnFullResponse: true,
								});
								fileBuffer = Buffer.from(urlResponse.body as ArrayBuffer);
								const urlPath = new URL(fileUrl).pathname;
								filename = urlPath.split('/').pop() || 'attachment';
								const respContentType = (urlResponse.headers?.['content-type'] as string) || '';
								contentType = respContentType.split(';')[0].trim() || 'application/octet-stream';
							} else {
								const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;
								const binaryData = this.helpers.assertBinaryData(i, binaryPropertyName);
								filename = binaryData.fileName || 'attachment';
								contentType = binaryData.mimeType || 'application/octet-stream';
								fileBuffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
							}
							const uploadMeta = await closeApiRequest.call(this, 'POST', '/files/upload/', { filename, content_type: contentType });
							const s3Form = new FormData();
							for (const [key, value] of Object.entries(uploadMeta.upload.fields as Record<string, string>)) {
								s3Form.append(key, value);
							}
							s3Form.append('file', new Blob([fileBuffer], { type: contentType }), filename);
							await this.helpers.httpRequest({ method: 'POST', url: uploadMeta.upload.url, body: s3Form, ignoreHttpStatusErrors: true } as IHttpRequestOptions);
							noteBody.attachments = [{ url: uploadMeta.download.url, filename, content_type: contentType }];
						}
						responseData = await closeApiRequest.call(this, 'POST', '/activity/note/', noteBody);
					} else if (operation === 'get') {
						const noteId = this.getNodeParameter('noteId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/activity/note/${noteId}/`);
				} else if (operation === 'getAll') {
					const leadId = this.getNodeParameter('leadId', i) as string;
					const filters = this.getNodeParameter('filters', i) as IDataObject;
					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const qs: IDataObject = { lead_id: leadId };
					if (filters.date_created__gt) qs.date_created__gt = filters.date_created__gt;
					if (filters.date_created__lt) qs.date_created__lt = filters.date_created__lt;
					if (returnAll) {
						responseData = await closeApiRequestAllItems.call(this, 'GET', '/activity/note/', {}, qs);
					} else {
						const limit = this.getNodeParameter('limit', i) as number;
						const res = await closeApiRequest.call(this, 'GET', '/activity/note/', {}, { ...qs, _limit: limit });
						responseData = res.data || [];
					}
				} else if (operation === 'update') {
					const noteId = this.getNodeParameter('noteId', i) as string;
						const noteType = this.getNodeParameter('noteType', i) as string;
						const body: IDataObject = {};
						if (noteType === 'html') {
							body.note_html = this.getNodeParameter('noteHtml', i) as string;
						} else {
							body.note = this.getNodeParameter('note', i) as string;
						}
						responseData = await closeApiRequest.call(this, 'PUT', `/activity/note/${noteId}/`, body);
					} else if (operation === 'delete') {
						const noteId = this.getNodeParameter('noteId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/activity/note/${noteId}/`);
						responseData = { success: true };
					}
				}
				// ── CALL ─────────────────────────────────────────────────────────────────────
				else if (resource === 'call') {
					if (operation === 'create') {
						const leadId = this.getNodeParameter('callLeadId', i) as string;
						const direction = this.getNodeParameter('direction', i) as string;
						const status = this.getNodeParameter('callStatus', i) as string;
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						const body: IDataObject = { lead_id: leadId, direction, disposition: status, ...additionalFields };
						responseData = await closeApiRequest.call(this, 'POST', '/activity/call/', body);
					} else if (operation === 'get') {
						const callId = this.getNodeParameter('callId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/activity/call/${callId}/`);
				} else if (operation === 'getAll') {
					const leadId = this.getNodeParameter('callLeadId', i) as string;
					const filters = this.getNodeParameter('filters', i) as IDataObject;
					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const qs: IDataObject = { lead_id: leadId };
					if (filters.date_created__gt) qs.date_created__gt = filters.date_created__gt;
					if (filters.date_created__lt) qs.date_created__lt = filters.date_created__lt;
					if (returnAll) {
						responseData = await closeApiRequestAllItems.call(this, 'GET', '/activity/call/', {}, qs);
					} else {
						const limit = this.getNodeParameter('limit', i) as number;
						const res = await closeApiRequest.call(this, 'GET', '/activity/call/', {}, { ...qs, _limit: limit });
						responseData = res.data || [];
					}
				} else if (operation === 'update') {
					const callId = this.getNodeParameter('callId', i) as string;
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						responseData = await closeApiRequest.call(this, 'PUT', `/activity/call/${callId}/`, additionalFields);
					} else if (operation === 'delete') {
						const callId = this.getNodeParameter('callId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/activity/call/${callId}/`);
						responseData = { success: true };
					}
				}
				// ── EMAIL ────────────────────────────────────────────────────────────────────
				else if (resource === 'email') {
				if (operation === 'create') {
					const leadId = this.getNodeParameter('emailLeadId', i) as string;
					const contactId = this.getNodeParameter('emailContactId', i) as string;
					const userId = this.getNodeParameter('emailUserId', i) as string;
					const sender = this.getNodeParameter('emailSender', i) as string;
					const to = this.getNodeParameter('emailTo', i) as string;
					const useTemplate = this.getNodeParameter('useTemplate', i, false) as boolean;
					const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
					const emailBody: IDataObject = {
						lead_id: leadId,
						contact_id: contactId,
						user_id: userId,
						sender,
						to: [to],
						status: 'outbox',
					};
					if (useTemplate) {
						const templateId = this.getNodeParameter('emailTemplateId', i) as string;
						if (templateId) emailBody.template_id = templateId;
					} else {
						const subject = this.getNodeParameter('emailSubject', i, '') as string;
						const body = this.getNodeParameter('emailBody', i, '') as string;
						const bodyType = this.getNodeParameter('bodyType', i, 'html') as string;
						if (subject) emailBody.subject = subject;
						if (body) {
							if (bodyType === 'text') {
								emailBody.body_text = body;
							} else {
								emailBody.body_html = body;
							}
						}
					}
					if (additionalFields.cc) emailBody.cc = [additionalFields.cc as string];
					if (additionalFields.bcc) emailBody.bcc = [additionalFields.bcc as string];
					responseData = await closeApiRequest.call(this, 'POST', '/activity/email/', emailBody);
					} else if (operation === 'get') {
						const emailId = this.getNodeParameter('emailId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/activity/email/${emailId}/`);
				} else if (operation === 'getAll') {
					const leadId = this.getNodeParameter('emailLeadId', i) as string;
					const filters = this.getNodeParameter('filters', i) as IDataObject;
					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const qs: IDataObject = { lead_id: leadId };
					if (filters.date_created__gt) qs.date_created__gt = filters.date_created__gt;
					if (filters.date_created__lt) qs.date_created__lt = filters.date_created__lt;
					if (returnAll) {
						responseData = await closeApiRequestAllItems.call(this, 'GET', '/activity/email/', {}, qs);
					} else {
						const limit = this.getNodeParameter('limit', i) as number;
						const res = await closeApiRequest.call(this, 'GET', '/activity/email/', {}, { ...qs, _limit: limit });
						responseData = res.data || [];
					}
				} else if (operation === 'update') {
					const emailId = this.getNodeParameter('emailId', i) as string;
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						responseData = await closeApiRequest.call(this, 'PUT', `/activity/email/${emailId}/`, additionalFields);
					} else if (operation === 'delete') {
						const emailId = this.getNodeParameter('emailId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/activity/email/${emailId}/`);
						responseData = { success: true };
					}
				}
				// ── SMS ──────────────────────────────────────────────────────────────────────
				else if (resource === 'sms') {
					if (operation === 'create') {
						const leadId = this.getNodeParameter('smsLeadId', i) as string;
						const text = this.getNodeParameter('smsText', i) as string;
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						const body: IDataObject = { lead_id: leadId, text, direction: 'outbound', status: 'outbox', ...additionalFields };
						responseData = await closeApiRequest.call(this, 'POST', '/activity/sms/', body);
					} else if (operation === 'get') {
						const smsId = this.getNodeParameter('smsId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/activity/sms/${smsId}/`);
				} else if (operation === 'getAll') {
					const leadId = this.getNodeParameter('smsLeadId', i) as string;
					const filters = this.getNodeParameter('filters', i) as IDataObject;
					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const qs: IDataObject = { lead_id: leadId };
					if (filters.date_created__gt) qs.date_created__gt = filters.date_created__gt;
					if (filters.date_created__lt) qs.date_created__lt = filters.date_created__lt;
					if (returnAll) {
						responseData = await closeApiRequestAllItems.call(this, 'GET', '/activity/sms/', {}, qs);
					} else {
						const limit = this.getNodeParameter('limit', i) as number;
						const res = await closeApiRequest.call(this, 'GET', '/activity/sms/', {}, { ...qs, _limit: limit });
						responseData = res.data || [];
					}
				} else if (operation === 'update') {
					const smsId = this.getNodeParameter('smsId', i) as string;
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						responseData = await closeApiRequest.call(this, 'PUT', `/activity/sms/${smsId}/`, additionalFields);
					} else if (operation === 'delete') {
						const smsId = this.getNodeParameter('smsId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/activity/sms/${smsId}/`);
						responseData = { success: true };
					}
				}
				// ── CUSTOM ACTIVITY ───────────────────────────────────────────────────
				else if (resource === 'customActivity') {
					if (operation === 'get') {
						const id = this.getNodeParameter('customActivityId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/activity/custom/${id}/`);
				} else if (operation === 'getAll') {
					const leadId = this.getNodeParameter('customActivityLeadId', i) as string;
					const filters = this.getNodeParameter('filters', i) as IDataObject;
					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const qs: IDataObject = { lead_id: leadId };
					if (filters.custom_activity_type_id) qs.custom_activity_type_id = filters.custom_activity_type_id;
					if (filters.date_created__gt) qs.date_created__gt = filters.date_created__gt;
					if (filters.date_created__lt) qs.date_created__lt = filters.date_created__lt;
					let instances: IDataObject[];
					if (returnAll) {
						instances = await closeApiRequestAllItems.call(this, 'GET', '/activity/custom/', {}, qs);
					} else {
						const limit = this.getNodeParameter('limit', i) as number;
						const res = await closeApiRequest.call(this, 'GET', '/activity/custom/', {}, { ...qs, _limit: limit });
						instances = (res.data || []) as IDataObject[];
					}

						// Client-side custom field filtering
						const cfFilters = this.getNodeParameter('customFieldFilters', i, {}) as IDataObject;
						const cfConditions = (cfFilters?.conditions as IDataObject[]) || [];
						if (cfConditions.length > 0) {
							instances = instances.filter((instance) => {
								return cfConditions.every((cond) => {
									const fieldId = cond.fieldId as string;
									const expectedValue = cond.value as string;
									if (!fieldId) return true;
									// Custom fields are stored as custom.{fieldId} on the instance
									const actualValue = instance[`custom.${fieldId}`];
									// Support both single value and array (multiselect fields)
									if (Array.isArray(actualValue)) {
										return (actualValue as string[]).includes(expectedValue);
									}
									return String(actualValue ?? '') === expectedValue;
								});
							});
						}
						responseData = instances;
					} else if (operation === 'create') {
						const leadId = this.getNodeParameter('customActivityLeadId', i) as string;
						const activityTypeId = this.getNodeParameter('activityTypeId', i) as string;
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						const body: IDataObject = {
							activity_at: additionalFields.activity_at || new Date().toISOString(),
							lead_id: leadId,
							custom_activity_type_id: activityTypeId,
						};
						const cfMapper = this.getNodeParameter('customFields', i, { mappingMode: 'defineBelow', value: {} }) as IDataObject;
						const cfValue = (cfMapper?.value ?? {}) as IDataObject;
						for (const [k, v] of Object.entries(cfValue)) {
							if (v !== null && v !== undefined && v !== '') {
								body[`custom.${k}`] = v;
							}
						}
						responseData = await closeApiRequest.call(this, 'POST', '/activity/custom/', body);
					} else if (operation === 'update') {
						const id = this.getNodeParameter('customActivityId', i) as string;
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						const body: IDataObject = {};
						if (additionalFields.activity_at) body.activity_at = additionalFields.activity_at;
						const cfMapper2 = this.getNodeParameter('customFields', i, { mappingMode: 'defineBelow', value: {} }) as IDataObject;
						const cfValue2 = (cfMapper2?.value ?? {}) as IDataObject;
						for (const [k, v] of Object.entries(cfValue2)) {
							if (v !== null && v !== undefined && v !== '') {
								body[`custom.${k}`] = v;
							}
						}
						applyCustomFieldClears(body, this.getNodeParameter('customFieldsToClear', i, []) as string[]);
					await applyCustomFieldUpdates.call(this, body, i, `/activity/custom/${id}/`);
					responseData = await closeApiRequest.call(this, 'PUT', `/activity/custom/${id}/`, body);
					} else if (operation === 'delete') {
						const id = this.getNodeParameter('customActivityId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/activity/custom/${id}/`);
						responseData = { success: true };
					}
				}
				// ── CUSTOM ACTIVITY TYPE ─────────────────────────────────────────────────
				else if (resource === 'customActivityType') {
					if (operation === 'getAll') {
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						const res = await closeApiRequest.call(this, 'GET', '/custom_activity/');
						const allItems = (res.data || []) as IDataObject[];
						responseData = returnAll ? allItems : allItems.slice(0, this.getNodeParameter('limit', i) as number);
					} else if (operation === 'get') {
						const id = this.getNodeParameter('customActivityTypeId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/custom_activity/${id}/`);
					} else if (operation === 'create') {
						const name = this.getNodeParameter('customActivityTypeName', i) as string;
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						const body: IDataObject = { name, ...additionalFields };
						responseData = await closeApiRequest.call(this, 'POST', '/custom_activity/', body);
					} else if (operation === 'update') {
						const id = this.getNodeParameter('customActivityTypeId', i) as string;
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						responseData = await closeApiRequest.call(this, 'PUT', `/custom_activity/${id}/`, additionalFields);
					} else if (operation === 'delete') {
						const id = this.getNodeParameter('customActivityTypeId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/custom_activity/${id}/`);
						responseData = { success: true };
					}
				}

				// ── COMMENT ───────────────────────────────────────────────────────────
				else if (resource === 'comment') {
					if (operation === 'getAll') {
						const leadId = this.getNodeParameter('leadId', i) as string;
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						if (returnAll) {
							responseData = await closeApiRequestAllItems.call(this, 'GET', '/activity/note/', {}, { lead_id: leadId });
						} else {
							const limit = this.getNodeParameter('limit', i) as number;
							const res = await closeApiRequest.call(this, 'GET', '/activity/note/', {}, { lead_id: leadId, _limit: limit });
							responseData = res.data || [];
						}
					} else if (operation === 'create') {
						const leadId = this.getNodeParameter('leadId', i) as string;
						const note = this.getNodeParameter('note', i) as string;
						responseData = await closeApiRequest.call(this, 'POST', '/activity/note/', { lead_id: leadId, note });
					} else if (operation === 'delete') {
						const commentId = this.getNodeParameter('commentId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/activity/note/${commentId}/`);
						responseData = { success: true };
					}
				}

				// ── EMAIL TEMPLATE ────────────────────────────────────────────────────
				else if (resource === 'emailTemplate') {
					if (operation === 'get') {
						const templateId = this.getNodeParameter('templateId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/email_template/${templateId}/`);
				} else if (operation === 'getAll') {
					const returnAll = this.getNodeParameter('returnAll', i) as boolean;
					const res = await closeApiRequest.call(this, 'GET', '/email_template/');
					const allItems = (res.data || []) as IDataObject[];
					responseData = returnAll ? allItems : allItems.slice(0, this.getNodeParameter('limit', i) as number);
					} else if (operation === 'create') {
						const name = this.getNodeParameter('name', i) as string;
						const subject = this.getNodeParameter('subject', i) as string;
						const body_html = this.getNodeParameter('body_html', i) as string;
						responseData = await closeApiRequest.call(this, 'POST', '/email_template/', { name, subject, body: body_html });
					} else if (operation === 'update') {
						const templateId = this.getNodeParameter('templateId', i) as string;
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						const body: IDataObject = {};
						if (additionalFields.name) body.name = additionalFields.name;
						if (additionalFields.subject) body.subject = additionalFields.subject;
						if (additionalFields.body_html) body.body = additionalFields.body_html;
						responseData = await closeApiRequest.call(this, 'PUT', `/email_template/${templateId}/`, body);
					} else if (operation === 'delete') {
						const templateId = this.getNodeParameter('templateId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/email_template/${templateId}/`);
						responseData = { success: true };
					}
				}



				// ── SMART VIEW ────────────────────────────────────────────────────────
				else if (resource === 'smartView') {
					if (operation === 'getAll') {
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						const res = await closeApiRequest.call(this, 'GET', '/saved_search/');
						const allItems = (res.data || []) as IDataObject[];
						responseData = returnAll ? allItems : allItems.slice(0, this.getNodeParameter('limit', i) as number);
					} else if (operation === 'get') {
						const smartViewId = this.getNodeParameter('smartViewId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/saved_search/${smartViewId}/`);
					} else if (operation === 'getLeads') {
						const smartViewId = this.getNodeParameter('smartViewId', i) as string;
						responseData = await closeApiRequestAllItems.call(this, 'GET', '/lead/', {}, { saved_search_id: smartViewId });
					} else if (operation === 'create') {
						const name = this.getNodeParameter('name', i) as string;
						const smartViewOwnerId = this.getNodeParameter('smartViewOwnerId', i, '') as string;
						const sharingSettings = this.getNodeParameter('sharingSettings', i, {}) as IDataObject;
						const sQueryValue = this.getNodeParameter('s_query', i);
						const body: IDataObject = {
							name,
							s_query: parseSmartViewQuery(sQueryValue, this, i),
						};
						if (smartViewOwnerId) body.user_id = smartViewOwnerId;
						if (Object.keys(sharingSettings).length > 0) {
							body.sharing_settings = {
								whole_org: sharingSettings.whole_org === true,
								group_ids: (sharingSettings.group_ids as string[]) || [],
								user_ids: (sharingSettings.user_ids as string[]) || [],
							};
						}
						responseData = await closeApiRequest.call(this, 'POST', '/saved_search/', body);
					} else if (operation === 'update') {
						const smartViewId = this.getNodeParameter('smartViewId', i) as string;
						const smartViewOwnerId = this.getNodeParameter('smartViewOwnerId', i, '') as string;
						const sharingSettings = this.getNodeParameter('sharingSettings', i, {}) as IDataObject;
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						const body: IDataObject = {};
						if (additionalFields.name) body.name = additionalFields.name;
						if (additionalFields.s_query) body.s_query = parseSmartViewQuery(additionalFields.s_query, this, i);
						if (smartViewOwnerId) body.user_id = smartViewOwnerId;
						if (Object.keys(sharingSettings).length > 0) {
							body.sharing_settings = {
								whole_org: sharingSettings.whole_org === true,
								group_ids: (sharingSettings.group_ids as string[]) || [],
								user_ids: (sharingSettings.user_ids as string[]) || [],
							};
						}
						responseData = await closeApiRequest.call(this, 'PUT', `/saved_search/${smartViewId}/`, body);
					} else if (operation === 'delete') {
						const smartViewId = this.getNodeParameter('smartViewId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/saved_search/${smartViewId}/`);
						responseData = { success: true };
					}
				}

				// ── USER ──────────────────────────────────────────────────────────────
				else if (resource === 'user') {
				if (operation === 'get') {
					const userId = this.getNodeParameter('userId', i) as string;
					responseData = await closeApiRequest.call(this, 'GET', `/user/${userId}/`);
				} else if (operation === 'getAll') {
					const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
					const statusFilter = filters.is_active as string | undefined;
					// The Close API /user/ endpoint only returns active org members.
					// Inactive users are stored in org.inactive_memberships.
					if (statusFilter === 'false') {
						// Inactive users: fetch from organization.inactive_memberships
						const me = await closeApiRequest.call(this, 'GET', '/me/') as IDataObject;
						// Close returns organization objects from /me/, not an array of raw organization IDs.
						const organizations = (me.organizations || []) as Array<IDataObject | string>;
						const orgIds = organizations
							.map((organization) => typeof organization === 'string' ? organization : organization?.id as string | undefined)
							.filter((organizationId): organizationId is string => Boolean(organizationId));
						const inactiveUsers: IDataObject[] = [];
						for (const orgId of orgIds) {
							const org = await closeApiRequest.call(this, 'GET', `/organization/${orgId}/`, {}, { _fields: 'inactive_memberships' });
							const inactiveMembers = (org.inactive_memberships || []) as IDataObject[];
							for (const m of inactiveMembers) {
								inactiveUsers.push({
									id: m.user_id,
									first_name: m.user_first_name,
									last_name: m.user_last_name,
									email: m.user_email,
									image: m.user_image,
									is_active: false,
								});
							}
						}
						responseData = inactiveUsers;
						} else {
							const returnAll = this.getNodeParameter('returnAll', i) as boolean;
							const res = await closeApiRequest.call(this, 'GET', '/user/');
							const allItems = (res.data || []) as IDataObject[];
							// The Close endpoint has no active-status parameter. Active users have one or more organization IDs.
							const filteredItems = statusFilter === 'true'
								? allItems.filter((user) => Array.isArray(user.organizations) && user.organizations.length > 0)
								: allItems;
							responseData = returnAll ? filteredItems : filteredItems.slice(0, this.getNodeParameter('limit', i) as number);
						}
					} else if (operation === 'getMe') {
						responseData = await closeApiRequest.call(this, 'GET', '/me/');
					}
				}

				// ── CUSTOM FIELD ──────────────────────────────────────────────────────
				else if (resource === 'customField') {
					const objectType = this.getNodeParameter('objectType', i) as string;
					if (operation === 'getAll') {
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						const res = await closeApiRequest.call(this, 'GET', `/custom_field/${objectType}/`);
						const allItems = (res.data || []) as IDataObject[];
						responseData = returnAll ? allItems : allItems.slice(0, this.getNodeParameter('limit', i) as number);
					} else if (operation === 'get') {
						const customFieldId = this.getNodeParameter('customFieldId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/custom_field/${objectType}/${customFieldId}/`);
					} else if (operation === 'create') {
						const name = this.getNodeParameter('name', i) as string;
						const fieldType = this.getNodeParameter('fieldType', i) as string;
						const body: IDataObject = { name, type: fieldType };
						if (fieldType === 'choices') {
							const choiceValues = this.getNodeParameter('choiceValues', i, {}) as IDataObject;
							const values = (choiceValues.values as IDataObject[]) || [];
							const choices = values.map((choice) => choice.value as string).filter((choice) => choice.length > 0);
							if (choices.length === 0) {
								throw new NodeOperationError(this.getNode(), 'At least one Dropdown Option is required when creating a Choices custom field', { itemIndex: i });
							}
							body.choices = choices;
						}
						const createdField = await closeApiRequest.call(this, 'POST', `/custom_field/${objectType}/`, body) as IDataObject;
						if (objectType === 'shared') {
							const associations = this.getNodeParameter('sharedFieldAssociations', i, []) as string[];
							for (const association of associations) {
								await closeApiRequest.call(this, 'POST', `/custom_field/shared/${createdField.id as string}/association/`, {
									object_type: association,
									required: false,
								});
							}
						}
						responseData = createdField;
					} else if (operation === 'associateShared') {
						if (objectType !== 'shared') {
							throw new NodeOperationError(this.getNode(), 'Associate Shared Field is only available when Object Type is Shared Field', { itemIndex: i });
						}
						const customFieldId = this.getNodeParameter('customFieldId', i) as string;
						const associationType = this.getNodeParameter('sharedFieldAssociationType', i) as string;
						responseData = await closeApiRequest.call(this, 'POST', `/custom_field/shared/${customFieldId}/association/`, {
							object_type: associationType,
							required: false,
						});
					} else if (operation === 'addChoice') {
						const customFieldId = this.getNodeParameter('customFieldId', i) as string;
						const choiceValue = (this.getNodeParameter('choiceValue', i) as string).trim();
						if (!choiceValue) {
							throw new NodeOperationError(this.getNode(), 'Dropdown Option cannot be empty', { itemIndex: i });
						}
						const customField = await closeApiRequest.call(this, 'GET', `/custom_field/${objectType}/${customFieldId}/`) as IDataObject;
						if (customField.type !== 'choices') {
							throw new NodeOperationError(this.getNode(), 'Add Dropdown Option is only available for Custom Fields with the Choices type', { itemIndex: i });
						}
						const choices = ((customField.choices || []) as string[]).map((choice) => choice.trim());
						if (choices.some((choice) => choice.toLowerCase() === choiceValue.toLowerCase())) {
							responseData = customField;
						} else {
							responseData = await closeApiRequest.call(this, 'PUT', `/custom_field/${objectType}/${customFieldId}/`, {
								choices: [...choices, choiceValue],
							});
						}
					} else if (operation === 'update') {
						const customFieldId = this.getNodeParameter('customFieldId', i) as string;
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						responseData = await closeApiRequest.call(this, 'PUT', `/custom_field/${objectType}/${customFieldId}/`, additionalFields);
					} else if (operation === 'delete') {
						const customFieldId = this.getNodeParameter('customFieldId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/custom_field/${objectType}/${customFieldId}/`);
						responseData = { success: true };
					}
				}

				// ── INTEGRATION LINK ──────────────────────────────────────────────────
				else if (resource === 'integrationLink') {
					if (operation === 'getAll') {
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						const res = await closeApiRequest.call(this, 'GET', '/integration_link/');
						const allItems = (res.data || []) as IDataObject[];
						responseData = returnAll ? allItems : allItems.slice(0, this.getNodeParameter('limit', i) as number);
					} else if (operation === 'get') {
						const id = this.getNodeParameter('integrationLinkId', i) as string;
						responseData = await closeApiRequest.call(this, 'GET', `/integration_link/${id}/`);
					} else if (operation === 'create') {
						const name = this.getNodeParameter('name', i) as string;
						const url = this.getNodeParameter('url', i) as string;
						const linkType = this.getNodeParameter('linkType', i) as string;
						responseData = await closeApiRequest.call(this, 'POST', '/integration_link/', { name, url, link_type: linkType });
					} else if (operation === 'update') {
						const id = this.getNodeParameter('integrationLinkId', i) as string;
						const additionalFields = this.getNodeParameter('additionalFields', i) as IDataObject;
						responseData = await closeApiRequest.call(this, 'PUT', `/integration_link/${id}/`, additionalFields);
					} else if (operation === 'delete') {
						const id = this.getNodeParameter('integrationLinkId', i) as string;
						await closeApiRequest.call(this, 'DELETE', `/integration_link/${id}/`);
						responseData = { success: true };
					}
				}

				else {
					throw new NodeOperationError(this.getNode(), `Unknown resource: ${resource}`, { itemIndex: i });
				}

				// Normalize to array
				const items2 = Array.isArray(responseData) ? responseData : [responseData];
				returnData.push(...items2.map((item) => ({ json: item as IDataObject, pairedItem: { item: i } })));

			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
