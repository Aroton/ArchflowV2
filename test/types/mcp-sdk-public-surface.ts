import {
  Server,
  type CallToolRequest,
  type CallToolResult,
  type CancelledNotification,
  type InitializeRequest,
  type JSONRPCMessage,
  type ListToolsRequest,
  type ListToolsResult,
  type MessageExtraInfo,
  type ServerContext,
  type Transport,
  type TransportSendOptions
} from "@modelcontextprotocol/server";

const transport = {
  start: async (): Promise<void> => undefined,
  send: async (_message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> => undefined,
  close: async (): Promise<void> => undefined,
  onmessage: <T extends JSONRPCMessage>(_message: T, _extra?: MessageExtraInfo): void => undefined,
  onclose: (): void => undefined,
  onerror: (_error: Error): void => undefined,
  setProtocolVersion: (_version: string): void => undefined,
  setSupportedProtocolVersions: (_versions: string[]): void => undefined
} satisfies Transport;

const server = new Server(
  { name: "phase-4-type-probe", version: "0.0.0" },
  { supportedProtocolVersions: ["2025-11-25"] }
);
server.oninitialized = (): void => undefined;
server.registerCapabilities({ tools: {} });

server.setRequestHandler("tools/list", async (
  request: ListToolsRequest,
  context: ServerContext
): Promise<ListToolsResult> => {
  const id: string | number = context.mcpReq.id;
  void request;
  void id;
  return { tools: [] };
});

server.setRequestHandler("tools/call", async (
  request: CallToolRequest,
  context: ServerContext
): Promise<CallToolResult> => {
  const signal: AbortSignal = context.mcpReq.signal;
  void request;
  void signal;
  return { content: [], structuredContent: {} };
});

declare const initializeRequest: InitializeRequest;
declare const listToolsRequest: ListToolsRequest;
declare const callToolRequest: CallToolRequest;
declare const cancelledNotification: CancelledNotification;

void transport;
void initializeRequest;
void listToolsRequest;
void callToolRequest;
void cancelledNotification;
