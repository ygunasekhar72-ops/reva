import { randomBytes, randomUUID } from 'node:crypto';

export const newId = (prefix = 'id') => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const uuid = () => randomUUID();
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
