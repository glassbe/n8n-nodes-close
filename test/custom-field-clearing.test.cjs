const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyCustomFieldClears } = require('../dist/nodes/Close/CustomFieldClearing');
const api = require('../dist/nodes/Close/GenericFunctions');
const { Close } = require('../dist/nodes/Close/Close.node');

test('clear is explicit, preserves zero/false, and rejects ambiguous changes', () => {
 const body = { 'custom.cf_number': 0, 'custom.cf_bool': false };
 applyCustomFieldClears(body, ['cf_date']);
 assert.deepEqual(body, {'custom.cf_number':0,'custom.cf_bool':false,'custom.cf_date':null});
 assert.throws(()=>applyCustomFieldClears(body,['cf_number']),/set and cleared/);
 assert.throws(()=>applyCustomFieldClears({},['__proto__']),/Invalid/);
});

test('all four update resources send explicit null without changing existing empty-mapper behavior', async () => {
 const original = api.closeApiRequest;
 const writes = [];
 api.closeApiRequest = async (method,path,body) => { writes.push({method,path,body}); return {id:'result'}; };
 try {
  for (const resource of ['lead','contact','opportunity','customActivity']) {
   const params = {resource,operation:'update',leadId:'lead_1',contactId:'cont_1',opportunityId:'oppo_1',customActivityId:'acti_1',additionalFields:{},customFields:{value:{cf_count:0,cf_omitted:null,cf_blank:''}},customFieldsToClear:['cf_wait']};
   const ctx = {getInputData:()=>[{json:{}}],getNodeParameter:(k,i,d)=>params[k]??d,continueOnFail:()=>false,getNode:()=>({name:'Test'})};
   const rows = await new Close().execute.call(ctx);
   assert.equal(rows[0][0].pairedItem.item,0);
   const write = writes.at(-1);
   assert.equal(write.method,'PUT');
   assert.deepEqual(write.body,{'custom.cf_count':0,'custom.cf_wait':null});
  }
 } finally { api.closeApiRequest = original; }
});

test('load options uses the selected resource schema, including activity fields', async () => {
 const original = api.closeApiRequest; const paths=[];
 api.closeApiRequest=async (method,path)=>{paths.push(path);return {fields:[{id:'cf_1',name:'External ID'}]};};
 try {
  const node=new Close();
  const ctx={getCurrentNodeParameter:k=>k==='resource'?'customActivity':'cat_1'};
  assert.deepEqual(await node.methods.loadOptions.getCustomFieldsToClear.call(ctx),[{name:'External ID',value:'cf_1'}]);
  assert.equal(paths[0],'/custom_field_schema/activity/cat_1/');
 } finally {api.closeApiRequest=original;}
});
