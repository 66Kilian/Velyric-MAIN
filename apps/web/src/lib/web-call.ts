const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

export type WebCallState = 'idle' | 'connecting' | 'live' | 'ended';

export interface WebCallTranscriptItem {
  readonly speaker: 'CALLER' | 'AGENT';
  readonly content: string;
  readonly start_ms: number;
  readonly end_ms: number;
}

export interface WebCallHandle {
  readonly stop: () => void;
  readonly transcript: () => readonly WebCallTranscriptItem[];
}

export class WebCallError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'WebCallError';
    this.code = code;
  }
}

function eventType(payload: unknown): string {
  return typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { type?: unknown }).type === 'string'
    ? (payload as { type: string }).type
    : '';
}

function textField(payload: unknown, key: string): string | null {
  const value =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)[key]
      : undefined;
  return typeof value === 'string' ? value : null;
}

export async function connectWebCall(options: {
  readonly clientSecret: string;
  readonly onState: (state: WebCallState) => void;
  readonly onToolCall: (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
}): Promise<WebCallHandle> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    throw new WebCallError('microphone_denied');
  }
  const connection = new RTCPeerConnection();
  const audio = new Audio();
  audio.autoplay = true;
  const startedAt = Date.now();
  const transcript: WebCallTranscriptItem[] = [];
  let stopped = false;
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const track of stream.getTracks()) {
      track.stop();
    }
    audio.srcObject = null;
    connection.close();
    options.onState('ended');
  };
  const record = (speaker: WebCallTranscriptItem['speaker'], content: string) => {
    const text = content.trim();
    if (text === '') {
      return;
    }
    const at = Date.now() - startedAt;
    transcript.push({ speaker, content: text.slice(0, 4000), start_ms: at, end_ms: at });
  };
  connection.ontrack = (event) => {
    audio.srcObject = event.streams[0] ?? null;
    void audio.play().catch(() => undefined);
  };
  connection.onconnectionstatechange = () => {
    if (connection.connectionState === 'connected') {
      options.onState('live');
    } else if (
      connection.connectionState === 'failed' ||
      connection.connectionState === 'disconnected' ||
      connection.connectionState === 'closed'
    ) {
      stop();
    }
  };
  for (const track of stream.getAudioTracks()) {
    connection.addTrack(track, stream);
  }
  const events = connection.createDataChannel('oai-events');
  const send = (payload: Readonly<Record<string, unknown>>) => {
    if (events.readyState === 'open') {
      events.send(JSON.stringify(payload));
    }
  };
  events.onmessage = (message: MessageEvent<string>) => {
    let payload: unknown;
    try {
      payload = JSON.parse(message.data);
    } catch {
      return;
    }
    const type = eventType(payload);
    if (type === 'conversation.item.input_audio_transcription.completed') {
      record('CALLER', textField(payload, 'transcript') ?? '');
      return;
    }
    if (type === 'response.output_audio_transcript.done') {
      record('AGENT', textField(payload, 'transcript') ?? '');
      return;
    }
    if (type !== 'response.function_call_arguments.done') {
      return;
    }
    const callId = textField(payload, 'call_id');
    const name = textField(payload, 'name');
    if (callId === null || name === null) {
      return;
    }
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(textField(payload, 'arguments') ?? '{}');
      if (typeof parsed === 'object' && parsed !== null) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = {};
    }
    void options.onToolCall(name, args).then(
      (output) => {
        send({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
        });
        send({ type: 'response.create' });
      },
      () => {
        send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify({ status: 'FAILED', error_code: 'TOOL_UNAVAILABLE' }),
          },
        });
        send({ type: 'response.create' });
      },
    );
  };
  try {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    const response = await fetch(REALTIME_CALLS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.clientSecret}`,
        'content-type': 'application/sdp',
      },
      body: offer.sdp ?? '',
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new WebCallError(
        detail.includes('invalid_model')
          ? 'realtime_invalid_model'
          : `realtime_http_${String(response.status)}`,
      );
    }
    await connection.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  } catch (error) {
    stop();
    throw error instanceof WebCallError ? error : new WebCallError('realtime_unreachable');
  }
  return { stop, transcript: () => transcript };
}
