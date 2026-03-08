import { PaliClient } from "./client";
import type { ChatMessage, DeleteMemoryAction, MemoryAction, MemoryResponse, ReplaceMemoryAction, StoreMemoryAction, StoreMemoryRequest } from "./types";

export type HookPhase = "SEARCH" | "INJECT" | "CALL" | "STORE";
export type HookFn = (phase: HookPhase, payload: Record<string, unknown>) => void;
export type ExtractorFn = (
  messages: ChatMessage[],
  llmResult: unknown,
  responseText: string
) => Iterable<StoreMemoryRequest>;
export type ActionPlannerFn = (
  messages: ChatMessage[],
  recalledMemories: MemoryResponse[],
  llmResult: unknown,
  responseText: string
) => Iterable<MemoryAction>;
export type ResponseTextGetter = (llmResult: unknown) => string;

export interface PaliMiddlewareOptions {
  topK?: number;
  minScore?: number;
  readOnly?: boolean;
  allowDestructiveActions?: boolean;
  systemPromptTemplate?: string;
  hooks?: Partial<Record<HookPhase, HookFn[]>>;
  extractor?: ExtractorFn;
  actionPlanner?: ActionPlannerFn;
  responseTextGetter?: ResponseTextGetter;
}

const DEFAULT_SYSTEM_PROMPT_TEMPLATE =
  "Relevant memories:\n{{memories}}\n\nUse these memories only when they help answer the user accurately.";

export class PaliMiddleware {
  private readonly client: PaliClient;
  private readonly tenantId: string;
  private readonly topK: number;
  private readonly minScore: number;
  private readonly readOnly: boolean;
  private readonly allowDestructiveActions: boolean;
  private readonly systemPromptTemplate: string;
  private readonly hooks: Partial<Record<HookPhase, HookFn[]>>;
  private readonly extractor: ExtractorFn;
  private readonly actionPlanner?: ActionPlannerFn;
  private readonly responseTextGetter: ResponseTextGetter;

  constructor(client: PaliClient, tenantId: string, options: PaliMiddlewareOptions = {}) {
    if (!tenantId.trim()) {
      throw new Error("tenantId is required");
    }
    this.client = client;
    this.tenantId = tenantId.trim();
    this.topK = options.topK ?? 5;
    this.minScore = options.minScore ?? 0.3;
    this.readOnly = options.readOnly ?? false;
    this.allowDestructiveActions = options.allowDestructiveActions ?? false;
    this.systemPromptTemplate = options.systemPromptTemplate ?? DEFAULT_SYSTEM_PROMPT_TEMPLATE;
    if (!this.systemPromptTemplate.includes("{{memories}}")) {
      throw new Error("systemPromptTemplate must contain {{memories}}");
    }
    this.hooks = options.hooks ?? {};
    this.extractor = options.extractor ?? defaultExtractor(this.tenantId);
    this.actionPlanner = options.actionPlanner;
    this.responseTextGetter = options.responseTextGetter ?? defaultResponseTextGetter;
  }

  wrap<T extends (...args: any[]) => any>(llmFn: T): T {
    const self = this;
    const wrapped = async function wrappedFn(...args: any[]): Promise<unknown> {
      const messages = coerceMessages(extractMessages(args));
      const recalled = await self.search(messages);
      const injected = injectMemories(messages, recalled, self.systemPromptTemplate);
      self.emit("INJECT", { memories: recalled, messages: injected });
      const callArgs = replaceMessages(args, injected);
      self.emit("CALL", { messages: injected });
      const result = await Promise.resolve(llmFn(...callArgs));
      await self.store(messages, recalled, result);
      return result;
    };
    return wrapped as unknown as T;
  }

  wrapOpenAI<T extends { chat: { completions: { create: (...args: unknown[]) => unknown } } }>(client: T): T {
    const self = this;
    const original = client.chat.completions.create.bind(client.chat.completions);
    const wrappedCreate = self.wrap((...args: unknown[]) => original(...args));
    client.chat.completions.create = wrappedCreate as typeof client.chat.completions.create;
    return client;
  }

  wrapAnthropic<T extends { messages: { create: (arg: Record<string, unknown>) => unknown } }>(client: T): T {
    const self = this;
    const original = client.messages.create.bind(client.messages);
    client.messages.create = (async (arg: Record<string, unknown>) => {
      const rawMessages = arg.messages;
      if (!Array.isArray(rawMessages)) {
        throw new Error("Anthropic messages.create requires messages array");
      }
      const messages = coerceAnthropicMessages(rawMessages);
      const recalled = await self.search(messages);
      const system = injectSystem(arg.system, recalled, self.systemPromptTemplate);
      self.emit("INJECT", { memories: recalled, system });
      const out = await Promise.resolve(original({ ...arg, system }));
      await self.store(messages, recalled, out);
      return out;
    }) as typeof client.messages.create;
    return client;
  }

  private async search(messages: ChatMessage[]): Promise<MemoryResponse[]> {
    const query = queryFromMessages(messages);
    this.emit("SEARCH", { query });
    try {
      const res = await this.client.search(this.tenantId, query, {
        topK: this.topK,
        minScore: this.minScore
      });
      return res.items;
    } catch (err) {
      this.emit("SEARCH", { query, degraded: true, error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  private async store(messages: ChatMessage[], recalled: MemoryResponse[], result: unknown): Promise<void> {
    if (this.readOnly) {
      return;
    }
    const responseText = this.responseTextGetter(result);
    const actions = this.planActions(messages, recalled, result, responseText);
    if (actions.length === 0) {
      return;
    }
    this.emit("STORE", { count: actions.length, actions: actions.map((a) => a.kind) });
    try {
      await this.applyActions(actions);
    } catch (err) {
      this.emit("STORE", { degraded: true, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private planActions(
    messages: ChatMessage[],
    recalled: MemoryResponse[],
    result: unknown,
    responseText: string
  ): MemoryAction[] {
    const planned =
      this.actionPlanner?.(messages, recalled, result, responseText) ??
      Array.from(this.extractor(messages, result, responseText)).map((request) => ({
        kind: "store" as const,
        request
      }));

    const actions: MemoryAction[] = [];
    let skippedDestructive = 0;
    for (const action of planned) {
      if (action.kind === "store") {
        actions.push({
          kind: "store",
          request: validateStoreRequest(action.request, this.tenantId)
        } satisfies StoreMemoryAction);
        continue;
      }
      if (!this.allowDestructiveActions) {
        skippedDestructive += 1;
        continue;
      }
      if (action.kind === "delete") {
        actions.push({
          kind: "delete",
          memoryId: requireMemoryId(action.memoryId)
        } satisfies DeleteMemoryAction);
        continue;
      }
      actions.push({
        kind: "replace",
        memoryId: requireMemoryId(action.memoryId),
        request: validateStoreRequest(action.request, this.tenantId)
      } satisfies ReplaceMemoryAction);
    }
    if (skippedDestructive > 0) {
      this.emit("STORE", { skippedDestructiveActions: skippedDestructive });
    }
    return actions;
  }

  private async applyActions(actions: MemoryAction[]): Promise<void> {
    const pendingStore: StoreMemoryRequest[] = [];
    const flushStores = async (): Promise<void> => {
      if (pendingStore.length === 0) {
        return;
      }
      if (pendingStore.length === 1) {
        await this.client.store(pendingStore[0]);
      } else {
        await this.client.storeBatch(pendingStore);
      }
      pendingStore.length = 0;
    };

    for (const action of actions) {
      if (action.kind === "store") {
        pendingStore.push(action.request);
        continue;
      }
      await flushStores();
      if (action.kind === "delete") {
        await this.client.deleteMemory(this.tenantId, action.memoryId);
        continue;
      }
      // No PATCH endpoint currently on server, so replace is delete+store.
      await this.client.deleteMemory(this.tenantId, action.memoryId);
      await this.client.store(action.request);
    }
    await flushStores();
  }

  private emit(phase: HookPhase, payload: Record<string, unknown>): void {
    for (const fn of this.hooks[phase] ?? []) {
      fn(phase, payload);
    }
  }
}

function defaultExtractor(tenantId: string): ExtractorFn {
  return (messages, _result, responseText) => {
    const out: StoreMemoryRequest[] = [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser?.content.trim()) {
      out.push({
        tenantId,
        content: lastUser.content,
        kind: "raw_turn",
        source: "pali_middleware",
        createdBy: "user"
      });
    }
    if (responseText.trim()) {
      out.push({
        tenantId,
        content: responseText,
        kind: "raw_turn",
        source: "pali_middleware",
        createdBy: "system"
      });
    }
    return out;
  };
}

function defaultResponseTextGetter(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result === "object") {
    const rec = result as Record<string, unknown>;
    if (typeof rec.content === "string") {
      return rec.content;
    }
    const choices = rec.choices;
    if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
      const message = (choices[0] as Record<string, unknown>).message;
      if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>).content;
        if (typeof content === "string") {
          return content;
        }
      }
    }
  }
  return String(result ?? "");
}

function extractMessages(args: unknown[]): unknown[] {
  if (Array.isArray(args[0])) {
    return args[0] as unknown[];
  }
  if (args[0] && typeof args[0] === "object") {
    const rec = args[0] as Record<string, unknown>;
    if (Array.isArray(rec.messages)) {
      return rec.messages;
    }
  }
  throw new Error("wrapped function must receive messages array or { messages } object");
}

function replaceMessages(args: unknown[], messages: ChatMessage[]): unknown[] {
  const wire = messages.map(toWireMessage);
  if (Array.isArray(args[0])) {
    const next = [...args];
    next[0] = wire;
    return next;
  }
  if (args[0] && typeof args[0] === "object") {
    const next = [...args];
    next[0] = { ...(args[0] as Record<string, unknown>), messages: wire };
    return next;
  }
  throw new Error("wrapped function must receive messages array or { messages } object");
}

function coerceMessages(raw: unknown[]): ChatMessage[] {
  return raw.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("message must be an object");
    }
    const rec = item as Record<string, unknown>;
    const role = rec.role;
    const content = rec.content;
    if (!isMessageRole(role)) {
      throw new Error("message role must be system|user|assistant|tool");
    }
    if (typeof content !== "string") {
      throw new Error("message content must be a string");
    }
    return {
      role,
      content,
      name: typeof rec.name === "string" ? rec.name : undefined,
      metadata: Object.fromEntries(
        Object.entries(rec).filter(([k]) => k !== "role" && k !== "content" && k !== "name")
      )
    };
  });
}

function coerceAnthropicMessages(raw: unknown[]): ChatMessage[] {
  return raw.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("anthropic message must be an object");
    }
    const rec = item as Record<string, unknown>;
    const role = rec.role;
    if (!isMessageRole(role)) {
      throw new Error("message role must be system|user|assistant|tool");
    }
    return {
      role,
      content: contentToText(rec.content),
      metadata: Object.fromEntries(
        Object.entries(rec).filter(([k]) => k !== "role" && k !== "content" && k !== "name")
      )
    };
  });
}

function injectMemories(messages: ChatMessage[], memories: MemoryResponse[], template: string): ChatMessage[] {
  if (memories.length === 0) {
    return messages;
  }
  const memoryLines = memories.map((m) => `- ${m.content}`).join("\n");
  const injected = template.replace("{{memories}}", memoryLines);
  const out = [...messages];
  const idx = out.findIndex((m) => m.role === "system");
  if (idx >= 0) {
    out[idx] = {
      ...out[idx],
      content: `${injected}\n\n${out[idx].content}`
    };
    return out;
  }
  return [{ role: "system", content: injected }, ...out];
}

function injectSystem(existing: unknown, memories: MemoryResponse[], template: string): unknown {
  if (memories.length === 0) {
    return existing;
  }
  const memoryLines = memories.map((m) => `- ${m.content}`).join("\n");
  const injected = template.replace("{{memories}}", memoryLines);
  if (existing === undefined || existing === null) {
    return injected;
  }
  if (typeof existing === "string") {
    return `${injected}\n\n${existing}`;
  }
  if (Array.isArray(existing)) {
    return [{ type: "text", text: injected }, ...existing];
  }
  return `${injected}\n\n${String(existing)}`;
}

function queryFromMessages(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user" && messages[i].content.trim()) {
      return messages[i].content;
    }
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].content.trim()) {
      return messages[i].content;
    }
  }
  return "";
}

function validateStoreRequest(request: StoreMemoryRequest, tenantId: string): StoreMemoryRequest {
  const nextTenant = request.tenantId?.trim() || tenantId;
  if (!nextTenant) {
    throw new Error("store action tenantId is required");
  }
  if (!request.content?.trim()) {
    throw new Error("store action content is required");
  }
  return { ...request, tenantId: nextTenant };
}

function requireMemoryId(memoryId: string): string {
  const cleaned = memoryId.trim();
  if (!cleaned) {
    throw new Error("memoryId is required for delete/replace action");
  }
  return cleaned;
}

function isMessageRole(value: unknown): value is ChatMessage["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return String(content ?? "");
  }
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === "string" && part.trim()) {
      texts.push(part);
      continue;
    }
    if (part && typeof part === "object") {
      const rec = part as Record<string, unknown>;
      if (typeof rec.text === "string" && rec.text.trim()) {
        texts.push(rec.text);
      }
    }
  }
  return texts.join("\n");
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    role: message.role,
    content: message.content
  };
  if (message.name) {
    payload.name = message.name;
  }
  if (message.metadata) {
    Object.assign(payload, message.metadata);
  }
  return payload;
}
