import type { ParticipantIdentity } from "../types";

export function participantKey(identity: ParticipantIdentity): string {
  return identity.email;
}
