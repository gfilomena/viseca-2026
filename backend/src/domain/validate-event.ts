import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { config } from '../config.ts';

const addFormats = addFormatsModule as unknown as (a: Ajv2020) => void;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

/** Validates an AuthorizationEvent against the official authorization_event.schema.json. */
export const validateEvent = ajv.compile(JSON.parse(fs.readFileSync(path.join(config.dataDir, 'schemas', 'authorization_event.schema.json'), 'utf8')));
