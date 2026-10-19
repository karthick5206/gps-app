import { VideoCodec, VideoErrorCode, VideoRecordingDto, VideoSessionState, VideoStreamType } from '@veetracer/shared';

/** API → gateway (pub/sub `vt:video:gw:<gatewayId>`); the gateway answers on `vt:video:replies` with the same reqId. */
export type VideoRequestBody =
  | { op: 'live'; channel: number; stream: VideoStreamType }
  | { op: 'playback'; channel: number; start: string; end: string }
  | { op: 'recordings'; channel: number; from: string; to: string }
  | { op: 'attributes' }
  | { op: 'leave'; sessionId: string }
  | { op: 'status'; sessionId: string };

export type VideoGatewayRequest = { reqId: string; uniqueId: string } & VideoRequestBody;

export interface VideoGatewayReply {
  reqId: string;
  ok: boolean;
  error?: { code: VideoErrorCode; message: string };
  session?: { sessionId: string; codec: VideoCodec; joined: boolean };
  status?: { state: VideoSessionState; codec: VideoCodec; viewers: number; frames: number } | null;
  recordings?: VideoRecordingDto[];
  attributes?: { maxVideoChannels: number; videoCodec: number } | null;
}
