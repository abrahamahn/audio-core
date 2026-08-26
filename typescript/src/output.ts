export type AudioVoiceOverflowPolicy = 'reject-new' | 'stop-oldest';

export interface AudioOutputChannelConfig {
  /** Linear channel gain from 0 to 1. Defaults to 1. */
  readonly level?: number;
  /** Maximum tracked streams/voices on this channel. */
  readonly maxVoices?: number;
  /** Behavior when maxVoices is reached. */
  readonly overflow?: AudioVoiceOverflowPolicy;
}

export type AudioOutputTopology<Channel extends string> =
  | {
      /** One replaceable output path, normally used for music or radio streaming. */
      readonly mode: 'single-channel';
      readonly channel: Channel;
      readonly config?: AudioOutputChannelConfig;
    }
  | {
      /** Named channels mixed into one master bus, suitable for games and interactive scenes. */
      readonly mode: 'multi-channel';
      readonly channels: Readonly<Record<Channel, AudioOutputChannelConfig>>;
    };
