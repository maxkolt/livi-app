import { Schema, model, models, type Types } from 'mongoose';

export type CallLifecycleState =
  | 'invited'
  | 'incoming_shown'
  | 'accepted'
  | 'declined'
  | 'canceled'
  | 'timeout'
  | 'ended';

export type CallTimelineEventName =
  | 'invite_sent'
  | 'provider_delivered'
  | 'push_sent'
  | 'push_retry'
  | 'push_escalated'
  | 'incoming_shown'
  | 'accepted'
  | 'declined'
  | 'canceled'
  | 'timeout'
  | 'end_reason';

export interface ICallTimelineEvent {
  name: CallTimelineEventName;
  atMs: number;
  source?: string;
  meta?: Record<string, unknown>;
}

export interface ICallTimeline {
  _id: Types.ObjectId;
  callId: string;
  callerId: string;
  calleeId: string;
  state: CallLifecycleState;
  closeReason?: 'accepted' | 'declined' | 'canceled' | 'timeout' | 'ended';
  providerPrimary: boolean;
  pushFallbackEnabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  incomingShownAtMs?: number;
  events: ICallTimelineEvent[];
}

const CallTimelineEventSchema = new Schema<ICallTimelineEvent>(
  {
    name: {
      type: String,
      enum: [
        'invite_sent',
        'provider_delivered',
        'push_sent',
        'push_retry',
        'push_escalated',
        'incoming_shown',
        'accepted',
        'declined',
        'canceled',
        'timeout',
        'end_reason',
      ],
      required: true,
    },
    atMs: { type: Number, required: true },
    source: { type: String, default: '' },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const CallTimelineSchema = new Schema<ICallTimeline>(
  {
    callId: { type: String, required: true, unique: true, index: true },
    callerId: { type: String, required: true, index: true },
    calleeId: { type: String, required: true, index: true },
    state: {
      type: String,
      enum: ['invited', 'incoming_shown', 'accepted', 'declined', 'canceled', 'timeout', 'ended'],
      required: true,
      default: 'invited',
      index: true,
    },
    closeReason: {
      type: String,
      enum: ['accepted', 'declined', 'canceled', 'timeout', 'ended'],
      default: undefined,
      index: true,
    },
    providerPrimary: { type: Boolean, default: false },
    pushFallbackEnabled: { type: Boolean, default: true },
    createdAtMs: { type: Number, required: true, index: true },
    updatedAtMs: { type: Number, required: true, index: true },
    incomingShownAtMs: { type: Number, default: undefined, index: true },
    events: { type: [CallTimelineEventSchema], default: [] },
  },
  {
    collection: 'call_timelines',
    timestamps: true,
  }
);

CallTimelineSchema.index({ createdAtMs: -1 });
CallTimelineSchema.index({ state: 1, createdAtMs: -1 });
CallTimelineSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export default (models.CallTimeline as any) || model<ICallTimeline>('CallTimeline', CallTimelineSchema);
