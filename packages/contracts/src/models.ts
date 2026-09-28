import type { ModelId, ModelTier } from './enums.js';

export const MODEL_TIER_DEFAULT_MODEL = {
  VOICE_FRONTEND: 'gpt-live-1',
  ROUTINE: 'gpt-5.6-luna',
  COMPLEX: 'gpt-5.6-terra',
  ESCALATION: 'gpt-5.6-sol',
  FRONTIER: 'gpt-6-astra',
  TRANSCRIPTION: 'gpt-live-transcribe',
  SPEECH_SYNTHESIS: 'gpt-4o-mini-tts',
} as const satisfies Readonly<Record<ModelTier, ModelId>>;

export const MODEL_TIERS_ENABLED_BY_DEFAULT: readonly ModelTier[] = Object.freeze([
  'VOICE_FRONTEND',
  'ROUTINE',
  'COMPLEX',
  'TRANSCRIPTION',
  'SPEECH_SYNTHESIS',
]);

export const REALTIME_VOICE_FALLBACK_MODELS: readonly ModelId[] = Object.freeze([
  'gpt-realtime-2.1-mini',
  'gpt-realtime-2.1',
]);
