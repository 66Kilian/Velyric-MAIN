import type {
  ProvisioningControl,
  ProvisioningControlReply,
  ProvisioningControlRequest,
} from '../../src/runtime/provisioning-control.js';
import type {
  RuntimeCommand,
  RuntimeCommandBus,
  RuntimeCommandResult,
} from '../../src/runtime/command-bus.js';
import type {
  ToolDispatcher,
  ToolDispatchRequest,
  ToolDispatchResult,
} from '../../src/runtime/tool-dispatch.js';

export class FakeToolDispatcher implements ToolDispatcher {
  readonly calls: ToolDispatchRequest[] = [];
  respond: (request: ToolDispatchRequest) => ToolDispatchResult = () => ({
    status: 'SUCCEEDED',
    result: { ok: true },
    httpStatus: 200,
    latencyMs: 3,
  });

  dispatch(request: ToolDispatchRequest): Promise<ToolDispatchResult> {
    this.calls.push(request);
    return Promise.resolve(this.respond(request));
  }
}

export class FakeCommandBus implements RuntimeCommandBus {
  readonly commands: { tenantId: string; callId: string; command: RuntimeCommand }[] = [];
  reply: RuntimeCommandResult = { accepted: true, state: 'ACCEPTED', errorCode: null };

  send(tenantId: string, callId: string, command: RuntimeCommand): Promise<RuntimeCommandResult> {
    this.commands.push({ tenantId, callId, command });
    return Promise.resolve(this.reply);
  }
}

export class FakeProvisioningControl implements ProvisioningControl {
  readonly requests: { tenantId: string; request: ProvisioningControlRequest }[] = [];
  respond: (request: ProvisioningControlRequest) => ProvisioningControlReply = () => ({
    ok: true,
    result: {},
  });

  send(tenantId: string, request: ProvisioningControlRequest): Promise<ProvisioningControlReply> {
    this.requests.push({ tenantId, request });
    return Promise.resolve(this.respond(request));
  }
}
