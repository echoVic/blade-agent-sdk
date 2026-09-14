import type { ModelContent } from '../model/message.js';

/** JSON-safe user input accepted by Agent, Session, and wire commands. */
export type UserMessageContent = string | ModelContent[];
