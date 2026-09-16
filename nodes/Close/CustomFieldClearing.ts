import type { IDataObject } from 'n8n-workflow';

/** Explicit clearing is separate from the mapper's existing omit-empty behavior. */
export function applyCustomFieldClears(body: IDataObject, fieldIds: string[]): void {
	for (const fieldId of fieldIds) {
		if (!/^cf_[A-Za-z0-9]+$/.test(fieldId)) {
			throw new Error(`Invalid custom field ID: ${fieldId}`);
		}
		const key = `custom.${fieldId}`;
		if (Object.prototype.hasOwnProperty.call(body, key) && body[key] !== null) {
			throw new Error(`Custom field ${fieldId} cannot be set and cleared in the same operation`);
		}
		body[key] = null;
	}
}
